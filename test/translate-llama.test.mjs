/**
 * Hy-MT2 后端（走 llama-server）的回归测试：数字守卫、退回兜底、术语模板。
 *
 * llama-server 和 ONNX 工作进程都换成假的——这里要验的是 translate.js 的决策：
 * 什么时候用大模型那句、什么时候退回哪个本地模型、术语有没有真的进提示词。
 * 起真进程的那部分在 llama-server.test.mjs。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Translator, MT_MODELS } = require(path.join(ROOT, 'src', 'main', 'translate.js'));
const { hymtMessages, hymtParams, cleanOutput, MAX_TERMS } = require(path.join(ROOT, 'src', 'main', 'hymt.js'));

/** 在临时目录里摆出「装了哪些模型」：只看文件在不在 */
function fakeModels(root, keys) {
  for (const k of keys) {
    const m = MT_MODELS[k];
    const f = path.join(root, m.repo, m.file || m.probe);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
  }
}

/** 假 llama-server：按顺序吐预设的回答，或者抛错 */
function fakeLlama(replies) {
  const calls = [];
  return {
    calls,
    available: true,
    started: 0,
    async start() { this.started += 1; return 8770; },
    async chat(messages, params) {
      calls.push({ messages, params });
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return { text: r, ms: 7 };
    },
    dispose() {},
  };
}

