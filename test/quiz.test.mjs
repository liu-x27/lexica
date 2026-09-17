/**
 * 出题引擎与音标解析的回归测试。
 *
 * 锁定的坑：
 *   · 干扰项里不能出现正确答案的同义词，否则一道题有两个正确选项
 *   · 例句填空必须真的把目标词挖掉，且不能在选项外泄露答案
 *   · ECDICT 的逗号大多是次重音标记（,pælis'tiniәn），不能当又读分隔符切开
 *   · 以 - 结尾的音标是「其余同上」的省略写法，单独展示没有意义
 */
import { test, describe, before, after, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(ROOT, 'data', 'dict.db');

const { DictDB, parsePhonetic } = require(path.join(ROOT, 'src', 'main', 'dict-db.js'));
const { Quiz, checkSpelling, isCustomScope } = require(path.join(ROOT, 'src', 'main', 'quiz.js'));

/* ========================================================================== */
/*  拼写判分（不需要词库）                                                     */
/* ========================================================================== */

describe('checkSpelling', () => {
  test('完全一致算对', () => {
    assert.equal(checkSpelling('meticulous', 'meticulous').correct, true);
  });

  test('大小写与首尾空格不算错', () => {
    for (const input of ['  Meticulous ', 'METICULOUS', 'meticulous  ']) {
      assert.equal(checkSpelling(input, 'meticulous').correct, true, `「${input}」应判对`);
    }
  });

  test('连字符与空格的写法差异不算错', () => {
    assert.equal(checkSpelling('high speed', 'high-speed').correct, true);
    assert.equal(checkSpelling("dont", "don't").correct, false, '少了撇号还是拼错');
  });

  test('差一个字母判错，但要标记为「接近」', () => {
    const r = checkSpelling('meticulus', 'meticulous');
    assert.equal(r.correct, false);
    assert.equal(r.near, true, '应提示只差一点');
    assert.equal(r.distance, 1);
  });

  test('完全不沾边不标记为接近', () => {
    const r = checkSpelling('banana', 'meticulous');
    assert.equal(r.correct, false);
    assert.equal(r.near, false);
  });

  test('空输入判错且不崩', () => {
    const r = checkSpelling('', 'run');
    assert.equal(r.correct, false);
    assert.equal(r.near, false);
  });
});

describe('isCustomScope', () => {
  test('识别自定义词表范围', () => {
    assert.equal(isCustomScope('list:12'), true);
    assert.equal(isCustomScope('toefl'), false);
    assert.equal(isCustomScope(undefined), false);
  });
});

/* ========================================================================== */
/*  音标解析（不需要词库）                                                     */
/* ========================================================================== */

describe('parsePhonetic', () => {
  test('普通音标原样返回', () => {
    const p = parsePhonetic('rʌn');
    assert.equal(p.main, 'rʌn');
    assert.equal(p.us, null);
    assert.deepEqual(p.alts, []);
  });

  test('(?@) 标记的那段识别为美式', () => {
    const p = parsePhonetic("'mjzlim; (?@) 'mʌzlem");
    assert.equal(p.main, "'mjzlim");
    assert.equal(p.us, "'mʌzlem");
  });

  test('开头的逗号是次重音标记，不能当分隔符切开', () => {
    const p = parsePhonetic(",pælis'tiniәn");
    assert.equal(p.main, ",pælis'tiniәn");
    assert.deepEqual(p.alts, [], '不该被切成两个音标');
  });

  test('逗号加空格才算又读', () => {
    const p = parsePhonetic("di'rektli, dai'rektli");
    assert.equal(p.main, "di'rektli");
    assert.deepEqual(p.alts, ["dai'rektli"]);
  });

  test('以 - 结尾的省略形式被丢弃', () => {
    const p = parsePhonetic("'lɔŋtaim;'lɔ:ŋ-");
    assert.equal(p.main, "'lɔŋtaim");
    assert.deepEqual(p.alts, [], '残缺的缩略形式不该单独展示');
  });

  test('美式段是省略形式时不显示美式', () => {
    const p = parsePhonetic("simәl'teiniәsly; (?@) saim-");
    assert.equal(p.main, "simәl'teiniәsly");
    assert.equal(p.us, null);
  });

  test('空值安全', () => {
    assert.equal(parsePhonetic(null), null);
    assert.equal(parsePhonetic(''), null);
    assert.equal(parsePhonetic('   '), null);
  });
});

/* ========================================================================== */
/*  出题引擎（需要词库）                                                       */
/* ========================================================================== */

const missing = !fs.existsSync(DB_FILE);
const skip = missing ? `词库不存在（${DB_FILE}），先运行 npm run data` : false;

describe('Quiz', { skip }, () => {
  let dict;
  let quiz;

  before(() => {
    dict = new DictDB(DB_FILE);
    assert.ok(dict.open(), `词库打开失败：${dict.error}`);
    quiz = new Quiz(dict);
  });

  after(() => dict?.close());

  /** 一道题的通用结构校验 */
  function assertWellFormed(q, label) {
    // 拼写题是输入型，没有选项，校验的是答案与脚手架
    if (q.input) {
      assert.ok(!q.options, `${label}: 输入型题目不该带选项`);
      assert.ok(q.solution && /^[A-Za-z][A-Za-z'-]*$/.test(q.solution), `${label}: 答案不合法 → ${q.solution}`);
      assert.equal(q.hint.first, q.solution[0], `${label}: 首字母提示与答案对不上`);
      assert.equal(q.hint.length, q.solution.length, `${label}: 长度提示与答案对不上`);
      return;
    }

    // 辨析题的易混词有时凑不满 3 个干扰项，允许 3 选项
    const min = q.kind === 'confuse' ? 3 : 4;
    assert.ok(
      q.options.length >= min && q.options.length <= 4,
      `${label}: 选项数 ${q.options.length} 不合法`,
    );
    assert.ok(q.answer >= 0 && q.answer < q.options.length, `${label}: 答案下标越界`);
    const correct = q.options.filter((o) => o.correct);
    assert.equal(correct.length, 1, `${label}: 应该只有一个正确选项`);
    assert.equal(q.options[q.answer].correct, true, `${label}: answer 下标与 correct 标记不一致`);

    const texts = q.options.map((o) => o.text.trim());
    assert.equal(new Set(texts).size, q.options.length, `${label}: 选项文本重复 → ${texts.join(' | ')}`);
    for (const t of texts) assert.ok(t.length > 0, `${label}: 有空选项`);
  }

  test('范围列表包含全部考纲且数量合理', () => {
    const scopes = quiz.scopes();
    const byName = new Map(scopes.map((s) => [s.scope, s]));
    for (const s of ['zk', 'gk', 'cet4', 'cet6', 'ky', 'ielts', 'toefl', 'gre']) {
      assert.ok(byName.has(s), `缺少范围 ${s}`);
      assert.ok(byName.get(s).quizzable > 1000, `${s} 可出题词量偏少：${byName.get(s).quizzable}`);
    }
    assert.ok(byName.get('gre').quizzable > byName.get('cet4').quizzable, 'GRE 词量应多于四级');
  });

  test('拼写题带首字母与长度脚手架，且只对纯字母单词出', () => {
    const batch = quiz.batch('gre', 12, { kinds: ['spell'] });
    assert.ok(batch.length >= 8, `拼写题只出到 ${batch.length}/12`);
    for (const q of batch) {
      assert.equal(q.input, true);
      assert.ok(!q.word.includes(' '), `词组不该出拼写题：${q.word}`);
      assertWellFormed(q, 'spell');
      // 题面是中文释义，不能泄露答案
      assert.ok(!q.prompt.toLowerCase().includes(q.solution.toLowerCase()), `题面泄露答案：${q.prompt}`);
    }
  });

  test('听音拼写不在题面显示拼写', () => {
    const batch = quiz.batch('cet6', 8, { kinds: ['spellAudio'] });
    assert.ok(batch.length >= 4, `听音拼写只出到 ${batch.length}/8`);
    for (const q of batch) {
      assert.equal(q.prompt, '', '听音题不该有文字题面');
      assert.equal(q.speak, q.word, '要朗读的就是目标词');
      assertWellFormed(q, 'spellAudio');
    }
  });

  test('辨析题的干扰项确实是拼写相近的词', () => {
    const batch = quiz.batch('cet6', 10, { kinds: ['confuse'] });
    assert.ok(batch.length >= 5, `辨析题只出到 ${batch.length}/10`);
    for (const q of batch) {
      assertWellFormed(q, 'confuse');
      const answer = q.options[q.answer].text.toLowerCase();
      for (const o of q.options) {
        if (o.correct) continue;
        // 干扰项应该和答案长得像：首字母相同或长度接近
        const w = o.text.toLowerCase();
        assert.ok(
          w[0] === answer[0] || Math.abs(w.length - answer.length) <= 2,
          `${answer} 的干扰项 ${w} 看起来并不相近`,
        );
      }
      assert.ok(q.reveal?.length === q.options.length, '辨析题答完要能摊开所有选项的释义');
    }
  });

  test('五种选择题型都能稳定出满一批', () => {
    for (const kind of ['en2zh', 'zh2en', 'cloze', 'syn', 'audio']) {
      const batch = quiz.batch('gre', 12, { kinds: [kind] });
      assert.ok(batch.length >= 10, `${kind} 只出到 ${batch.length}/12 题`);
      for (const q of batch) {
        assert.equal(q.kind, kind);
        assertWellFormed(q, kind);
      }
    }
  });

  test('例句填空真的挖掉了目标词', () => {
    const batch = quiz.batch('cet6', 10, { kinds: ['cloze'] });
    assert.ok(batch.length > 0);
    for (const q of batch) {
      assert.ok(q.prompt.includes('______'), `没有挖空：${q.prompt}`);
      const lower = q.prompt.toLowerCase();
      assert.ok(
        !new RegExp(`\\b${q.word.toLowerCase()}\\b`).test(lower),
        `题面里泄露了答案 ${q.word}：${q.prompt}`,
      );
      assert.ok(q.prompt.split(/\s+/).length >= 5, `句子太短给不了线索：${q.prompt}`);
    }
  });

  test('听音题不显示拼写，只给朗读文本', () => {
    const batch = quiz.batch('toefl', 6, { kinds: ['audio'] });
    assert.ok(batch.length > 0);
    for (const q of batch) {
      assert.equal(q.prompt, '', '听音题不该有可见题面');
      assert.equal(q.speak, q.word);
    }
  });

  test('同义词题的答案不等于题目本身', () => {
    const batch = quiz.batch('gre', 10, { kinds: ['syn'] });
    assert.ok(batch.length > 0);
    for (const q of batch) {
      const ans = q.options[q.answer].text.toLowerCase();
      assert.notEqual(ans, q.word.toLowerCase(), '答案不能是题目本身');
      assert.ok(/^[a-z][a-z'-]*$/i.test(ans), `同义词选项应是单个词：${ans}`);
    }
  });

  test('混合出题时每题结构都合法', () => {
    const batch = quiz.batch('ielts', 25);
    assert.ok(batch.length >= 20, `只出到 ${batch.length}/25 题`);
    const words = new Set();
    for (const q of batch) {
      assertWellFormed(q, q.kind);
      assert.ok(!words.has(q.word), `同一批里出现重复词 ${q.word}`);
      words.add(q.word);
    }
  });

  test('水平检测按高/中/低频三层等量抽样', () => {
    const { questions, bands } = quiz.assessmentBatch('toefl', 30);
    assert.equal(bands.length, 3);
    assert.deepEqual(bands.map((b) => b.name), ['高频', '中频', '低频']);
    for (const b of bands) assert.ok(b.asked > 0, `${b.name} 段没抽到题`);

    const counts = new Map();
    for (const q of questions) counts.set(q.band, (counts.get(q.band) || 0) + 1);
    assert.equal(counts.size, 3, '三层都应有题目');
    for (const q of questions) assertWellFormed(q, `assess/${q.band}`);
  });

  test('掌握率与置信区间计算正确', () => {
    const bands = [{ name: '高频' }, { name: '中频' }, { name: '低频' }];
    const results = [
      ...Array(8).fill({ band: '高频', correct: true }),
      ...Array(2).fill({ band: '高频', correct: false }),
      ...Array(5).fill({ band: '中频', correct: true }),
      ...Array(5).fill({ band: '中频', correct: false }),
      ...Array(10).fill({ band: '低频', correct: false }),
    ];
    const s = Quiz.summarize(results, bands);
    assert.equal(s.total, 30);
    assert.equal(s.right, 13);
    assert.ok(Math.abs(s.rate - 13 / 30) < 1e-9);
    assert.ok(s.margin > 0 && s.margin < 0.5, `置信区间半宽异常：${s.margin}`);

    const byName = new Map(s.bands.map((b) => [b.name, b]));
    assert.equal(byName.get('高频').rate, 0.8);
    assert.equal(byName.get('中频').rate, 0.5);
    assert.equal(byName.get('低频').rate, 0);
  });

  test('题量小的时候置信区间应该明显更宽', () => {
    const mk = (n, hit) =>
      Array.from({ length: n }, (_, i) => ({ band: '高频', correct: i < hit }));
    const small = Quiz.summarize(mk(10, 7), [{ name: '高频' }]);
    const big = Quiz.summarize(mk(100, 70), [{ name: '高频' }]);
    assert.ok(Math.abs(small.rate - big.rate) < 1e-9, '两者正确率应相同');
    assert.ok(small.margin > big.margin * 2.5, '10 题的区间应远宽于 100 题');
  });

  test('学习浏览返回完整词条', () => {
    const list = quiz.studyBatch('cet4', 8);
    assert.equal(list.length, 8);
    for (const e of list) {
      assert.ok(e.word, '缺少词头');
      assert.ok(e.translation.length > 0, `${e.word} 缺少中文释义`);
      assert.ok(Array.isArray(e.senses), `${e.word} 缺少义项结构`);
    }
  });

  test('出题速度在可接受范围', () => {
    const t0 = performance.now();
    const batch = quiz.batch('gre', 20);
    const ms = performance.now() - t0;
    assert.ok(batch.length >= 15);
    assert.ok(ms < 3000, `出 20 题耗时 ${ms.toFixed(0)}ms，过慢`);
  });
});
