/**
 * 实验：起步包导入后，会不会把真实译文改坏。
 *
 * 术语表是子串替换。最担心的是「探到的错法只是实际译文的一部分」：
 * 探到「自我注意」、句子里是「自我注意力」，替换成「自注意力」后剩下「自注意力力」。
 * 这种事只有拿真模型跑一遍才知道会不会发生。
 *
 * 流程和 index.js 的 probeTerms 完全一致（裸词 / 带冠词 / 框架句做差，取并集），
 * 用的是本地 opus——实时字幕的默认模型，也是错得最多的那个。
 *
 * 用法：node_modules\.bin\electron scripts/probe-glossary-packs.js
 */
const path = require('node:path');
const { app } = require('electron');
const { Translator } = require('../src/main/translate.js');
const G = require('../src/main/glossary.js');
const { PACKS } = require('../src/main/glossary-packs.js');

/* 每个包 6 句真实的课堂/论文句子，再加几句日常英语当对照 */
const SENTENCES = {
  ml: [
    'We minimize the loss function with stochastic gradient descent.',
    'A smaller learning rate reduces overfitting but can cause underfitting.',
    'We tune every hyperparameter on the validation set, never on the test set.',
    'Principal component analysis is a classic method for dimensionality reduction.',
    'Regularization helps with the bias-variance tradeoff.',
    'Self-supervised learning needs no labels, unlike supervised learning.',
  ],
  dl: [
    'Backpropagation computes the gradient of the loss with respect to every weight.',
    'Batch normalization and residual connections make deep networks easier to train.',
    'The transformer relies entirely on self-attention and multi-head attention.',
    'Dropout randomly zeroes activations during training.',
    'We train for ten epochs and then fine-tune on the target task.',
    'Vanishing gradients were a major problem for recurrent neural networks.',
  ],
  rl: [
    'The agent observes the state and receives a scalar reward.',
    'We learn a policy that maximizes the expected discounted return.',
    'Deep Q-networks use experience replay and a target network.',
    'Policy gradient methods are on-policy, while Q-learning is off-policy.',
    'The Bellman equation relates the value function of a state to its successors.',
    'Actor-critic methods combine a policy with a learned value function.',
  ],
  nlp: [
    'Large language models are surprisingly good at in-context learning.',
    'The tokenizer uses byte-pair encoding to split words into subwords.',
    'Chain-of-thought prompting improves reasoning in zero-shot settings.',
    'Retrieval-augmented generation reduces hallucination.',
    'We report perplexity on the held-out set.',
    'Beam search is common in sequence-to-sequence models.',
  ],
  sys: [
    'A race condition can lead to a deadlock if locks are acquired in the wrong order.',
    'Garbage collection pauses increase tail latency.',
    'Load balancing improves throughput in a distributed system.',
    'A page fault triggers a context switch into the kernel.',
    'Data parallelism and pipeline parallelism can be combined.',
    'Eventual consistency trades strong guarantees for availability and fault tolerance.',
  ],
  // 对照：日常英语，含起步包里的词但不是技术含义
  control: [
    'The government announced a new economic policy.',
    'The state of California passed a new law.',
    'The travel agent booked our flights.',
    'He was a college dropout who later founded a company.',
    'The transformer on the power line exploded during the storm.',
  ],
};

/** 替换边界上出现紧挨着的重复字（「力力」「区区」），多半是错法只盖住了一半 */
function boundaryDup(fixed, applied) {
  for (const a of applied) {
    const i = fixed.indexOf(a.to);
    if (i < 0) continue;
    const after = fixed[i + a.to.length];
    const before = fixed[i - 1];
    if (after && after === a.to[a.to.length - 1]) return `「${a.to}」后面又跟了「${after}」`;
    if (before && before === a.to[0]) return `「${a.to}」前面又有「${before}」`;
  }
  return null;
}

app.whenReady().then(async () => {
  const tr = new Translator(path.join(__dirname, '..', 'data', 'model'), { model: 'opus' });
  if (!tr.available) { console.error('没装本地翻译模型'); app.exit(1); return; }
  const raw = async (t) => { const r = await tr.translate(t); return r.ok ? r.text : ''; };

  // ---- 1. 探测：和 index.js 的 probeTerms 同一套
  const ctrl = await raw(G.PROBE_FRAME(G.PROBE_CONTROL));
  const rows = [];
  for (const p of PACKS) {
    for (const t of G.parseGlossary(p.text).terms) {
      const forms = new Set();
      for (const q of [t.surface, `the ${t.surface}`]) {
        const f = G.cleanProbe(await raw(q));
        if (f) forms.add(f);
      }
      const fr = G.cleanProbe(G.diffMiddle(await raw(G.PROBE_FRAME(t.surface)), ctrl));
      if (fr && G.frameDiffOk(fr, ctrl)) forms.add(fr);
      rows.push({ ...t, pack: p.id, wrong: [...forms] });
    }
  }
  const probed = rows.filter((r) => r.wrong.length).length;
  console.log(`探测：${rows.length} 条里 ${probed} 条拿到了错法\n`);

  // ---- 2. 真实句子：修之前 / 修之后
  let fixedCount = 0;
  let damage = 0;
  for (const [pack, list] of Object.entries(SENTENCES)) {
    console.log(`==== ${pack} ====`);
    for (const en of list) {
      const zh = await raw(en);
      const hits = G.matchTerms(en, rows);
      const r = G.applyGlossary(zh, hits);
      const dup = boundaryDup(r.text, r.applied);
      if (r.applied.length) fixedCount += 1;
      if (dup) damage += 1;
      console.log(`EN  ${en}`);
      console.log(`原  ${zh}`);
      if (r.applied.length) {
        console.log(`改  ${r.text}`);
        console.log(`    ${r.applied.map((a) => `${a.from}→${a.to}`).join('，')}${dup ? `   ⚠ ${dup}` : ''}`);
      } else {
        console.log('    （没动）');
      }
    }
    console.log('');
  }
  console.log(`合计：${fixedCount} 句被修改，边界重复字 ${damage} 处`);
  tr.dispose();
  app.exit(0);
});