describe('Hy-MT2 后端', () => {
  let root;
  let onnxCalls;

  /** 造一个 Translator，ONNX 工作进程换成按模型回固定译文的假货 */
  const make = (installed, llama, onnx = {}) => {
    fakeModels(root, installed);
    const t = new Translator(root, { model: 'hymt7b', llama });
    t._send = async (payload, { model } = {}) => {
      onnxCalls.push({ model: model || t.model, payload });
      if (payload.type === 'warmup') return { ok: true };
      const out = onnx[model || t.model];
      return out == null ? { ok: false, reason: '没这个模型' } : { ok: true, text: out, ms: 3 };
    };
    return t;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexica-mt-'));
    onnxCalls = [];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('数字对上了就用大模型那句，不碰兜底模型', async () => {
    const llama = fakeLlama(['准确率从71.2降至63.8。']);
    const t = make(['hymt7b', 'opus'], llama, { opus: '不该用到' });
    const r = await t.translate('Accuracy drops from 71.2 to 63.8.', { kind: 'live' });
    assert.equal(r.ok, true);
    assert.equal(r.text, '准确率从71.2降至63.8。');
    assert.equal(r.model, 'hymt7b');
    assert.equal(r.guard, undefined);
    assert.equal(onnxCalls.length, 0);
  });

  test('数字被改错就退回兜底模型，并记下是哪个数没对上', async () => {
    const llama = fakeLlama(['准确率从71.2降至638。']);
    const t = make(['hymt7b', 'opus'], llama, { opus: '从 71.2 降低到 63.8' });
    const r = await t.translate('Accuracy drops from 71.2 to 63.8.', { kind: 'live' });
    assert.equal(r.text, '从 71.2 降低到 63.8');
    assert.equal(r.model, 'opus');
    assert.deepEqual(r.guard.missing, ['63.8']);
  });

  test('兜底那句也没对上：留大模型的，标记 kept', async () => {
    const llama = fakeLlama(['准确率从71.2降至638。']);
    const t = make(['hymt7b', 'opus'], llama, { opus: '从71.2降低至638' });
    const r = await t.translate('Accuracy drops from 71.2 to 63.8.', { kind: 'live' });
    assert.equal(r.text, '准确率从71.2降至638。');
    assert.equal(r.model, 'hymt7b');
    assert.equal(r.guard.kept, true);
  });

  test('一个兜底模型都没装：留大模型的，不报错', async () => {
    const llama = fakeLlama(['共有70层。']);
    const t = make(['hymt7b'], llama);
    const r = await t.translate('There are 7 layers.', { kind: 'live' });
    assert.equal(r.ok, true);
    assert.equal(r.text, '共有70层。');
    assert.deepEqual(r.guard.missing, ['7']);
    assert.equal(r.guard.kept, true);
  });

  test('实时字幕先退 opus（快），整段翻译先退 nllb（准）', async () => {
    const src = 'We trained for 3 epochs.';
    for (const [kind, want] of [['live', 'opus'], ['batch', 'nllb'], ['lookup', 'nllb']]) {
      onnxCalls = [];
      const t = make(['hymt7b', 'opus', 'nllb'], fakeLlama(['我们训练了几轮。']),
        { opus: '我们训练了3个时代。', nllb: '我们训练了 3 个周期。' });
      const r = await t.translate(src, { kind });
      assert.equal(r.model, want, `${kind} 应当退回 ${want}`);
      assert.equal(onnxCalls[0].model, want);
    }
  });

  test('服务挂了或超时：这句交给兜底模型，字幕不空着', async () => {
    const llama = fakeLlama([new Error('llama-server 超时')]);
    const t = make(['hymt7b', 'opus'], llama, { opus: '你好。' });
    const r = await t.translate('Hello.', { kind: 'live' });
    assert.equal(r.ok, true);
    assert.equal(r.text, '你好。');
    assert.equal(r.model, 'opus');
    assert.match(r.error, /超时/);
  });

  test('服务挂了、也没有兜底：如实报失败', async () => {
    const t = make(['hymt7b'], fakeLlama([new Error('llama-server 没有运行')]));
    const r = await t.translate('Hello.', { kind: 'live' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /没有运行/);
  });

  test('术语表命中的词进了官方术语模板', async () => {
    const llama = fakeLlama(['我们用经验回放缓冲训练策略。']);
    const t = make(['hymt7b'], llama);
    await t.translate('We train the policy with a replay buffer.', {
      terms: [{ en: 'replay buffer', zh: '经验回放缓冲' }, { en: 'policy', zh: '策略' }],
    });
    const prompt = llama.calls[0].messages.at(-1).content;
    assert.match(prompt, /replay buffer 翻译成 经验回放缓冲/);
    assert.match(prompt, /policy 翻译成 策略/);
    assert.ok(prompt.endsWith('We train the policy with a replay buffer.'), '原文要在最后');
  });

  test('整段翻译逐句过守卫，每句记下实际译它的模型', async () => {
    const llama = fakeLlama(['第一句。', '降至638。']);
    const t = make(['hymt7b', 'nllb'], llama, { nllb: '降至 63.8。' });
    const seen = [];
    const r = await t.translateLong('This is the first sentence. It drops to 63.8.', (p) => seen.push(p.done));
    assert.equal(r.ok, true);
    assert.deepEqual(r.sentences.map((s) => s.model), ['hymt7b', 'nllb']);
    assert.equal(r.text, '第一句。降至 63.8。');
    assert.deepEqual(seen, [1, 2]);
  });

  test('预热会把兜底模型一起载上，返回服务起没起来', async () => {
    const llama = fakeLlama([]);
    const t = make(['hymt7b', 'opus'], llama);
    const r = await t.warmup();
    assert.deepEqual(r, { ok: true });
    assert.equal(llama.started, 1);
    assert.ok(onnxCalls.some((c) => c.payload.type === 'warmup' && c.model === 'opus'));

    const broken = { ...fakeLlama([]), start: async () => { throw new Error('显存不够'); } };
    const t2 = make(['hymt7b'], broken);
    assert.deepEqual(await t2.warmup(), { ok: false, reason: '显存不够' });
  });

  test('没有 llama-server.exe 时，GGUF 在也不算装好', () => {
    const t = make(['hymt7b', 'opus'], { ...fakeLlama([]), available: false });
    assert.equal(t.hasModel('hymt7b'), false);
    assert.deepEqual(t.installedModels().map((m) => m.key), ['opus']);
    // 选中的没装好，自动落到装了的那个
    assert.equal(t.available, true);
    assert.equal(t.model, 'opus');
  });
});

describe('Hy-MT2 提示词', () => {
  /* 逐字钉死：专用翻译模型是按固定模板训的，改一个字都可能让它开始解释或续写。
     要改就是有意为之，连这条测试一起改。 */
  test('模板逐字照官方（论文表 1）', () => {
    assert.equal(hymtMessages('Hello.')[0].content,
      '将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\nHello.');
    assert.equal(
      hymtMessages('We use a replay buffer.', { terms: [{ en: 'replay buffer', zh: '经验回放缓冲' }] })[0].content,
      '参考下面的翻译：\nreplay buffer 翻译成 经验回放缓冲\n'
      + '将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\nWe use a replay buffer.',
    );
  });

  test('没有术语时用普通翻译模板', () => {
    const [m] = hymtMessages('Hello.');
    assert.equal(m.role, 'user');
    assert.doesNotMatch(m.content, /翻译成 /);
    assert.ok(m.content.endsWith('Hello.'));
  });

  test('术语最多带 MAX_TERMS 条，缺译名的不带', () => {
    const terms = Array.from({ length: 20 }, (_, i) => ({ en: `term${i}`, zh: `术语${i}` }));
    terms.unshift({ en: 'broken', zh: '' });
    const [m] = hymtMessages('x', { terms });
    assert.equal((m.content.match(/翻译成 /g) || []).length, MAX_TERMS);
    assert.doesNotMatch(m.content, /broken/);
  });

  test('贪心解码，生成上限随原文长度涨、有上下限', () => {
    const short = hymtParams('Hi.');
    assert.equal(short.temperature, 0);
    assert.equal(short.max_tokens, 96);
    assert.ok(hymtParams('word '.repeat(100)).max_tokens > 400);
    assert.equal(hymtParams('word '.repeat(1000)).max_tokens, 1024);
  });

  test('输出清理只动首尾', () => {
    assert.equal(cleanOutput('  你好。 '), '你好。');
    assert.equal(cleanOutput('<think>\n</think>\n你好。'), '你好。');
    assert.equal(cleanOutput('译文：你好。'), '你好。');
    assert.equal(cleanOutput('“你好。”', 'Hello.'), '你好。');
    // 原文本身带引号的，引号是原文的
    assert.equal(cleanOutput('“你好。”', '"Hello."'), '“你好。”');
    // 首尾是两对引号，不是一对：剥掉就成了半截引号
    assert.equal(cleanOutput('“注意力”与“记忆”', 'Attention and memory'), '“注意力”与“记忆”');
    assert.equal(cleanOutput('他说“好”。'), '他说“好”。');
  });
});
