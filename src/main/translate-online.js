'use strict';
/**
 * 在线翻译（可选，默认关闭）。
 *
 * 为什么要有它：本地模型在学术文本上有几类**改错内容**的问题，不是「不通顺」——
 *   degrades accuracy from 71.2 to 63.8  → 从 71.2 降低至 638   ← 数字被改错
 *   code and checkpoints … reproduction  → 密码和检查站 … 生殖
 *   a scalar reward                      → 一笔奖金             ← 术语整个消失
 * 同样这几句走 Google 全部正确。「数字会被改错」原本是界面强制双语对照的理由。
 *
 * 但要说清楚它**不能**解决什么：实时字幕的延迟里翻译只占约 300ms，
 * 大头是等说话人停顿（约 5 秒）。换在线服务是为了质量，不是为了延迟。
 * 延迟要靠滚动字幕解决。
 *
 * ── 关于 Google 这个端点 ──
 * `translate_a/single?client=gtx` 是网页版翻译用的接口：不需要注册、不需要 key，
 * 但它**不是公开 API**——没有 SLA、随时可能改动，严格说也不在 Google 付费 API
 * 的条款内。所以：默认关闭、可随时切回本地、任何失败都自动退回本地模型。
 *
 * 一条排查记录：一开始稳定收到 HTTP 429，我以为是端点限流，其实是**请求通道选错了**。
 * 同一时刻同一个 URL，Electron 主进程的全局 fetch 给 429，而 net.fetch 和
 * node:https 都是 200。构造时必须把 net.fetch 传进来（见 fetchImpl）。
 *
 * 隐私：开启后识别出的英文（上课时就是老师讲的内容）会发给该服务。
 * 界面上必须明确写出来，且默认不开。
 */
const MAX_Q_CHARS = 1500;

/** 连续失败多少次就歇一会儿，别每句话都去撞墙 */
const FAIL_LIMIT = 3;
const COOLDOWN_MS = 60_000;

/** 缓存上限。电影字幕、上课口头语会大量重复，缓存命中就是 0ms */
const CACHE_MAX = 2000;

/** 缓存键。分隔符用转义写，别把裸控制字符留在源码里 */
const cacheKey = (provider, text) => `${provider}\u0000${text}`;

const PROVIDERS = {
  google: {
    label: 'Google（免费端点）',
    note: '不需要 key。非官方接口，没有 SLA；失败会自动退回本地模型。',
    needsKey: false,
  },
};

class OnlineTranslator {
  /**
   * @param opts.provider   目前只有 google
   * @param opts.enabled    默认关
   * @param opts.fetchImpl  请求实现。在 Electron 里**必须**传 `net.fetch`——
   *        实测同一时刻同一个 URL，主进程的全局 fetch 返回 429，
   *        而 net.fetch / node:https 都是 200。默认值只为独立跑测试用。
   */
  constructor({ provider = 'google', enabled = false, fetchImpl = null } = {}) {
    this.provider = PROVIDERS[provider] ? provider : 'google';
    this.enabled = !!enabled;
    this._fetch = fetchImpl || ((...a) => fetch(...a));
    this.cache = new Map();
    this.failures = 0;
    this.coolUntil = 0;
    this.calls = 0;
    this.hits = 0;
    this.errors = 0;
    this.lastError = null;
    this.totalMs = 0;
  }

  static providers() {
    return Object.entries(PROVIDERS).map(([key, p]) => ({ key, ...p }));
  }

  /** 能不能用。冷却期内一律当不可用，避免每句都白等一次超时 */
  get available() {
    return this.enabled && Date.now() >= this.coolUntil;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (on) this.reset();   // 用户手动打开，等于说「再试一次」
    return this.enabled;
  }

  setProvider(key) {
    if (PROVIDERS[key] && key !== this.provider) {
      this.provider = key;
      this.cache.clear();   // 换了服务，旧译文不该继续用
      this.reset();
    }
    return this.provider;
  }

  reset() {
    this.failures = 0;
    this.coolUntil = 0;
  }

