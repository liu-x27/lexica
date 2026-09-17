/**
 * 术语表的回归测试。
 *
 * 这个模块最危险的地方不是「改得不够」，而是「乱改」——
 * 把不该动的字改掉，译文会比不修更糟且没人察觉。
 * 所以测试的重点是那两个门槛：英文里没出现过就不动，
 * 译文里没出现错译写法就不动。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  parseGlossary, matchTerms, applyGlossary, needProbe, cleanProbe, diffMiddle, frameDiffOk,
} = require(path.join(ROOT, 'src', 'main', 'glossary.js'));

describe('术语表解析', () => {
  test('接受各种人会用的写法', () => {
    const { terms } = parseGlossary([
      'policy = 策略',
      'value function: 价值函数',
      'replay buffer    经验回放缓冲',
      'ablation study，消融实验',
      'temporal difference｜时序差分'.replace('｜', '|'),
      'scalar\t标量',
    ].join('\n'));
    const map = new Map(terms.map((t) => [t.term, t.zh]));
    assert.equal(map.get('policy'), '策略');
    assert.equal(map.get('value function'), '价值函数');
    assert.equal(map.get('replay buffer'), '经验回放缓冲');
    assert.equal(map.get('ablation study'), '消融实验');
    assert.equal(map.get('temporal difference'), '时序差分');
    assert.equal(map.get('scalar'), '标量');
  });

  test('跳过注释、空行与行尾备注', () => {
    const { terms } = parseGlossary([
      '# 这是注释',
      '// 这也是',
      '',
      'policy = 策略  # 强化学习里的策略',
    ].join('\n'));
    assert.equal(terms.length, 1);
    assert.equal(terms[0].zh, '策略', '行尾备注要去掉');
  });

  test('拒绝明显不是术语表的行', () => {
    const { terms, skipped } = parseGlossary([
      'policy = 策略',
      'just one column',          // 没有右侧
      'policy = policy',          // 右侧没有中文
      '策略 = policy',            // 左右颠倒
      'a b c = 这个也行',          // 多词是合法的
    ].join('\n'));
    const got = terms.map((t) => t.term);
    assert.ok(got.includes('policy'));
    assert.ok(got.includes('a b c'));
    assert.equal(got.length, 2);
    assert.equal(skipped, 3);
  });

  test('同一个术语只留一条', () => {
    const { terms } = parseGlossary('policy = 策略\nPolicy = 方针');
    assert.equal(terms.length, 1);
  });

  /* 单个空格不能当分隔符：多词术语本身就带空格 */
  test('单空格不切分，否则多词术语会被拆坏', () => {
    const { terms } = parseGlossary('replay buffer 经验回放缓冲');
    // 只有一个空格分隔时无法判断边界，应当跳过而不是乱猜
    assert.equal(terms.length, 0);
  });
});

describe('术语匹配', () => {
  const rows = [
    { term: 'policy', surface: 'policy', zh: '策略', wrong: ['政策'] },
    { term: 'replay buffer', surface: 'replay buffer', zh: '经验回放缓冲', wrong: ['重弹缓冲'] },
    { term: 'buffer', surface: 'buffer', zh: '缓冲区', wrong: ['缓冲器'] },
  ];

  test('整词匹配，不命中更长的单词', () => {
    assert.equal(matchTerms('The policy is fixed.', rows).length, 1);
    assert.equal(matchTerms('Ask the policymaker.', rows).length, 0,
      'policy 不该命中 policymaker');
  });

  test('复数与所有格也认', () => {
    assert.ok(matchTerms('Different policies exist.', rows).some((r) => r.term === 'policy')
      || matchTerms("The policy's role.", rows).some((r) => r.term === 'policy'));
    assert.ok(matchTerms("The policy's role.", rows).some((r) => r.term === 'policy'));
  });

  test('长术语排在短术语前面', () => {
    const hits = matchTerms('The replay buffer stores samples.', rows);
    assert.equal(hits[0].term, 'replay buffer',
      '长的必须先处理，否则会被 buffer 切开');
  });
});

