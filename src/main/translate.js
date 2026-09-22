'use strict';
/**
 * 本地机器翻译兜底（opus-mt-en-zh 量化版）。
 *
 * 模型跑在独立的 utilityProcess 里，不在主进程。
 * ONNX 的加载与推理会长时间占住线程，放主进程会把 IPC 和窗口绘制一起卡死
 * ——实测连 capturePage 都会超时。
 *
 * 关于「为什么不自动替代词典释义」：实测这个模型在术语上会自信地译错
 *   ablation study   → 通货膨胀研究   （把 ablation 当成了 inflation）
 *   overfitting      → 超装
 *   gradient descent → 梯度 下位
 * 但自由表达译得不错（to the best of our knowledge → 尽我们所知）。
 * 所以结果永远排在逐词拆解之后，并标注为机器翻译。
 */
const path = require('node:path');
const fs = require('node:fs');
const { utilityProcess } = require('electron');

/**
 * 可选的翻译模型。与 translate-worker.js 里的 MODELS 一一对应，
 * 这边只需要知道「装了没有」和给界面展示的说明。
 *
 * 实测对比（8 个句子，见 scripts/eval-mt-candidates.mjs --run）：
 *   opus 快但学术文本上不可靠——会把 `from 71.2 to 63.8` 写成「从71.2降低至638」，
 *        `code and checkpoints` 译成「密码和检查站」；
 *   nllb 慢三四倍，但数字全对、不臆造，术语与结构明显更好。
 */
const MT_MODELS = {
  opus: {
    repo: 'Xenova/opus-mt-en-zh',
    label: 'opus-mt（快，117MB）',
    note: '约 0.7 秒一句。快，但术语和数字常出错。',
    probe: 'onnx/encoder_model_quantized.onnx',
  },
  nllb: {
    repo: 'Xenova/nllb-200-distilled-600M',
    label: 'NLLB-600M（准，874MB）',
    note: '约 2.9 秒一句。数字不会被改错，术语明显更好。',
    probe: 'onnx/encoder_model_quantized.onnx',
  },
};

const MODEL_ID = MT_MODELS.opus.repo;
const REQUEST_TIMEOUT = 60_000; // 首次要加载模型，给足时间

/* 切句规则和整段翻译的上限在 sentence-split.js：
   安卓的在线翻译也要用同一套，所以不能留在这个 require('electron') 的文件里。 */
const { splitSentences, MAX_CHARS, MAX_SENTENCES, MAX_CHUNK } = require('./sentence-split');

class Translator {
  constructor(modelRoot, { model = 'opus' } = {}) {
    this.root = modelRoot;
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.failures = 0;
    this.disabled = false;
    this.model = MT_MODELS[model] ? model : 'opus';
  }

  /** 某个模型的文件在不在 */
  hasModel(key) {
    const m = MT_MODELS[key];
    if (!m) return false;
    return fs.existsSync(path.join(this.root, m.repo, m.probe));
  }

  installedModels() {
    return Object.entries(MT_MODELS)
      .filter(([key]) => this.hasModel(key))
      .map(([key, m]) => ({ key, label: m.label, note: m.note }));
  }

  /**
   * 换模型。不用重启工作进程——它按 key 缓存多个 pipeline，
   * 切回来时不必重新加载。
   */
  setModel(key) {
    if (!MT_MODELS[key]) return this.model;
    if (this.hasModel(key)) this.model = key;
    return this.model;
  }

  /** 当前选中的模型在不在。不在就别在界面上给入口 */
  get available() {
    if (this.hasModel(this.model)) return true;
    /* 选中的没装，但装了别的：自动落到装了的那个，
       否则用户在设置里选了 nllb 又没下载，整个功能就静默失效了。 */
    const fallback = Object.keys(MT_MODELS).find((k) => this.hasModel(k));
    if (fallback) {
      console.warn(`[mt] 选中的模型 ${this.model} 没装，改用 ${fallback}`);
      this.model = fallback;
      return true;
    }
    return false;
  }

  _spawn() {
    if (this.child || this.disabled) return this.child;

    const worker = path.join(__dirname, 'translate-worker.js');
    if (!fs.existsSync(worker)) {
      console.error('[mt] 找不到工作进程脚本：', worker);
      return null;
    }

    this.child = utilityProcess.fork(worker, [], {
      serviceName: 'lexica-translate',
      stdio: 'ignore',
    });

    this.child.on('message', (msg) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      // 进度消息不结束请求，只是往外报一句
      if (msg.progress) {
        try { p.onProgress?.(msg); } catch (e) { console.error('[mt] 进度回调出错', e); }
        return;
      }
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    });

