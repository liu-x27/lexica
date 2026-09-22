/**
 * 查询层回归测试。
 *
 *   npm test
 *
 * 这些用例锁定的都是开发过程中实际踩过的坑，不是凭想象写的：
 *   · ECDICT 把常见错拼（recieve / wierd）也收成了正式词条
 *   · ECDICT 给纯变形（ran / mice / happiest）单独立条，内容却只有一句“xx的过去式”
 *   · running / better 本身是完整词条，不该被转走
 *   · 中文回车查词一度走到「未找到」，因为反查只做在了搜索建议里
 *   · 检索结果的次级排序一度用词长，把生僻古语短词顶到了真实专业词前面
 *   · pos 字段用的是单字母码（j=形容词），和释义行的 n./adj. 不是一套
 *
 * 词库不存在时整个套件跳过，不让 CI 因为缺数据而失败。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(ROOT, 'data', 'dict.db');
const { DictDB, isSentence } = require(path.join(ROOT, 'src', 'main', 'dict-db.js'));

/* splitSentences 原先在 translate.js 里、顶上 require('electron')，测试只能把源码按文本
   切出来再 new Function——文件结构一变就断。现在它有了自己的纯模块，直接 require。 */
const { splitSentences } = require(path.join(ROOT, 'src', 'main', 'sentence-split.js'));

const missing = !fs.existsSync(DB_FILE);
const skip = missing ? `词库不存在（${DB_FILE}），先运行 npm run data` : false;

