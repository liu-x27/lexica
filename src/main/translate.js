'use strict';
/**
 * 本地机器翻译：opus-mt / NLLB 走 ONNX（独立的 utilityProcess），
 * Hy-MT2 走 llama-server（llama.cpp 的常驻服务，见 llama-server.js）。
 *
 * ONNX 模型跑在独立的 utilityProcess 里，不在主进程。
 * ONNX 的加载与推理会长时间占住线程，放主进程会把 IPC 和窗口绘制一起卡死
 * ——实测连 capturePage 都会超时。llama-server 本来就是另一个进程，
 * 这边只发 HTTP 请求，不占主进程。
 *
 * 关于「为什么不自动替代词典释义」：实测 opus 在术语上会自信地译错
 *   ablation study   → 通货膨胀研究   （把 ablation 当成了 inflation）
 *   overfitting      → 超装
 *   gradient descent → 梯度 下位
 * 但自由表达译得不错（to the best of our knowledge → 尽我们所知）。
 * 所以结果永远排在逐词拆解之后，并标注为机器翻译。
 *
 * Hy-MT2 的译文一律过数字守卫（number-guard.js）：原文里的数字没有原样出现在
 * 译文里，就退回 ONNX 兜底模型重译这一句。
 */
const path = require('node:path');
const fs = require('node:fs');
const { utilityProcess } = require('electron');
const { HYMT_MODELS, hymtMessages, hymtParams, cleanOutput } = require('./hymt');
const { LlamaServer } = require('./llama-server');
const { checkNumbers } = require('./number-guard');

/**
 * 可选的翻译模型。ONNX 那两个与 translate-worker.js 里的 MODELS 一一对应，
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
  /* 下面这些走 llama-server，不走 ONNX 工作进程。术语表命中的词填进官方的
     术语模板；译文过数字守卫，没过就退回上面两个兜底。 */
  ...HYMT_MODELS,
};

/** 走 llama-server 的模型 */
const isLlama = (key) => MT_MODELS[key]?.backend === 'llama';

/**
 * 大模型这句不能用（数字没对上、服务挂了、超时）时退回哪个 ONNX 模型。
 * 实时字幕要快，先 opus；查词和整段翻译要准，先 nllb。
 */
const FALLBACK_ORDER = { live: ['opus', 'nllb'], other: ['nllb', 'opus'] };

const MODEL_ID = MT_MODELS.opus.repo;
const REQUEST_TIMEOUT = 60_000; // 首次要加载模型，给足时间

/* 实时字幕等大模型最多这么久，过了就交给兜底模型。整段翻译不着急，用 REQUEST_TIMEOUT。
   全部层在显卡上时 7B 一句不到一秒；退到 CPU 上才会撞到这个上限。 */
const LIVE_TIMEOUT = 8_000;

/* 切句规则和整段翻译的上限在 sentence-split.js：
   安卓的在线翻译也要用同一套，所以不能留在这个 require('electron') 的文件里。 */
const { splitSentences, MAX_CHARS, MAX_SENTENCES, MAX_CHUNK } = require('./sentence-split');

class Translator {
  /**
   * @param modelRoot  data/model
   * @param model      当前选中的模型 key
   * @param llamaDir   llama-server.exe 所在目录，默认 data/llama
   * @param llama      测试用：换一个假的 LlamaServer
   */
  constructor(modelRoot, { model = 'opus', llamaDir = null, llama = null } = {}) {
    this.root = modelRoot;
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.failures = 0;
    this.disabled = false;
    this.model = MT_MODELS[model] ? model : 'opus';
    this.llama = llama || new LlamaServer(llamaDir || path.join(path.dirname(modelRoot), 'llama'),
      { tag: 'mt-llama' });
  }

  _ggufPath(key) {
    const m = MT_MODELS[key];
    return path.join(this.root, m.repo, m.file);
  }