    this.child.on('exit', (code) => {
      // 进程没了，挂起的请求要全部落地，否则界面会一直停在「翻译中」
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, reason: '翻译进程已退出' });
      }
      this.pending.clear();
      this.child = null;
      if (code !== 0) {
        this.failures++;
        if (this.failures >= 3) {
          this.disabled = true;
          console.error('[mt] 翻译进程连续退出，已停用机器翻译');
        }
      }
    });

    return this.child;
  }

  /**
   * @param payload      发给工作进程的消息
   * @param timeout      这次请求的超时时间
   * @param onProgress   逐句进度回调（只有 translateMany 会触发）
   */
  _send(payload, { timeout = REQUEST_TIMEOUT, onProgress = null } = {}) {
    const child = this._spawn();
    if (!child) return Promise.resolve({ ok: false, reason: '翻译进程无法启动' });

    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, reason: '翻译超时' });
      }, timeout);
      this.pending.set(id, { resolve, timer, onProgress });
      child.postMessage({ id, modelRoot: this.root, model: this.model, ...payload });
    });
  }

  /** 提前把模型载进工作进程，第一次划词就不用等 */
  warmup() {
    if (!this.available || this.disabled) return;
    this._send({ type: 'warmup' }).then((r) => {
      if (!r.ok) console.warn('[mt] 预热失败：', r.reason);
    });
  }

  /** 通用的可用性检查，两个入口共用 */
  _guard(src) {
    if (!src) return { ok: false, reason: '没有要翻译的内容' };
    if (!this.available) return { ok: false, reason: '模型未安装，请先运行 npm run fetch:model' };
    if (this.disabled) return { ok: false, reason: '机器翻译已停用（进程反复退出）' };
    return null;
  }

  /**
   * 短文本翻译（词组、单句）。
   * @returns {Promise<{ ok:boolean, text?:string, ms?:number, reason?:string }>}
   */
  async translate(text) {
    const src = String(text || '').trim();
    const bad = this._guard(src);
    if (bad) return bad;
    // 超过单句上限的直接转给整段通道，别再让用户自己去切
    if (src.length > MAX_CHUNK) {
      const r = await this.translateLong(src);
      return r.ok ? { ok: true, text: r.text, ms: r.ms } : r;
    }
    return this._send({ type: 'translate', text: src });
  }

  /**
   * 整段翻译：按句切开逐句译，再拼回去。
   *
   * @param text
   * @param onProgress 每译完一句回调 { done, total, text }
   * @returns {Promise<{ ok, text?, sentences?, ms?, truncated?, reason? }>}
   */
  async translateLong(text, onProgress = null) {
    const src = String(text || '').trim();
    const bad = this._guard(src);
    if (bad) return bad;

    const clipped = src.length > MAX_CHARS;
    let parts = splitSentences(clipped ? src.slice(0, MAX_CHARS) : src);
    if (!parts.length) return { ok: false, reason: '没有可翻译的句子' };

    const tooMany = parts.length > MAX_SENTENCES;
    if (tooMany) parts = parts.slice(0, MAX_SENTENCES);

    /* 超时按句数给：一句约 1 秒，首次还要加载模型。
       固定 60 秒的话，十几句的段落必然超时，而且超时后什么都拿不到。 */
    const timeout = 45_000 + parts.length * 8_000;

    const done = [];
    const r = await this._send(
      { type: 'translateMany', texts: parts },
      {
        timeout,
        onProgress: (m) => {
          done[m.i] = m.text;
          onProgress?.({ done: m.i + 1, total: parts.length, text: m.text });
        },
      },
    );

    if (!r.ok) return r;
    const outs = r.texts || done;
    return {
      ok: true,
      ms: r.ms,
      text: outs.join(''),
      // 原文与译文一一对应，界面要做双语对照
      sentences: parts.map((s, i) => ({ src: s, out: outs[i] || '' })),
      truncated: clipped || tooMany
        ? `原文过长，只翻译了前 ${parts.length} 句`
        : null,
    };
  }

  dispose() {
    try { this.child?.kill(); } catch { /* 忽略 */ }
    this.child = null;
  }
}

module.exports = { Translator, MODEL_ID, MT_MODELS, splitSentences };