  stats() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      available: this.available,
      calls: this.calls,
      cacheHits: this.hits,
      errors: this.errors,
      lastError: this.lastError,
      coolingDown: Date.now() < this.coolUntil,
      avgMs: this.calls ? Math.round(this.totalMs / this.calls) : 0,
    };
  }

  _remember(key, value) {
    if (this.cache.size >= CACHE_MAX) {
      // 先进先出就够了：命中集中在最近说过的话上
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  /**
   * 一次请求翻一段文本（可以含换行，换行会被保留）。
   *
   * @param timeoutMs 实时字幕要短（宁可退回本地也不能让字幕停住），
   *                  整段翻译可以给长一点。
   */
  async _post(text, timeoutMs) {
    const url = 'https://translate.googleapis.com/translate_a/single'
      + `?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this._fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      /* 返回结构：[[[译文片段, 原文片段, …], …], …]。
         它会按自己的规则把文本切成若干片段，拼起来才是完整译文。 */
      const segs = Array.isArray(body?.[0]) ? body[0] : null;
      if (!segs) throw new Error('返回结构不认识');
      const out = segs.map((x) => (Array.isArray(x) ? x[0] : '')).join('');
      if (!out.trim()) throw new Error('译文为空');
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  _ok(ms) {
    this.failures = 0;
    this.calls += 1;
    this.totalMs += ms;
  }

  _fail(e) {
    this.errors += 1;
    this.lastError = e.name === 'AbortError' ? '超时' : e.message;
    this.failures += 1;
    /* 连续失败就歇一分钟。断网时如果每句话都去等一次超时，
       字幕会被拖慢而不是退回本地——那比不开在线更糟。 */
    if (this.failures >= FAIL_LIMIT) this.coolUntil = Date.now() + COOLDOWN_MS;
  }

  /**
   * 单句/短文本。
   * @returns {Promise<{ok:boolean, text?:string, ms?:number, cached?:boolean, reason?:string}>}
   */
  async translate(text, { timeoutMs = 2500 } = {}) {
    const src = String(text || '').trim();
    if (!src) return { ok: false, reason: '空文本' };
    if (!this.available) return { ok: false, reason: this.enabled ? '在线翻译暂时不可用' : '未开启在线翻译' };

    const key = cacheKey(this.provider, src);
    if (this.cache.has(key)) {
      this.hits += 1;
      return { ok: true, text: this.cache.get(key), ms: 0, cached: true };
    }
    if (src.length > MAX_Q_CHARS) return { ok: false, reason: '文本过长，走整段通道' };

    const t0 = Date.now();
    try {
      const out = await this._post(src, timeoutMs);
      const ms = Date.now() - t0;
      this._ok(ms);
      this._remember(key, out);
      return { ok: true, text: out, ms };
    } catch (e) {
      this._fail(e);
      return { ok: false, reason: this.lastError };
    }
  }

  /**
   * 多句一次请求：用换行分隔。
   *
   * 实测换行会原样保留、顺序不变，所以一次往返能顶好几句（4 句 531ms）。
   * 但**不能盲信 1:1**——服务端有可能合并或拆分行。行数对不上就退回逐句，
   * 否则译文会和原文错位，那比慢更糟。
   *
   * @returns {Promise<{ok:boolean, texts?:string[], ms?:number, reason?:string}>}
   */
  async translateLines(lines, { timeoutMs = 8000 } = {}) {
    const src = (lines || []).map((x) => String(x || '').trim());
    if (!src.length) return { ok: false, reason: '没有内容' };
    if (!this.available) return { ok: false, reason: this.enabled ? '在线翻译暂时不可用' : '未开启在线翻译' };

    /* 先查缓存：命中的不必再发。缓存里有一部分时只发缺的那些，
       省下的是整整一次往返。 */
    const out = new Array(src.length).fill(null);
    const need = [];
    src.forEach((s, i) => {
      if (!s) { out[i] = ''; return; }
      const key = cacheKey(this.provider, s);
      if (this.cache.has(key)) { out[i] = this.cache.get(key); this.hits += 1; } else need.push(i);
    });
    if (!need.length) return { ok: true, texts: out, ms: 0 };

    const t0 = Date.now();
    /* 按字符数分批。URL 是 GET 参数，太长会被服务端拒；
       中文回来不算，算的是发出去的英文。 */
    const batches = [];
    let cur = [];
    let curLen = 0;
    for (const i of need) {
      const len = src[i].length + 1;
      if (cur.length && curLen + len > MAX_Q_CHARS) { batches.push(cur); cur = []; curLen = 0; }
      cur.push(i);
      curLen += len;
    }
    if (cur.length) batches.push(cur);

    for (const batch of batches) {
      const joined = batch.map((i) => src[i]).join('\n');
      let texts = null;
      try {
        const got = await this._post(joined, timeoutMs);
        const parts = got.split('\n');
        if (parts.length === batch.length) texts = parts;
        // 行数不符：说明服务端动了分行，只能逐句重来
      } catch (e) {
        this._fail(e);
        if (!this.available) return { ok: false, reason: this.lastError };
      }

      if (!texts) {
        texts = [];
        for (const i of batch) {
          const r = await this.translate(src[i], { timeoutMs });
          if (!r.ok) return { ok: false, reason: r.reason };
          texts.push(r.text);
        }
      } else {
        this._ok(Date.now() - t0);
        batch.forEach((i, k) => this._remember(cacheKey(this.provider, src[i]), texts[k]));
      }
      batch.forEach((i, k) => { out[i] = texts[k]; });
    }

    return { ok: true, texts: out, ms: Date.now() - t0 };
  }
}

module.exports = { OnlineTranslator, PROVIDERS, MAX_Q_CHARS, FAIL_LIMIT, COOLDOWN_MS };