describe('术语替换的两个门槛', () => {
  const policy = { term: 'policy', surface: 'policy', zh: '策略', wrong: ['政策'] };

  test('两个条件都满足才替换', () => {
    const hits = matchTerms('Our goal is to learn a policy.', [policy]);
    const r = applyGlossary('我们的目标是学习一项政策。', hits);
    assert.equal(r.text, '我们的目标是学习一项策略。');
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].from, '政策');
  });

  /* 这条是这个模块存在风险的地方：只看译文的话，
     任何谈政策的句子都会被改成「策略」。 */
  test('英文里没有这个术语，绝不动译文', () => {
    const hits = matchTerms('The government announced new measures.', [policy]);
    assert.equal(hits.length, 0);
    const r = applyGlossary('政府宣布了新政策。', hits);
    assert.equal(r.text, '政府宣布了新政策。', '不该被改');
    assert.equal(r.applied.length, 0);
  });

  test('译文里没有错译写法，也不动', () => {
    const hits = matchTerms('Our policy is simple.', [policy]);
    const r = applyGlossary('我们的方针很简单。', hits);
    assert.equal(r.text, '我们的方针很简单。', '没命中已知错法就别猜');
    assert.equal(r.applied.length, 0);
  });

  test('模型已经译对了就不动', () => {
    const hits = matchTerms('Our policy is simple.', [policy]);
    const r = applyGlossary('我们的策略很简单。', hits);
    assert.equal(r.applied.length, 0);
  });

  /* 单字错法在中文里到处都是，用来替换会把整句改烂。
     两个字以上是允许的——中文术语大多就两个字（政策、缓冲）。 */
  test('单字的错译写法不用来替换', () => {
    const t = { term: 'energy', surface: 'energy', zh: '能量', wrong: ['能'] };
    const hits = matchTerms('The energy is conserved.', [t]);
    const r = applyGlossary('这个能不能守恒。', hits);
    assert.equal(r.text, '这个能不能守恒。', '单字错法不该拿来替换');
  });

  test('一条术语只替换一次，多个错法取最长的', () => {
    const t = {
      term: 'value function', surface: 'value function', zh: '价值函数',
      wrong: ['价值功能', '功能价值'],
    };
    const hits = matchTerms('We approximate the value function.', [t]);
    const r = applyGlossary('我们近似价值功能。', hits);
    assert.equal(r.text, '我们近似价值函数。');
    assert.equal(r.applied.length, 1);
  });

  test('同一个错法在句中出现多次要全换', () => {
    const hits = matchTerms('The policy and the policy again.', [policy]);
    const r = applyGlossary('这项政策和那项政策。', hits);
    assert.equal(r.text, '这项策略和那项策略。');
  });

  test('空译文不报错', () => {
    const hits = matchTerms('Our policy.', [policy]);
    assert.equal(applyGlossary('', hits).text, '');
    assert.equal(applyGlossary(null, hits).text, '');
  });
});

describe('待探测的条目', () => {
  test('只挑还不知道错译写法的', () => {
    const hits = [
      { term: 'a', zh: '甲', wrong: ['乙'] },
      { term: 'b', zh: '丙', wrong: [] },
      { term: 'c', zh: '丁' },
    ];
    const need = needProbe(hits);
    assert.deepEqual(need.map((h) => h.term), ['b', 'c'],
      '已经问过模型的不该再问');
  });
});

describe('探测结果清洗', () => {
  test('去掉标点与括注', () => {
    assert.equal(cleanProbe('政策。'), '政策');
    assert.equal(cleanProbe(' “政策” '), '政策');
    assert.equal(cleanProbe('价值功能（value function）'), '价值功能');
  });

  /* 拿一整句去做子串替换会把译文改烂，这种必须丢掉 */
  test('模型回了一整句就不要', () => {
    assert.equal(cleanProbe('这项政策是指政府采取的一系列措施'), null);
  });

  /* 模型拿到孤零零一个词时会原地打转，不折叠的话这些写法永远匹配不上 */
  test('折叠模型的原地重复', () => {
    assert.equal(cleanProbe('政策政策'), '政策');
    assert.equal(cleanProbe('标标'), '标');
    assert.equal(cleanProbe('基准基准基准基准'), '基准');
    assert.equal(cleanProbe('价值功能'), '价值功能', '不是重复的别动');
    assert.equal(cleanProbe('研究研究所'), '研究研究所', '只折叠整体重复，不折叠部分重叠');
  });

  test('没译、或者把原词抄回来的不要', () => {
    assert.equal(cleanProbe('policy'), null);
    assert.equal(cleanProbe('policy 政策'), null);
    assert.equal(cleanProbe(''), null);
    assert.equal(cleanProbe(null), null);
  });
});

