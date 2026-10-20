'use strict';
/**
 * 流式识别（NeMo-Speech.cpp 的 Nemotron）的输出 → 一条条字幕。
 *
 * 服务端给两种事件：临时稿（每推一块音频回一次，只增不改），和定稿（尾部静音够 endpointing_ms 时发）。
 * 定稿按停顿切，不按句子切。MCIF 上的实测（60 秒里 14 个定稿）：
 *   "What is" | "simultaneous speech translation? Simultaneous speech translation or simulst is…"
 *   "and what are the problems of the" | "current simulacity models"
 * 讲者在虚词上一停就是一个定稿，定稿末尾的句号常常不出（要等下一个词才知道这里该有标点）；
 * 反过来，一口气说下去的时候，十秒都没有一个定稿——上面第二个定稿 17.9 秒开口，28.0 秒才来，
 * 而那句 "What is simultaneous speech translation?" 的问号在 20.2 秒就已经出现在临时稿里了。
 * 每个定稿直接当一条字幕送去翻译，翻译拿到的是半句话；只等定稿，长句又要晚好几秒。
 *
 * 所以字幕在这里重新拼，两种事件都用：
 *   1. 句末标点后面又开始了下一个词（临时稿只增不改，这时句号前的字已经定了），就出到这个标点为止；
 *   2. 攒到 maxSec 秒还没出，在 maxSec 以内最靠后的句末、停顿（定稿边界）、逗号处切，都没有才硬切
 *      （一条字幕不能无限长，越长前面的词等得越久）；
 *   3. 定稿来了、停在一个够长（minSec）又不是半截（虚词、逗号）的地方，在这个停顿处出一条。
 *      停在半截上的先扣着等下文，但已经攒了 holdSec 秒的不再扣，免得一句长话拖到十几秒才出；
 *   4. 定稿之后讲者没再开口（临时稿是空的）、又过了 pauseSec 秒，攒着的出掉。
 *      只看「多久没来定稿」不行：讲者一口气说下去的时候也是很久没有定稿。
 * 从临时稿出掉的字，定稿来时按词数从定稿开头扣掉（核对过是同样的词）。
 *
 * 时间有三个：t0、t1 是这一条从第一个词开口到最后一个词说完（字幕文件按它显示）；
 * at 是「出这一条的那一刻服务端已经处理了多少音频」，基准里 CU 时延按它算
 * （算力无限快时，这一条最早什么时候能出）。whisper 那边这两个是一回事——VAD 在 t1 处切下这一块、
 * 这一块就在 t1 出——流式的不是：一个长定稿切出来的第一条，可能话说完十几秒才出。
 * 定稿里带词的时间戳，用它；从临时稿出的，用这个词出现在临时稿里的位置减去 lagSec 估一个
 * （实测词总是在说出来之后约一步出现，1.12 秒一步时滞后 1.15~1.25 秒）。
 *
 * 这个文件只管拼字幕，不碰网络和进程，测试在 test/stream-captions.test.mjs。
 */

/** 停在这些词上的话是半截的。和 repeat-guard.js 用同一份 */
const { DANGLING_WORDS } = require('./repeat-guard');

