/**
 * 一次性实验：怎么问模型，才能拿到它在真实句子里对术语的那个错译写法。
 *
 * 起因：术语表的替换建立在「模型对同一术语的错译是固定的」这个假设上。
 * 实测发现只对短词成立——replay buffer 单独问给的是「复制缓冲器」，
 * 但在句子里出现的是「反弹缓冲」，两者对不上，替换就不会发生。
 *
 * 这里对比三种问法，看哪种能对上句子里的实际写法：
 *   A 裸术语        replay buffer
 *   B 带冠词        the replay buffer
 *   C 固定框架做差  "We use the replay buffer." 减去 "We use the thing."
 *
 * 用法：node_modules\.bin\electron scripts/probe-glossary-carriers.js
 */
const path = require('node:path');
const { app } = require('electron');
const { Translator } = require('../src/main/translate.js');
const { cleanProbe } = require('../src/main/glossary.js');

const TERMS = [
  'policy', 'value function', 'replay buffer', 'ablation study',
  'scalar', 'temporal difference', 'gradient descent', 'baseline',
];

/* 真实句子：译文里的那几个字才是我们真正要替换的目标 */
const SENTENCES = [
  'We train the policy with a replay buffer and estimate the value function.',
  'Our ablation study shows that the baseline is strong.',
  'The agent receives a scalar reward at each time step.',
  'We use temporal difference learning instead of gradient descent here.',
];

/** 框架句的对照：把术语换成一个模型一定会稳定翻译的词 */
const FRAME = (x) => `We use the ${x}.`;
const FRAME_CTRL = 'thing';

/** 掐掉共同的头尾，中间剩下的就是术语被译成的那几个字 */
function diffMiddle(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i
    && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return a.slice(i, a.length - j);
}

app.whenReady().then(async () => {
  // 模型和 dict.db 放一起，就在仓库的 data/ 下
  const root = path.join(__dirname, '..', 'data', 'model');
  const tr = new Translator(root, { model: 'opus' });
  if (!tr.available) {
    console.error('没装翻译模型，先跑 npm run fetch:model。找的是', root);
    app.exit(1);
    return;
  }
  console.log('模型目录', root, '已装:', tr.installedModels().map((m) => m.key).join(','));

  // 句子先译一遍，拿到「真实译文」作为评判标准
  const refs = [];
  for (const s of SENTENCES) {
    const r = await tr.translate(s);
    refs.push(r.ok ? r.text : '');
    console.log('\n句:', s);
    console.log('译:', refs.at(-1));
  }

  const ctrl = await tr.translate(FRAME(FRAME_CTRL));
  console.log('\n框架对照:', FRAME(FRAME_CTRL), '→', ctrl.text);

  console.log('\n术语'.padEnd(22), 'A 裸词'.padEnd(12), 'B 带冠词'.padEnd(12), 'C 框架做差'.padEnd(12), '命中');
  const score = { A: 0, B: 0, C: 0, any: 0, total: 0 };

  for (const term of TERMS) {
    // 只统计真的出现在实验句里的术语
    const inSent = SENTENCES.some((s) => s.toLowerCase().includes(term));
    if (!inSent) continue;
    score.total += 1;
    // 一条出错不该把整轮实验带走（上次就是这么静默卡死的）
    try {

    const a = cleanProbe((await tr.translate(term)).text);
    const b = cleanProbe((await tr.translate(`the ${term}`)).text);
    const fr = await tr.translate(FRAME(term));
    const c = cleanProbe(diffMiddle(fr.ok ? fr.text : '', ctrl.ok ? ctrl.text : ''));

    /* 判据：这个写法在包含该术语的那句译文里能不能找到。
       找不到就说明拿它去替换什么也换不动。 */
    const hitIn = (w) => !!w && SENTENCES.some((s, i) =>
      s.toLowerCase().includes(term) && refs[i].includes(w));

    const marks = [];
    if (hitIn(a)) { score.A += 1; marks.push('A'); }
    if (hitIn(b)) { score.B += 1; marks.push('B'); }
    if (hitIn(c)) { score.C += 1; marks.push('C'); }
    if (marks.length) score.any += 1;

    console.log(
      term.padEnd(22),
      String(a).padEnd(12), String(b).padEnd(12), String(c).padEnd(12),
      marks.join('+') || '（都对不上）',
    );
    } catch (e) {
      console.log(term.padEnd(22), '探测抛异常：', e.message);
    }
  }

  console.log(`\n覆盖：A 裸词 ${score.A}/${score.total}  B 带冠词 ${score.B}/${score.total}`
    + `  C 框架做差 ${score.C}/${score.total}  三者并集 ${score.any}/${score.total}`);
  tr.dispose();
  app.exit(0);
});