describe('框架句做差', () => {
  /* 这是拿到「模型在句子里怎么译这个术语」的办法：
     同一个框架，术语位置换成控制词，两份译文一减。 */
  test('掐掉共同头尾，留中间那段', () => {
    assert.equal(diffMiddle('我们使用反弹缓冲。', '我们使用这个。'), '反弹缓冲');
    assert.equal(diffMiddle('我们用价值函数做估计。', '我们用这个做估计。'), '价值函数');
  });

  test('两串一样就没有差', () => {
    assert.equal(diffMiddle('我们用这个。', '我们用这个。'), '');
  });

  test('空串不报错', () => {
    assert.equal(diffMiddle('', '我们用这个。'), '');
    assert.equal(diffMiddle(null, null), '');
  });

  /* 头尾都不同时整串都是差异，这种结果靠 cleanProbe 的长度门槛挡掉 */
  test('完全不同就整串返回', () => {
    assert.equal(diffMiddle('甲乙丙', '丁戊己'), '甲乙丙');
  });
});

describe('框架做差的可信度校验', () => {
  const ctrl = '我们用这个';

  test('干净的差异段可信', () => {
    assert.equal(frameDiffOk('重播缓冲', ctrl), true);
    assert.equal(frameDiffOk('梯度下降', ctrl), true);
  });

  /* 实测踩到的那条：模型把框架改写成「我们使用…」，
     差异段就把动词「使用」吸了进来。拿它替换会连「使用」一起删掉。 */
  test('混进框架自己的字就不可信', () => {
    assert.equal(frameDiffOk('使用价值函数', ctrl), false);
    assert.equal(frameDiffOk('这个东西', ctrl), false);
  });

  test('没有对照译文时不做判断', () => {
    assert.equal(frameDiffOk('重播缓冲', ''), true);
    assert.equal(frameDiffOk('', ctrl), false);
  });
});

describe('尾字差一个也要认', () => {
  /* 实测踩到的：探测拿到「反弹缓冲器」，句子里出现的是「反弹缓冲」，
     差一个「器」这条术语就白配置了。 */
  test('探到的写法比译文里多一个尾字', () => {
    const t = {
      term: 'replay buffer', surface: 'replay buffer', zh: '经验回放缓冲',
      wrong: ['反弹缓冲器'],
    };
    const hits = matchTerms('We train with a replay buffer.', [t]);
    const r = applyGlossary('我们将使用反弹缓冲训练。', hits);
    assert.equal(r.text, '我们将使用经验回放缓冲训练。');
  });

  test('原形能对上就不用削', () => {
    const t = {
      term: 'replay buffer', surface: 'replay buffer', zh: '经验回放缓冲',
      wrong: ['反弹缓冲器'],
    };
    const hits = matchTerms('We use the replay buffer.', [t]);
    const r = applyGlossary('我们用反弹缓冲器。', hits);
    assert.equal(r.text, '我们用经验回放缓冲。');
    assert.equal(r.applied[0].from, '反弹缓冲器', '优先用原形');
  });

  /* 只削一个字、且削完还剩三个字。放宽的话「反弹缓冲器」会一路削成
     「反弹」，那两个字在别的句子里也会出现，就成了乱改。 */
  test('三个字以下不削', () => {
    const t = { term: 'scalar', surface: 'scalar', zh: '标量', wrong: ['数量'] };
    const hits = matchTerms('The scalar reward.', [t]);
    assert.equal(applyGlossary('这个数值。', hits).text, '这个数值。', '「数」不该被拿来替换');
  });

  test('不会连削两个字', () => {
    const t = { term: 'replay buffer', surface: 'replay buffer', zh: '经验回放缓冲', wrong: ['反弹缓冲器'] };
    const hits = matchTerms('the replay buffer', [t]);
    assert.equal(applyGlossary('我们用反弹缓。', hits).text, '我们用反弹缓。');
  });
});