const SENTENCE_MARK = /[.?!]["')\]]*$/;
/** 以句点结尾但不是句末："Dr. Smith"、"e.g. BLEU"、"Wang et al. show" */
const ABBREV = /^(dr|mr|mrs|ms|prof|st|jr|sr|vs|etc|fig|figs|eq|eqs|sec|no|al|e\.g|i\.e|cf|approx)\.$/i;
const SENTENCE_END = { test: (w) => SENTENCE_MARK.test(w) && !ABBREV.test(w.replace(/^["'(\[]+/, '')) };
const CLAUSE_END = /[,;:]["')\]]*$/;

const keyOf = (raw) => String(raw).toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** 一个词停在半截上：逗号、连字符、省略号收尾，或者本身是虚词 */
function dangling(word) {
  if (!word) return false;
  if (/(,|;|:|-|…|\.\.\.)$/.test(word)) return true;
  return DANGLING_WORDS.has(keyOf(word));
}

class CaptionAssembler {
  /**
   * 默认值是实时字幕用的，在 MCIF 21 场上按「时延 vs 译文质量」挑的（离线重放，opus 翻译）：
   *   minSec 2.5 / maxSec 9 / holdSec 5 / pauseSec 1.5   BLEU 30.1  chrF 24.5  中文侧 LongYAAL（CU）3.94s
   *   minSec 2   / maxSec 7 / holdSec 3                   29.9       24.2                         3.64s
   *   minSec 1.5 / maxSec 6 / holdSec 2 / pauseSec 1     29.7       24.1                         3.36s ← 默认
   * 字幕切得越碎越早出，译文差一点；最后一行在时延、BLEU 上都不输 whisper（3.43s、29.2），chrF 低 0.5。
   * 导入录音不算时延，用第一行（见 nemo-asr.js 的 wordsToSegments）。
   *
   * @param minSec   只在停顿处（不是句末）出一条时，至少攒够这么多秒
   * @param maxSec   最长一条
   * @param holdSec  停在半截上的最多扣到这么长
   * @param pauseSec 定稿之后讲者不再开口，过这么久把攒着的出掉
   * @param lagSec   词出现在临时稿里比说出来晚多少（估 t0 用），约等于服务端的步长
   */
  constructor({ minSec = 1.5, maxSec = 6, holdSec = 2, pauseSec = 1, lagSec = 0.66 } = {}) {
    Object.assign(this, { minSec, maxSec, holdSec, pauseSec, lagSec });
    /** 攒着还没出的词：{ word, start, end, eou }，秒。eou 标记某个定稿的最后一个词 */
    this.pending = [];
    /** 当前这句（上一个定稿之后）临时稿里已经说完的词：{ word, start, end }，时间是估的 */
    this.live = [];
    /** this.live 里已经出掉了几个（定稿来时要从定稿开头扣掉同样多） */
    this.liveTaken = 0;
    /** 已经出掉的那几个词的键，扣的时候核对 */
    this.liveTakenKeys = [];
    /** 临时稿最后那个还没说完的词（只用来显示） */
    this.tail = '';
    this.lastFinalAt = 0;
    this.lastT0 = 0;
  }

  /** 屏幕上的滚动字幕：攒着没出的 + 临时稿里还没出的 */
  get displayText() {
    return [...this.pending, ...this.live.slice(this.liveTaken)].map((w) => w.word)
      .concat(this.tail ? [this.tail] : []).join(' ').trim();
  }

  /**
   * 临时稿更新了（每推一块音频服务端都回一个，没有新词时文字不变）。
   * @param text     上一个定稿之后累计的临时稿
   * @param audioSec 服务端已经处理到的音频位置（秒）
   * @returns 可以出的字幕 [{ en, t0, t1, at }]（毫秒）
   */
  partial(text, audioSec) {
    const s = String(text || '').replace(/^\s+/, '');
    const toks = s.split(/\s+/).filter(Boolean);
    // 结尾没有空白，最后一个词可能只出了半截（"Sarah Bab" 下一块才补上 "i"）
    this.tail = s && !/\s$/.test(s) ? toks.pop() : '';
    const est = Math.max(0, audioSec - this.lagSec);
    for (let i = this.live.length; i < toks.length; i++) {
      this.live.push({ word: toks[i], start: est, end: est });
    }
    const out = [];
    if (this.live.length > this.liveTaken) out.push(...this._drain(audioSec, { fromFinal: false }));
    // 4. 讲者停下来了
    if (!toks.length && !this.tail && this.pending.length && audioSec - this.lastFinalAt >= this.pauseSec) {
      out.push(...this._emitPending(this.pending.length, audioSec));
    }
    return out;
  }

  /**
   * 收到一个定稿。
   * @param text     定稿文字
   * @param words    带时间的词 [{ word, start, end }]（秒）；没给的话按空格切、时间按 audioSec 估
   * @param audioSec 发这个定稿时服务端已经处理到的音频位置（秒）
   */
  final({ text = '', words = null, audioSec = 0 } = {}) {
    const est = Math.max(0, audioSec - this.lagSec);
    let ws = (words && words.length ? words : String(text).split(/\s+/).filter(Boolean)
      .map((w) => ({ word: w, start: est, end: est })))
      .map((w) => ({ word: String(w.word).trim(), start: Number(w.start) || 0, end: Number(w.end) || 0 }))
      .filter((w) => w.word);

    /* 从临时稿出掉的词，从定稿开头扣掉。临时稿只增不改，所以正常情况下逐词相同；
       万一对不上，只扣对得上的那一段（宁可多一个词，不能吞掉讲者的话） */
    let same = 0;
    while (same < this.liveTaken && same < ws.length && keyOf(ws[same].word) === this.liveTakenKeys[same]) same += 1;
    ws = ws.slice(same);

    // 两个定稿在同一个词上交接时，时间偶尔倒退一点，拼进来之后不能比前面的词早
    const floor = this.pending.length ? this.pending[this.pending.length - 1].end : this.lastT0;
    ws = ws.map((w) => ({ ...w, start: Math.max(w.start, floor), end: Math.max(w.end, w.start, floor), eou: false }));
    if (ws.length) ws[ws.length - 1].eou = true;
    this.pending.push(...ws);
    this.live = [];
    this.liveTaken = 0;
    this.liveTakenKeys = [];
    this.tail = '';
    this.lastFinalAt = Math.max(this.lastFinalAt, audioSec);
    return this._drain(audioSec, { fromFinal: true });
  }

  /** 收尾：剩下的全出（临时稿里没定稿的也算，停止时服务端会先给一个定稿，这里只是兜底） */
  flush(audioSec = 0) {
    const t = Math.max(audioSec, this.lastFinalAt);
    const out = this._emitPending(this.pending.length, t);
    const rest = this.live.slice(this.liveTaken).concat(this.tail ? [{ word: this.tail, start: t, end: t }] : []);
    if (rest.length) out.push(...this._emitWords(rest, t));
    this.live = [];
    this.liveTaken = 0;
    this.liveTakenKeys = [];
    this.tail = '';
    return out;
  }

  /* ------------------------------------------------------------------ 内部 */

  /** 候选：攒着的 + 临时稿里还没出的（按顺序） */
  _cands() { return [...this.pending, ...this.live.slice(this.liveTaken)]; }

  /** 出掉候选的前 n 个 */
  _take(n, audioSec) {
    const fromPending = Math.min(n, this.pending.length);
    const words = this.pending.splice(0, fromPending);
    const fromLive = n - fromPending;
    if (fromLive > 0) {
      const lw = this.live.slice(this.liveTaken, this.liveTaken + fromLive);
      this.liveTakenKeys.push(...lw.map((w) => keyOf(w.word)));
      this.liveTaken += fromLive;
      words.push(...lw);
    }
    return this._emitWords(words, audioSec);
  }

  _emitPending(n, audioSec) { return n ? this._emitWords(this.pending.splice(0, n), audioSec) : []; }

  _emitWords(words, audioSec) {
    const en = words.map((w) => w.word).join(' ').trim();
    if (!en) return [];
    const t0 = Math.max(this.lastT0, words[0].start);
    const t1 = Math.max(words[words.length - 1].end, t0);
    this.lastT0 = t0;
    return [{
      en,
      t0: Math.round(t0 * 1000),
      t1: Math.round(t1 * 1000),
      at: Math.round(Math.max(audioSec, t1) * 1000),
    }];
  }

  _span(c, n) { return n ? c[n - 1].end - c[0].start : 0; }

  _drain(audioSec, { fromFinal }) {
    const out = [];
    for (;;) {
      const c = this._cands();
      if (!c.length) break;
      // 1. 最后一个句末标点（临时稿里的要求后面已经开始了下一个词：它在 live 里、而 live 是说完了的词）
      let end = -1;
      for (let i = c.length - 1; i >= 0; i--) {
        if (SENTENCE_END.test(c[i].word)) { end = i; break; }
      }
      if (end >= 0) {
        out.push(...this._take(this._span(c, end + 1) > this.maxSec ? this._cutWithin(c, end + 1) : end + 1, audioSec));
        continue;
      }
      // 2. 太长了
      if (this._span(c, c.length) >= this.maxSec) {
        out.push(...this._take(this._cutWithin(c, c.length), audioSec));
        continue;
      }
      // 3. 定稿边界（只在定稿到达时判断；这时 live 已经清空，候选全是 pending）
      if (fromFinal) {
        const last = c[c.length - 1].word;
        const long = audioSec - c[0].start;
        if (long >= this.minSec && (!dangling(last) || this._span(c, c.length) >= this.holdSec)) {
          out.push(...this._take(c.length, audioSec));
        }
      }
      break;
    }
    return out;
  }

  /**
   * 候选的前 limit 个里切出不超过 maxSec 的一段，返回词数（至少 1）。
   * 优先级：句末标点 > 停顿（定稿边界）> 逗号 > 硬切，每一种都取 maxSec 以内最靠后的那个。
   */
  _cutWithin(c, limit) {
    const fits = (n) => this._span(c, n) <= this.maxSec;
    /* 切出来的这一条至少要有 minSec 长。MCIF 第一场开头 6.2 秒一口气说下来、只有句首 "Hi," 一个逗号，
       不卡这一下就切成单独一条 "Hi,"，opus 把它译成「嗨,我很高兴见到你 Hi.」 */
    const long = (n) => this._span(c, n) >= this.minSec;
    for (const ok of [
      (w) => SENTENCE_END.test(w.word),
      (w) => w.eou,
      (w) => CLAUSE_END.test(w.word),
    ]) {
      for (let i = limit - 2; i >= 0; i--) {
        if (ok(c[i]) && fits(i + 1) && long(i + 1)) return i + 1;
      }
    }
    let n = 1;
    while (n < limit && fits(n + 1)) n += 1;
    return n;
  }
}

/**
 * 送去翻译的那一份：开头大写，没有句末标点的补一个句号。
 *
 * 流式的字幕大多在停顿处切，句号要等下一个词才出：MCIF 上 84% 的字幕没有句末标点、63% 小写开头
 * （whisper 的块是 13% 和 3%——它每块都当成一句话说完）。opus 拿到这样的残句译得明显差，
 * 同一批字幕离线重译：原样送 BLEU 28.6、chrF 23.3，补成句子再送 30.1、24.5。
 * 屏幕上和转写稿里的英文不动，只改送去翻译的那一份。
 */
function closeSentence(text) {
  let t = String(text || '').trim();
  if (!t) return t;
  t = t[0].toUpperCase() + t.slice(1);
  if (!SENTENCE_MARK.test(t)) t = `${t.replace(/[,;:]+$/, '')}.`;
  return t;
}

module.exports = { CaptionAssembler, dangling, closeSentence };
