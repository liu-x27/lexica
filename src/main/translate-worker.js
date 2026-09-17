'use strict';
/**
 * 翻译工作进程。
 *
 * 必须独立成进程：ONNX 的模型加载（107MB）与推理会长时间占住所在线程，
 * 放在 Electron 主进程里会把 IPC 和窗口绘制一起卡死——实测截图请求都会超时。
 * 这里由 utilityProcess.fork 拉起，通过 parentPort 收发消息。
 *
 * 协议：
 *   收 { id, type: 'translate', text }       → 回 { id, ok, text?, ms?, reason? }
 *   收 { id, type: 'translateMany', texts }  → 每句回 { id, progress:true, i, total, text }
 *                                              最后回 { id, ok, texts?, ms?, reason? }
 *   收 { id, type: 'warmup' }                → 回 { id, ok }
 */
/**
 * 可选的翻译模型。
 *
 * opus 快但学术文本上不可靠（会把 63.8 写成 638）；
 * nllb 慢三四倍但数字准、不臆造。两个都装着，由设置决定用哪个，
 * 完整对比见 README 的「长句翻译」一节。
 */
const MODELS = {
  opus: { repo: 'Xenova/opus-mt-en-zh', dtype: 'q8', opts: {} },
  nllb: {
    repo: 'Xenova/nllb-200-distilled-600M',
    dtype: 'q8',
    // NLLB 是多语模型，不指定方向默认不会译成中文
    opts: { src_lang: 'eng_Latn', tgt_lang: 'zho_Hans' },
  },
};

/** 同时缓存多个已加载的模型：切换模型不该每次都重新加载 */
const pipes = new Map();

function load(modelRoot, modelKey = 'opus') {
  const key = MODELS[modelKey] ? modelKey : 'opus';
  if (pipes.has(key)) return pipes.get(key);
  const m = MODELS[key];
  const p = (async () => {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.localModelPath = modelRoot;
    env.allowRemoteModels = false; // 保证离线：绝不回落到联网下载
    env.allowLocalModels = true;
    /* 限制 ONNX 的算子线程数。
       不限的话它会按核数开满，而实时字幕场景下 whisper 服务同时也在吃满 CPU，
       两边超额订阅的结果是**双双变慢**——实测一节课的字幕只识别出四分之一，
       识别队列 25 秒都排不完。给 4 个线程，单句翻译慢一点，但不会把识别拖垮。 */
    return pipeline('translation', m.repo, {
      dtype: m.dtype,
      session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
    });
  })();
  pipes.set(key, p);
  return p;
}

/**
 * 生成长度上限。
 *
 * 写死 128 的话，长句会被从中间截断，而且截断处没有任何提示——
 * 看起来像模型翻到一半就不译了。
 *
 * 系数给到 3 倍是实测调的：按 2 倍算时，`We release code and checkpoints to
 * facilitate reproduction.`（9 词 → 42 token）会在「我们将发放代码和检查点，」
 * 处截断。中文按字切 token 时用量比英文词数多，2 倍不够。
 * 上限 512 是 Marian 的位置编码上限。
 */
function budgetFor(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(96, Math.min(512, words * 3 + 48));
}

async function translateOne(pipe, text, extra = {}) {
  const out = await pipe(String(text), { ...extra, max_new_tokens: budgetFor(text) });
  const got = Array.isArray(out) ? out[0]?.translation_text : out?.translation_text;
  return got || '';
}

/**
 * 请求串行化。
 *
 * 消息处理函数是 async 的，parentPort 不会等上一条处理完再派发下一条，
 * 于是多个请求会并发调用同一个 pipeline。实测表现是整体变得极慢
 * （划词那次还没完，翻译页又发一次，8 秒都出不来结果），
 * 而且共用一个 ONNX session 并发推理本身也没有正确性保证。
 * 用一条 promise 链排队，先到先做。
 */
let queue = Promise.resolve();
const enqueue = (fn) => {
  const run = queue.then(fn, fn);
  // 队列本身不能因为某次失败而断掉
  queue = run.catch(() => {});
  return run;
};

process.parentPort.on('message', (e) => enqueue(async () => {
  const msg = e.data || {};
  const reply = (payload) => process.parentPort.postMessage({ id: msg.id, ...payload });

  try {
    const modelKey = msg.model || 'opus';
    const extra = (MODELS[modelKey] || MODELS.opus).opts;

    if (msg.type === 'warmup') {
      await load(msg.modelRoot, modelKey);
      return reply({ ok: true });
    }

    if (msg.type === 'translate') {
      const pipe = await load(msg.modelRoot, modelKey);
      const t0 = Date.now();
      const text = await translateOne(pipe, msg.text, extra);
      if (!text) return reply({ ok: false, reason: '模型没有返回结果' });
      return reply({ ok: true, text, ms: Date.now() - t0 });
    }

    if (msg.type === 'translateMany') {
      const pipe = await load(msg.modelRoot, modelKey);
      const t0 = Date.now();
      const src = Array.isArray(msg.texts) ? msg.texts : [];
      const texts = [];
      for (let i = 0; i < src.length; i++) {
        const one = await translateOne(pipe, src[i], extra);
        texts.push(one);
        // 逐句回报：整段翻译要好几秒，界面得能一句句显示出来
        reply({ progress: true, i, total: src.length, text: one });
      }
      return reply({ ok: true, texts, ms: Date.now() - t0 });
    }

    reply({ ok: false, reason: `未知指令 ${msg.type}` });
  } catch (err) {
    // 加载失败要清掉缓存，否则后续请求会一直复用这个失败结果
    if (msg.type !== 'translate' && msg.type !== 'translateMany') pipes.delete(msg.model || 'opus');
    reply({ ok: false, reason: err?.message || String(err) });
  }
}));