describe('DictDB', { skip }, () => {
  /** @type {import('../src/main/dict-db.js').DictDB} */
  let db;

  before(() => {
    db = new DictDB(DB_FILE);
    assert.ok(db.open(), `词库打开失败：${db.error}`);
  });

  after(() => db?.close());

  /* ------------------------------------------------------------------ */

  describe('长句与术语抽取', () => {
    test('isSentence 分得清词条、词组与句子', () => {
      for (const t of ['run', 'gradient descent', 'in-context learning', 'machine learning model', '光合作用']) {
        assert.equal(isSentence(t), false, `不该判成句子：${t}`);
      }
      for (const t of [
        'We propose a simple yet effective method.',
        'The mitochondria generate adenosine triphosphate through oxidative phosphorylation.',
        'Cite the paper, please.',
      ]) {
        assert.equal(isSentence(t), true, `该判成句子：${t}`);
      }
    });

    /* 这条是本次改动的核心：以前长句一路落到 status:'miss'，
       本地的翻译模型压根没机会被用上（decompose 超过 8 个词直接返回 null）。 */
    test('长句走 sentence 分支而不是落到没找到', () => {
      const r = db.lookup('We propose a simple yet effective method for improving sample efficiency.');
      assert.equal(r.status, 'sentence');
      assert.ok(Array.isArray(r.terms));
    });

    test('已收录的词组仍然按词条查，不被句子分支抢走', () => {
      assert.equal(db.lookup('gradient descent').status, 'ok');
      assert.equal(db.lookup('run').status, 'ok');
    });

    test('句子分支不丢拆词与检索结果', () => {
      // 六个词的长词组，句子与词组的界限本来就模糊，两边信息都要给
      const r = db.lookup('natural language processing toolkit for python');
      assert.equal(r.status, 'sentence');
      assert.ok(r.decomposed, '够短时应该附上拆词结果');
      assert.ok(Array.isArray(r.items), '应该附上全文检索结果');
    });

    test('termsIn 抽出多词术语，且长术语优先', () => {
      const terms = db.termsIn('The mitochondria generate adenosine triphosphate through oxidative phosphorylation.');
      const got = terms.map((t) => t.surface.toLowerCase());
      assert.ok(got.includes('adenosine triphosphate'), `缺少多词术语：${got.join(' / ')}`);
      assert.ok(got.includes('oxidative phosphorylation'), `缺少多词术语：${got.join(' / ')}`);
      // 长术语命中后，其中的单词不该再单独出现
      assert.ok(!got.includes('phosphorylation'), '长术语里的单词不该重复列出');
      // 顺序跟着原文走，读的时候能对着看
      assert.deepEqual([...terms].sort((a, b) => a.at - b.at).map((t) => t.at), terms.map((t) => t.at));
    });

    test('termsIn 过滤功能词组合与常用词的变形', () => {
      const terms = db.termsIn('We propose a simple yet effective method for improving sample efficiency.');
      const got = terms.map((t) => t.surface.toLowerCase());
      // "a form of" / "form of" 这类 ECDICT 收录的功能词组合会把列表淹掉
      assert.ok(!got.some((g) => /^(a form of|form of|is a|of the)$/.test(g)), `混进了功能词组合：${got.join(' / ')}`);
      // improving 自己有词条（「有启发的」），但原形 improve 是常用词，应被滤掉
      assert.ok(!got.includes('improving'), `常用词的变形不该出现：${got.join(' / ')}`);
    });

    test('termsIn 给出的译名可信（词库数据，不是模型推测）', () => {
      const byWord = new Map(
        db.termsIn('Photosynthesis converts light energy into chemical energy stored in glucose.')
          .map((t) => [t.surface.toLowerCase(), t.brief]),
      );
      assert.match(byWord.get('photosynthesis') || '', /光合作用/);
      assert.match(byWord.get('glucose') || '', /葡萄糖/);
    });
  });

  describe('整段切句', () => {
    test('缩写后面的点不当句子边界', () => {
      assert.equal(splitSentences('As shown by Smith et al. 2021, it converges. We extend it.').length, 2);
      assert.equal(splitSentences('Models (e.g. BERT) use masking, i.e. tokens are hidden. This helps.').length, 2);
      assert.equal(splitSentences('This builds on J. Doe and A. Smith. They did it first.').length, 2);
    });

    test('以数字结尾的整句照样断开', () => {
      // 数字守卫只该拦编号列表，不该把「…到 0.91。」和下一句黏在一起
      assert.equal(splitSentences('Accuracy improved to 0.91. That is a large gain.').length, 2);
      assert.equal(splitSentences('Results are in Tab. 2. Both confirm our claim.').length, 2);
    });

    test('编号列表不被切碎', () => {
      assert.deepEqual(splitSentences('1. First item. 2. Second item.'), ['1. First item.', '2. Second item.']);
    });

    test('换行是硬边界', () => {
      assert.deepEqual(splitSentences('First point\nSecond point\n\nThird'), ['First point', 'Second point', 'Third']);
    });

    test('超长单句被继续切开（模型输入上限 512 token）', () => {
      const parts = splitSentences(`The ${'very '.repeat(120)}long sentence.`);
      assert.ok(parts.length > 1, '应该被切成多段');
      for (const p of parts) assert.ok(p.length <= 340, `切完还是太长：${p.length}`);
    });
  });

  describe('词库完整性', () => {
    test('各表数量达到预期量级', () => {
      const m = db.meta;
      assert.ok(Number(m.words) > 3_000_000, `词条数偏少：${m.words}`);
      assert.ok(Number(m.words_single) > 1_000_000, `单词数偏少：${m.words_single}`);
      assert.ok(Number(m.senses) > 200_000, `WordNet 义项偏少：${m.senses}`);
      assert.ok(Number(m.forms) > 400_000, `词形映射偏少：${m.forms}`);
      assert.ok(Number(m.sentences) > 200_000, `例句偏少：${m.sentences}`);
      assert.ok(Number(m.sentences_bilingual) > 25_000, `中英对照例句偏少：${m.sentences_bilingual}`);
      assert.ok(Number(m.etym) > 40_000, `GCIDE 词源偏少：${m.etym}`);
      assert.ok(Number(m.quotes) > 30_000, `GCIDE 引文偏少：${m.quotes}`);
    });

    test('考纲标签词量齐全', () => {
      const m = db.meta;
      for (const [k, min] of [['cet4', 3000], ['cet6', 5000], ['toefl', 6000], ['ielts', 4000], ['gre', 7000]]) {
        assert.ok(Number(m[k]) > min, `${k} 词量偏少：${m[k]}`);
      }
    });
  });

  /* ------------------------------------------------------------------ */

  describe('精确查词', () => {
    test('run 的各字段完整', () => {
      const res = db.lookup('run');
      assert.equal(res.status, 'ok');
      const e = res.entry;

      assert.equal(e.word, 'run');
      assert.equal(e.phonetic, 'rʌn');
      assert.equal(e.collins, 5);
      assert.equal(e.oxford, true);
      assert.ok(e.rank < 500, `词频排名应该很靠前，实际 ${e.rank}`);

      const tags = e.tags.map((t) => t.code);
      assert.deepEqual(tags.sort(), ['gk', 'zk']);

      // 复数/过去式/过去分词/现在分词/三单
      assert.equal(e.forms.length, 5);
      const past = e.forms.find((f) => f.code === 'p');
      assert.equal(past.label, '过去式');
      assert.deepEqual(past.words, ['ran']);

      // 义项按词性分组，名词与动词都有
      const posSet = new Set(e.senses.map((g) => g.pos));
      assert.ok(posSet.has('n') && posSet.has('v'), `词性分组不全：${[...posSet]}`);
      assert.ok(e.senses.reduce((n, g) => n + g.senses.length, 0) > 40);

      assert.ok(e.etym, 'run 应该有 GCIDE 词源');
      assert.ok(e.quotes.length > 0, 'run 应该有古典引文');
    });

    test('弱条目标记：权威词不应被判为 weak', () => {
      for (const w of ['receive', 'run', 'ephemeral', 'meticulous', 'separate']) {
        const res = db.lookup(w);
        assert.equal(res.status, 'ok', `${w} 应能查到`);
        assert.equal(res.weak, false, `${w} 不该被判为弱条目`);
        assert.deepEqual(res.corrections, [], `${w} 不该给出纠正建议`);
      }
    });
  });

  /* ------------------------------------------------------------------ */

  describe('词形还原', () => {
    test('纯变形条目转向原形并说明形态', () => {
      const cases = [
        ['ran', 'run', '过去式'],
        ['went', 'go', '过去式'],
        ['mice', 'mouse', '复数'],
        ['children', 'child', '复数'],
        ['happiest', 'happy', '最高级'],
      ];
      for (const [input, lemma, label] of cases) {
        const res = db.lookup(input);
        assert.equal(res.status, 'ok', `${input} 应能查到`);
        assert.equal(res.entry.word, lemma, `${input} 应转向 ${lemma}`);
        assert.ok(res.via, `${input} 应带转向说明`);
        assert.equal(res.via.label, label, `${input} 的形态标签应为 ${label}`);
      }
    });

    test('本身内容完整的变形不转向，只挂原形链接', () => {
      for (const [input, lemma] of [['running', 'run'], ['better', 'good'], ['worse', 'bad']]) {
        const res = db.lookup(input);
        assert.equal(res.status, 'ok');
        assert.equal(res.entry.word, input, `${input} 不该被转走`);
        assert.equal(res.via, null, `${input} 不该有转向说明`);
        assert.ok(res.entry.lemmaOf, `${input} 应该挂原形链接`);
        assert.equal(res.entry.lemmaOf.word, lemma);
      }
    });
  });

  /* ------------------------------------------------------------------ */

  describe('拼写纠错', () => {
    test('ECDICT 收录的常见错拼会给出正确的纠正建议', () => {
      const cases = [
        ['recieve', 'receive'],
        ['seperate', 'separate'],
        ['definately', 'definitely'],
        ['occurence', 'occurrence'],
        ['wierd', 'weird'],
        ['begining', 'beginning'],
        ['neccessary', 'necessary'],
      ];
      for (const [typo, want] of cases) {
        const res = db.lookup(typo);
        assert.equal(res.weak, true, `${typo} 应被判为弱条目`);
        assert.ok(res.corrections.length > 0, `${typo} 应给出纠正建议`);
        assert.equal(res.corrections[0].word, want, `${typo} 的首选纠正应为 ${want}`);
      }
    });

    test('查不到的词给出编辑距离相近的候选', () => {
      const res = db.lookup('ephemerol');
      assert.equal(res.status, 'miss');
      const words = res.suggestions.map((s) => s.row.word);
      assert.ok(words.includes('ephemeral'), `候选里应有 ephemeral，实际 ${words.join(',')}`);
      assert.equal(res.suggestions[0].distance, 1);
    });

    test('纠正候选里不会出现错拼本身', () => {
      // fuzzy 候选池只收权威词条，否则会把 recieve 推荐给别人
      const res = db.lookup('recieved');
      const all = [...(res.corrections || []), ...(res.suggestions || [])];
      for (const c of all) {
        const w = c.word || c.row?.word;
        assert.notEqual(w, 'recieve', '不该把错拼当成纠正结果');
      }
    });
  });

  /* ------------------------------------------------------------------ */

  describe('中文反查与释义检索', () => {
    test('中文输入返回结果列表而不是「未找到」', () => {
      const res = db.lookup('光合作用');
      assert.equal(res.status, 'list');
      assert.equal(res.kind, 'zh');
      assert.ok(res.items.length > 0);
      assert.equal(res.items[0].word, 'photosynthesis');
    });

    test('检索结果排序不会被生僻短词顶上来', () => {
      // 次级排序一度用词长，导致 oyntuose / enyntysch 排在 epipelagic 前面
      const top = db.search('光合作用', 6).items.map((i) => i.word);
      for (const junk of ['oyntuose', 'enyntysch']) {
        assert.ok(!top.includes(junk), `前 6 名不该出现 ${junk}：${top.join(', ')}`);
      }
      assert.equal(top[0], 'photosynthesis');
    });

    test('多词输入走英文释义全文检索', () => {
      const res = db.lookup('lasting a very short time');
      assert.equal(res.status, 'list');
      assert.equal(res.kind, 'en');
      assert.ok(res.items.some((i) => i.word === 'ephemeral'), '应能检索到 ephemeral');
    });

    test('任意长度中文都能反查（不受 trigram 三字下限影响）', () => {
      for (const zh of ['跑', '奔跑', '短暂的']) {
        const r = db.search(zh, 5);
        assert.ok(r.items.length > 0, `「${zh}」应有结果`);
      }
    });

    test('短语也在中文反查索引里', () => {
      // 索引条件曾写成 (is_single=1 OR rank<300000)，短语全都没有词频记录，
      // 结果 204 万条带中文释义的短语一条都没进索引
      const total = db.db.prepare('SELECT COUNT(*) c FROM fts_zh').get().c;
      const phrases = db.db
        .prepare('SELECT COUNT(*) c FROM words WHERE translation IS NOT NULL AND is_single = 0')
        .get().c;
      assert.ok(phrases > 2_000_000, `短语数偏少：${phrases}`);
      assert.ok(total >= phrases, `中文索引没有覆盖短语：索引 ${total} 条，短语 ${phrases} 条`);
    });

    test('查「高铁」能找到高速铁路，而不是高铁血红蛋白', () => {
      const words = db.search('高铁', 6).items.map((i) => i.word.toLowerCase());
      assert.ok(
        words.some((w) => /rail|train/.test(w)),
        `前 6 名里应有 rail/train 相关词，实际：${words.join(', ')}`,
      );
      // 化学义的「高铁血红蛋白」系列不该占据前列
      for (const junk of ['siderocyte', 'sideroblast', 'hematin']) {
        assert.ok(!words.includes(junk), `${junk} 是「高铁血红蛋白」义，不该排在前面`);
      }
    });

    test('中文反查按义项片段的覆盖率排序', () => {
      // 释义整段就是查询词的，应该排在查询词只占一小部分的前面
      const top = db.search('地铁', 4).items.map((i) => i.word.toLowerCase());
      assert.ok(
        ['underground', 'subway', 'metro', 'tube'].some((w) => top.includes(w)),
        `前几名应是地铁本义，实际：${top.join(', ')}`,
      );
    });

    test('中文反查能查到短语', () => {
      const hits = db.search('子弹头列车', 6).items.map((i) => i.word.toLowerCase());
      assert.ok(hits.includes('bullet train'), `应能查到 bullet train，实际：${hits.join(', ')}`);
    });

    test('单字中文反查也要快（不能退化成全量 bm25 排序）', () => {
      /* 「的」在 fts_zh 里命中 42 万条，纯靠 bm25 排序要 460ms；
         精确/前缀片段走 zh_seg 索引后应该是几十毫秒级。

         取两次里的较快值：这条测的是查询计划，而 dict.db 有 1.2GB，
         首次访问要从磁盘换页进来，单次计时会把 I/O 算进去——
         之前就因此在整批测试的第一次运行里稳定偶发失败（三次里挂一次）。
         计划真退化了的话是 10 倍差距，预热一次完全掩盖不掉。 */
      for (const ch of ['的', '人', '水', '大']) {
        let best = Infinity;
        let items = 0;
        for (let i = 0; i < 2; i++) {
          const t0 = performance.now();
          items = db.search(ch, 10).items.length;
          best = Math.min(best, performance.now() - t0);
        }
        assert.ok(items > 0, `「${ch}」应有结果`);
        assert.ok(best < 400, `「${ch}」耗时 ${best.toFixed(0)}ms，说明走了全量排序`);
      }
    });
  });

  /* ------------------------------------------------------------------ */

  describe('搜索建议', () => {
    test('权威词优先，垃圾缩写不置顶', () => {
      // meti 是个无词频无标签的垃圾条目，不该压在 meticulous 上面
      const res = db.suggest('meti', 6);
      const kinds = res.groups.map((g) => g.kind);
      assert.ok(!kinds.includes('exact'), 'meti 是弱条目，不该作为精确匹配置顶');
      const prefix = res.groups.find((g) => g.kind === 'prefix');
      assert.equal(prefix.items[0].word, 'meticulous');
    });

    test('权威词的精确匹配会置顶', () => {
      const res = db.suggest('run', 6);
      assert.equal(res.groups[0].kind, 'exact');
      assert.equal(res.groups[0].items[0].word, 'run');
    });

    test('中文输入走反查分组', () => {
      const res = db.suggest('词典', 6);
      assert.equal(res.groups[0].kind, 'zh');
      assert.equal(res.groups[0].items[0].word, 'dictionary');
    });
  });

  /* ------------------------------------------------------------------ */

  describe('字段解析', () => {
    test('pos 单字母码正确映射（j=形容词，不是 adj）', () => {
      const e = db.lookup('ephemeral').entry;
      assert.equal(e.posRatio.length, 1);
      assert.equal(e.posRatio[0].pos, 'adj');
      assert.equal(e.posRatio[0].posName, '形容词');
      assert.equal(e.posRatio[0].pct, 100);
    });

    test('词性占比按比例降序，run 以动词为主', () => {
      const e = db.lookup('run').entry;
      assert.equal(e.posRatio[0].posName, '动词');
      assert.ok(e.posRatio[0].pct > e.posRatio[1].pct);
    });

    test('[网络] 机翻释义被降权，有正经释义时不出现', () => {
      const e = db.lookup('receive').entry;
      assert.ok(e.translation.length > 0);
      for (const t of e.translation) {
        assert.ok(!t.text.startsWith('[网络]'), '不该出现 [网络] 前缀的机翻释义');
      }
    });
  });

  /* ------------------------------------------------------------------ */

  describe('例句归属', () => {
    test('run 的例句被判为动词用法并落在动词分组下', () => {
      const e = db.lookup('run').entry;
      const verbEx = e.examplesByPos?.v || [];
      assert.ok(verbEx.length > 0, 'run 应有归到动词的例句');
      // 曾经把所有例句错绑到「逃跑」义项上，原因是签名里含词头自身
      for (const g of e.senses) {
        for (const s of g.senses) {
          for (const x of s.tatoeba || []) {
            assert.ok(x.en, '绑定的例句应有正文');
          }
        }
      }
    });

    test('中英对照例句带中文', () => {
      const e = db.lookup('run').entry;
      const all = [...e.examples, ...Object.values(e.examplesByPos || {}).flat()];
      assert.ok(all.some((x) => x.zh), 'run 应有中英对照例句');
    });
  });

  /* ------------------------------------------------------------------ */

  describe('学术术语与词组', () => {
    test('维基术语库覆盖到常见学术词组', () => {
      const cases = [
        ['cross-validation', '交叉验证'],
        ['gradient descent', '梯度下降'],
        ['transfer learning', '迁移学习'],
        ['zero-shot learning', '零样本学习'],
      ];
      for (const [q, expectFragment] of cases) {
        const r = db.lookup(q, { noHistory: true });
        assert.equal(r.status, 'ok', `${q} 应能查到`);
        const all = [
          ...r.entry.translation.map((t) => t.text),
          ...(r.entry.terms || []).map((t) => t.zh),
        ].join(' ');
        assert.ok(all.includes(expectFragment), `${q} 的译名里应含「${expectFragment}」，实际：${all}`);
      }
    });

    test('术语译名已转成简体', () => {
      // 中文维基约一半标题是繁体，不转换会查出「信賴區間」「過適」
      const n = db.db
        .prepare("SELECT COUNT(*) c FROM terms WHERE zh LIKE '%學%' OR zh LIKE '%國%' OR zh LIKE '%與%' OR zh LIKE '%灣%'")
        .get().c;
      assert.equal(n, 0, `还有 ${n} 条术语是繁体`);
    });

    test('词组建议按是否有维基条目排序', () => {
      // 之前按词长排，gradient gun 会把 gradient descent 挤掉
      const g = db.suggest('gradient', 8).groups.find((x) => x.kind === 'phrase');
      assert.ok(g, '应有短语分组');
      const words = g.items.map((i) => i.word.toLowerCase());
      const iDescent = words.indexOf('gradient descent');
      const iGun = words.indexOf('gradient gun');
      assert.ok(iDescent >= 0, `gradient descent 应出现在建议里：${words.join(', ')}`);
      if (iGun >= 0) assert.ok(iDescent < iGun, 'gradient descent 应排在 gradient gun 前面');
    });

    test('查不到的词组给出逐词拆解', () => {
      const r = db.lookup('ablation study', { noHistory: true });
      assert.ok(r.decomposed, '应返回拆解结果');
      const words = r.decomposed.parts.map((p) => p.word);
      assert.deepEqual(words, ['ablation', 'study']);
      for (const p of r.decomposed.parts) {
        assert.equal(p.found, true, `${p.word} 应能查到`);
        assert.ok(p.brief, `${p.word} 应有释义`);
      }
    });

    test('拆解会做词形还原', () => {
      const r = db.lookup('embedding space', { noHistory: true });
      const words = r.decomposed.parts.map((p) => p.word);
      assert.ok(words.includes('embed'), `embedding 应还原成 embed，实际：${words.join(', ')}`);
    });

    test('相关搭配里不出现单字母碎片', () => {
      const r = db.lookup('embedding space', { noHistory: true });
      for (const rel of r.decomposed.related) {
        const bad = rel.word.split(/[\s-]+/).find((w) => w.length < 2);
        assert.ok(!bad, `相关搭配「${rel.word}」含单字母碎片`);
      }
    });
  });

  describe('易混词', () => {
    test('经典易混词对都能命中', () => {
      const cases = [
        ['adapt', 'adopt'],
        ['principal', 'principle'],
        ['desert', 'dessert'],
        ['complement', 'compliment'],
        ['stationary', 'stationery'],
        ['advice', 'advise'],
        ['loose', 'lose'],
      ];
      for (const [word, want] of cases) {
        const e = db.lookup(word).entry;
        const list = (e.confusables || []).map((c) => c.word.toLowerCase());
        assert.ok(list.includes(want), `${word} 的易混词里应有 ${want}，实际：${list.join(', ')}`);
      }
    });

    test('词形变化不算易混词', () => {
      // run/running/ran 是同一个词的不同形态，不该被当成需要辨析的两个词
      const e = db.lookup('run').entry;
      const list = (e.confusables || []).map((c) => c.word.toLowerCase());
      for (const form of ['ran', 'runs', 'running']) {
        assert.ok(!list.includes(form), `${form} 是 run 的词形，不该出现在易混词里`);
      }
    });

    test('同义词不算易混词', () => {
      const rows = db.db
        .prepare(
          `SELECT w1.wkey a, w2.wkey b, s.synonyms
             FROM confusables c
             JOIN words w1 ON w1.id = c.word_id
             JOIN words w2 ON w2.id = c.other_id
             JOIN senses s ON s.word_id = w1.id
            WHERE s.synonyms IS NOT NULL LIMIT 3000`,
        )
        .all();
      for (const r of rows) {
        const syns = r.synonyms.split(', ').map((x) => x.trim().toLowerCase());
        assert.ok(!syns.includes(r.b), `${r.a} 与 ${r.b} 是同义词，不该配成易混词对`);
      }
    });

    test('易混词都带释义，能直接对比', () => {
      const e = db.lookup('principal').entry;
      assert.ok(e.confusables.length > 0);
      for (const c of e.confusables) assert.ok(c.brief, `${c.word} 缺少释义`);
    });
  });

  describe('GCIDE 词源与引文', () => {
    test('词源内容是真实的词源而不是元数据', () => {
      const e = db.lookup('candid').entry;
      assert.ok(e.etym.includes('candidus'), `词源应含拉丁词根，实际：${e.etym}`);
      assert.ok(!e.etym.includes('1913 Webster'), '不该把出处标注当成词源内容');
      assert.ok(!e.etym.includes('<'), '不该残留 SGML 标签');
    });

    test('古典引文带作者署名', () => {
      const e = db.lookup('candid').entry;
      assert.ok(e.quotes.length > 0);
      assert.ok(e.quotes.some((q) => q.author), '至少一条引文应有作者');
      for (const q of e.quotes) assert.ok(!q.text.includes('<'), '不该残留 SGML 标签');
    });

    test('特殊字符实体已还原', () => {
      // GCIDE 用 <ecir/ <amac/ 之类表示带音符的字母
      const e = db.lookup('candid').entry;
      assert.ok(!/<[a-z]+\/?>/i.test(e.etym), `词源里不该有未解析的实体：${e.etym}`);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('性能', () => {
    test('连续 200 次查词平均耗时在毫秒级', () => {
      const words = db.db
        .prepare('SELECT word FROM words WHERE is_single = 1 AND rank < 30000 ORDER BY random() LIMIT 200')
        .all()
        .map((r) => r.word);

      const t0 = performance.now();
      let ok = 0;
      for (const w of words) if (db.lookup(w).status === 'ok') ok++;
      const per = (performance.now() - t0) / words.length;

      assert.equal(ok, words.length, '常用词应全部命中');
      assert.ok(per < 20, `单次查词耗时 ${per.toFixed(2)}ms，超出预期`);
    });
  });
});

if (missing) {
  test('提示：词库缺失，DictDB 用例已跳过', () => {
    console.log(`\n  ${skip}\n`);
  });
}