  /** 某个模型的文件在不在。llama 那几个还要 llama-server.exe 也在 */
  hasModel(key) {
    const m = MT_MODELS[key];
    if (!m) return false;
    if (isLlama(key)) return this.llama.available && fs.existsSync(this._ggufPath(key));
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

  /** 这个场景下退回哪个 ONNX 模型；一个都没装就是 null */
  _fallbackKey(kind) {
    return (FALLBACK_ORDER[kind] || FALLBACK_ORDER.other).find((k) => this.hasModel(k)) || null;
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
   * 发给 ONNX 工作进程。
   * @param payload      发给工作进程的消息
   * @param timeout      这次请求的超时时间
   * @param onProgress   逐句进度回调（只有 translateMany 会触发）
   * @param model        用哪个模型，默认当前选中的（兜底时会指定别的）
   */
  _send(payload, { timeout = REQUEST_TIMEOUT, onProgress = null, model = null } = {}) {
    const child = this._spawn();
    if (!child) return Promise.resolve({ ok: false, reason: '翻译进程无法启动' });

    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, reason: '翻译超时' });
      }, timeout);
      this.pending.set(id, { resolve, timer, onProgress });
      child.postMessage({ id, modelRoot: this.root, model: model || this.model, ...payload });
    });
  }

  /**
   * 提前把模型载好，第一次划词、第一句字幕就不用等。
   * @returns {Promise<{ok:boolean, reason?:string}>} 不关心结果的调用方可以不等
   */
  warmup() {
    if (!this.available || this.disabled) {
      return Promise.resolve({ ok: false, reason: this.disabled ? '机器翻译已停用' : '模型未安装' });
    }
    if (isLlama(this.model)) {
      /* 兜底模型也一起载上：数字守卫第一次拦下译文时，实时字幕不该再等 opus 现加载 */
      const fb = this._fallbackKey('live');
      if (fb) this._send({ type: 'warmup' }, { model: fb }).catch(() => {});
      return this.llama.start(this._ggufPath(this.model))
        .then(() => ({ ok: true }), (e) => {
          console.warn('[mt] llama-server 预热失败：', e.message);
          return { ok: false, reason: e.message };
        });
    }
    return this._send({ type: 'warmup' }).then((r) => {
      if (!r.ok) console.warn('[mt] 预热失败：', r.reason);
      return r;
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
   * @param kind   live | batch | lookup：决定超时和兜底先用哪个模型
   * @param terms  术语表命中的条目 [{ en, zh }]，只有支持术语模板的模型（Hy-MT2）会用
   * @returns {Promise<{ ok, text?, ms?, model?, guard?, reason? }>}
   *          model 是实际译出这句的模型；guard 在数字守卫拦过时给出没对上的数字
   */
  async translate(text, { kind = 'lookup', terms = [] } = {}) {
    const src = String(text || '').trim();
    const bad = this._guard(src);
    if (bad) return bad;
    // 超过单句上限的直接转给整段通道，别再让用户自己去切
    if (src.length > MAX_CHUNK) {
      const r = await this.translateLong(src, null, { kind, termsFor: () => terms });
      return r.ok ? { ok: true, text: r.text, ms: r.ms, model: this.model } : r;
    }
    if (isLlama(this.model)) return this._llamaOne(src, { kind, terms });
    const r = await this._send({ type: 'translate', text: src });
    return r.ok ? { ...r, model: this.model } : r;
  }

  /** 让兜底的 ONNX 模型译这一句 */
  async _fallback(src, kind) {
    const fb = this._fallbackKey(kind);
    if (!fb) return { ok: false, reason: '没有装可以兜底的本地模型' };
    const r = await this._send({ type: 'translate', text: src }, { model: fb });
    return r.ok ? { ...r, model: fb } : r;
  }

  /**
   * 大模型译一句，过数字守卫。
   *
   * 没过就让 ONNX 兜底模型重译；兜底那句也没过的话留大模型的——兜底模型在数字上
   * 不比它强（opus 正是 63.8 → 638 的那个），别的地方还更差。两种情况都在 guard 里
   * 记下没对上的数字，流水账和日志里看得到。
   */
  async _llamaOne(src, { kind = 'lookup', terms = [] } = {}) {
    const key = this.model;
    let first;
    try {
      await this.llama.start(this._ggufPath(key));
      const r = await this.llama.chat(hymtMessages(src, { terms }), hymtParams(src),
        { timeout: kind === 'live' ? LIVE_TIMEOUT : REQUEST_TIMEOUT });
      const out = cleanOutput(r.text, src);
      if (!out) throw new Error('模型没有返回译文');
      first = { text: out, ms: r.ms };
    } catch (e) {
      // 服务挂了或超时：这句交给兜底模型，别让字幕空着
      const f = await this._fallback(src, kind);
      return f.ok ? { ...f, error: e.message } : { ok: false, reason: `${e.message}；兜底：${f.reason}` };
    }

    const guard = checkNumbers(src, first.text);
    if (guard.ok) return { ok: true, text: first.text, ms: first.ms, model: key };

    const f = await this._fallback(src, kind);
    if (f.ok && checkNumbers(src, f.text).ok) {
      return { ...f, ms: first.ms + (f.ms || 0), guard: { missing: guard.missing } };
    }
    return { ok: true, text: first.text, ms: first.ms, model: key, guard: { missing: guard.missing, kept: true } };
  }

  /**
   * 整段翻译：按句切开逐句译，再拼回去。
   *
   * @param text
   * @param onProgress 每译完一句回调 { done, total, text }
   * @param kind       同 translate
   * @param termsFor   (句子) => 这句命中的术语，给 Hy-MT2 的术语模板用
   * @returns {Promise<{ ok, text?, sentences?, ms?, truncated?, reason? }>}
   */
  async translateLong(text, onProgress = null, { kind = 'batch', termsFor = null } = {}) {
    const src = String(text || '').trim();
    const bad = this._guard(src);
    if (bad) return bad;

    const clipped = src.length > MAX_CHARS;
    let parts = splitSentences(clipped ? src.slice(0, MAX_CHARS) : src);
    if (!parts.length) return { ok: false, reason: '没有可翻译的句子' };

    const tooMany = parts.length > MAX_SENTENCES;
    if (tooMany) parts = parts.slice(0, MAX_SENTENCES);
    const truncated = clipped || tooMany ? `原文过长，只翻译了前 ${parts.length} 句` : null;

    if (isLlama(this.model)) {
      /* 大模型这边逐句发 HTTP，每句各自过数字守卫、各自可能退回兜底，
         所以不走工作进程的 translateMany。 */
      const t0 = Date.now();
      const sentences = [];
      for (let i = 0; i < parts.length; i++) {
        const r = await this._llamaOne(parts[i], { kind, terms: termsFor ? termsFor(parts[i]) : [] });
        const out = r.ok ? r.text : '';
        sentences.push({ src: parts[i], out, model: r.model || null });
        onProgress?.({ done: i + 1, total: parts.length, text: out });
      }
      return {
        ok: true, ms: Date.now() - t0, text: sentences.map((x) => x.out).join(''), sentences, truncated,
      };
    }

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
      sentences: parts.map((s, i) => ({ src: s, out: outs[i] || '', model: this.model })),
      truncated,
    };
  }

  dispose() {
    try { this.child?.kill(); } catch { /* 忽略 */ }
    this.child = null;
    try { this.llama?.dispose(); } catch { /* 忽略 */ }
  }
}

module.exports = {
  Translator, MODEL_ID, MT_MODELS, FALLBACK_ORDER, LIVE_TIMEOUT, splitSentences, isLlama,
};
