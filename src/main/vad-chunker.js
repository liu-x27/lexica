'use strict';
/**
 * 按静音边界切分音频流，供实时识别使用。
 *
 * 为什么不能按固定时长切：实测固定 5 秒切会把句子从中间剖开，
 * 识别出来就成了两个错句——
 *   段1 "...receives a scalar reward."      ← 原句被切断
 *   段2 "signal at each time step. ..."     ← 后半截成了独立句
 * 而且相邻段会重复吐同一个词（"...a policy that" / "that maximizes..."）。
 * 讲课时句子之间本来就有停顿，按停顿切就能拿到自然的句边界。
 *
 * 门限是自适应的：教室、宿舍、戴耳机的底噪差很多，写死一个值必然在某个场景失灵。
 * 做法是用最近 8 秒帧能量的低分位数当「噪声地板」，语音门限取它的若干倍。
 * 但「丢不丢这一段」不能依赖这个门限——它在退化情形下会高过语音，
 * 所以另有一个绝对能量兜底（ABSOLUTE_SILENCE），细节见 push() 里的注释。
 *
 * 这个文件要在两个环境里跑：主进程的单元测试里 require，渲染层里当普通脚本加载。
 */

const FRAME_MS = 20;

/* 绝对静音判据：低于这个帧能量就认为没人说话，与自适应门限无关。
   自适应门限会在退化情形下高过语音，需要一个不依赖它的兜底。 */
const ABSOLUTE_SILENCE = 0.01;

/** 一帧的均方根能量 */
function frameRms(buf, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

class VadChunker {
  /**
   * @param rate        采样率，必须与输入一致
   * @param minMs       一段最短多长才允许在静音处切（太短的片段识别质量差）
   * @param maxMs       强制切分上限：有人能一口气讲很久，不能无限攒
   * @param silenceMs   连续多久的静音算一次句间停顿
   * @param headMs      切分时在前面多留一点，避免吃掉句首的爆破音
   * @param floorFactor 语音门限 = 噪声地板 × 这个倍数
   */
  constructor({
    rate = 16000,
    minMs = 2500,
    maxMs = 12000,
    silenceMs = 420,
    headMs = 120,
    floorFactor = 3.5,
  } = {}) {
    this.rate = rate;
    this.minSamples = Math.round((minMs / 1000) * rate);
    this.maxSamples = Math.round((maxMs / 1000) * rate);
    this.silenceSamples = Math.round((silenceMs / 1000) * rate);
    this.headSamples = Math.round((headMs / 1000) * rate);
    this.frameSamples = Math.round((FRAME_MS / 1000) * rate);
    this.floorFactor = floorFactor;

    /** 待切分的缓冲。用数组分块存，避免每次 push 都整体复制 */
    this.buf = [];
    this.buffered = 0;
    /** 缓冲区第一个采样点在整场录音里的绝对位置 */
    this.baseSamples = 0;
    /** 当前尾部连续静音的采样数 */
    this.trailingSilence = 0;
    /** 这一段里有没有出现过语音——全是静音的段不该送去识别 */
    this.sawSpeech = false;

    /* 噪声地板用「最近 8 秒帧能量的低分位数」估计，而不是单向跟随。
       单向跟随有鸡生蛋问题：若只在「已判为静音」的帧上更新地板，
       那么底噪一开始就高于初始门限时（从戴耳机换到开着空调的教室），
       所有帧都会被当成语音，地板永远学不上去，于是永远切不出段——
       写测试时就是这么暴露的。分位数不依赖分类结果，一个窗口就能收敛。

       窗口 8 秒、分位 10%：讲课时 8 秒内必然有句间停顿。窗口太短或分位太高，
       连续讲话的窗口里全是语音，会把语音本身估成地板。 */
    this.rmsRing = new Float32Array(Math.max(50, Math.round(8000 / FRAME_MS)));
    this.ringAt = 0;
    this.ringFilled = 0;
    this.sinceRecalc = 0;
    this.noiseFloor = 0.002;
    this.frameRest = null;
    /** 当前缓冲里的最大帧能量，用来在绝对尺度上判断"这段到底有没有人说话" */
    this.bufferPeak = 0;
  }

  /** 取最近窗口里 10% 分位的帧能量当噪声地板，并限制它不得超过中位数的四分之一 */
  _recalcFloor() {
    const n = this.ringFilled;
    if (n < 10) return;
    const arr = Array.prototype.slice.call(this.rmsRing, 0, n).sort((a, b) => a - b);
    const p10 = arr[Math.floor(n * 0.1)] || arr[0];
    const median = arr[Math.floor(n * 0.5)] || p10;
    /* 上面那个夹子是为了兜住"窗口里压根没有静音"的退化情形：
       此时 p10 ≈ 中位数 ≈ 语音电平，不夹的话门限会高过语音，VAD 彻底失灵。 */
    this.noiseFloor = Math.min(p10, median * 0.25);
  }

  get bufferedMs() { return (this.buffered / this.rate) * 1000; }

  /** 绝对门限下界：再安静的环境也不该把电噪声当人声 */
  get threshold() { return Math.max(this.noiseFloor * this.floorFactor, 0.006); }

  /**
   * 喂入一段音频。
   * @param {Float32Array} pcm
   * @returns {Array<{pcm:Float32Array, startMs:number, endMs:number, reason:string}>} 可以送去识别的段
   */
  push(pcm) {
    if (!pcm || !pcm.length) return [];

    // 不足一帧的尾巴留到下次，保证帧对齐（否则能量统计会抖）
    let data = pcm;
    if (this.frameRest && this.frameRest.length) {
      const merged = new Float32Array(this.frameRest.length + pcm.length);
      merged.set(this.frameRest, 0);
      merged.set(pcm, this.frameRest.length);
      data = merged;
      this.frameRest = null;
    }
    const usable = Math.floor(data.length / this.frameSamples) * this.frameSamples;
    if (usable < data.length) this.frameRest = data.slice(usable);
    if (!usable) return [];
    const body = data.subarray(0, usable);

    this.buf.push(body);
    this.buffered += body.length;

    const out = [];
    for (let i = 0; i < usable; i += this.frameSamples) {
      const rms = frameRms(body, i, i + this.frameSamples);

      // 每帧都进环形缓冲，地板估计不依赖分类结果
      this.rmsRing[this.ringAt] = rms;
      this.ringAt = (this.ringAt + 1) % this.rmsRing.length;
      this.ringFilled = Math.min(this.ringFilled + 1, this.rmsRing.length);
      this.sinceRecalc += 1;
      if (this.sinceRecalc >= 25) { this.sinceRecalc = 0; this._recalcFloor(); }

      if (rms > this.bufferPeak) this.bufferPeak = rms;

      if (rms < this.threshold) {
        this.trailingSilence += this.frameSamples;
      } else {
        this.trailingSilence = 0;
        this.sawSpeech = true;
      }

      const pending = this.buffered - this.frameRestLen();

      // 攒够了、且尾部有足够长的停顿 → 在这里切
      if (this.sawSpeech && pending >= this.minSamples && this.trailingSilence >= this.silenceSamples) {
        const cut = this._take(pending);
        if (cut) out.push({ ...cut, reason: 'silence' });
        continue;
      }

      if (pending >= this.maxSamples) {
        /* 丢不丢由**绝对能量峰值**决定，不看 sawSpeech。
           sawSpeech 依赖自适应门限，而门限在"窗口里全是语音"时会退化到高过语音，
           那时 sawSpeech 恒为假——若照它判断，就会把整段讲话当静音扔掉。
           写测试时就是这么抓到的（10 秒连续语音只剩 1 段、丢了 485ms）。 */
        if (this.bufferPeak >= ABSOLUTE_SILENCE) {
          // 一直在讲话，只能强切。这种情况句子会被切断，但没有别的办法
          const cut = this._take(this.maxSamples);
          if (cut) out.push({ ...cut, reason: 'maxlen' });
        } else {
          /* 攒到上限而峰值仍在绝对静音以下：扔掉，别送去识别。
             whisper 对静音会臆造字幕（反复吐 "Thank you." 之类），
             而且一节课里的长静音会让缓冲无限涨。 */
          this._drop(this.maxSamples);
        }
      }
    }
    return out;
  }

  frameRestLen() { return this.frameRest ? this.frameRest.length : 0; }

  /**
   * 看一眼当前攒着还没切出去的音频，**不消耗**它。
   *
   * 滚动字幕要用：一句话说完才切段，所以字幕总是慢 5 秒；
   * 拿这份「说到一半」的音频先识别一遍，就能边说边出临时字幕。
   *
   * 两点必须注意：
   * - 返回的是**拷贝**。这份 buffer 要经 IPC 传走，结构化克隆会把它 detach，
   *   直接给 subarray 会让还没切出去的音频凭空消失（_take 那里踩过同样的坑）。
   * - `sawSpeech` 一定要看。whisper 对纯静音会凭空编出句子来，
   *   没有说话时压根不该去识别。
   *
   * @returns {{pcm:Float32Array, ms:number, sawSpeech:boolean}|null}
   */
  peek() {
    const n = this.buffered - this.frameRestLen();
    if (n <= 0) return null;
    const out = new Float32Array(n);
    let filled = 0;
    for (const part of this.buf) {
      if (filled >= n) break;
      const take = Math.min(part.length, n - filled);
      out.set(part.subarray(0, take), filled);
      filled += take;
    }
    return {
      pcm: out,
      ms: (n / this.rate) * 1000,
      sawSpeech: !!this.sawSpeech && this.bufferPeak >= ABSOLUTE_SILENCE,
    };
  }

  /** 丢掉前 n 个采样点（纯静音），时间轴照常推进，别让后面的字幕错位 */
  _drop(n) {
    let left = Math.min(n, this.buffered);
    this.baseSamples += left;
    this.buffered -= left;
    while (left > 0 && this.buf.length) {
      const head = this.buf[0];
      if (head.length <= left) { left -= head.length; this.buf.shift(); } else {
        this.buf[0] = head.subarray(left);
        left = 0;
      }
    }
    this.trailingSilence = 0;
    this.bufferPeak = 0;
  }

  /** 取出前 n 个采样点作为一段，剩下的留在缓冲里 */
  _take(n) {
    const want = Math.min(n, this.buffered);
    if (want <= 0) return null;

    const merged = new Float32Array(want);
    let filled = 0;
    while (filled < want && this.buf.length) {
      const head = this.buf[0];
      const need = want - filled;
      if (head.length <= need) {
        merged.set(head, filled);
        filled += head.length;
        this.buf.shift();
      } else {
        merged.set(head.subarray(0, need), filled);
        this.buf[0] = head.subarray(need);
        filled = want;
      }
    }

    const startMs = (this.baseSamples / this.rate) * 1000;
    const endMs = ((this.baseSamples + want) / this.rate) * 1000;

    /* 下一段往前借一点音频：切点落在静音里，但句首的爆破音
       常常正好压在门限附近，不留余量会被削掉。 */
    const head = Math.min(this.headSamples, want);
    if (head > 0) {
      /* 必须 slice 出一份拷贝，不能用 subarray：吐出去的这段会被
         structuredClone 转移给主进程（零拷贝），共享同一个 ArrayBuffer 的话
         留下来的这个视图会连带被 detach，下一段开头就成了一片零。 */
      this.buf.unshift(merged.slice(want - head));
      this.buffered = this.buffered - want + head;
      this.baseSamples += want - head;
    } else {
      this.buffered -= want;
      this.baseSamples += want;
    }

    this.trailingSilence = 0;
    this.sawSpeech = false;
    this.bufferPeak = 0;
    return { pcm: merged, startMs, endMs };
  }

  /** 结束时把剩下的音频吐出来。太短或全是静音的就丢掉 */
  flush({ minMs = 500 } = {}) {
    if (this.frameRest && this.frameRest.length) {
      this.buf.push(this.frameRest);
      this.buffered += this.frameRest.length;
      this.frameRest = null;
    }
    // 同样用绝对峰值判断，理由见 push() 里那段注释
    if (this.bufferPeak < ABSOLUTE_SILENCE) return null;
    if (this.bufferedMs < minMs) return null;
    const cut = this._take(this.buffered);
    return cut ? { ...cut, reason: 'flush' } : null;
  }

  reset() {
    this.buf = [];
    this.buffered = 0;
    this.baseSamples = 0;
    this.trailingSilence = 0;
    this.sawSpeech = false;
    this.frameRest = null;
    this.bufferPeak = 0;
    this.rmsRing.fill(0);
    this.ringAt = 0;
    this.ringFilled = 0;
    this.sinceRecalc = 0;
  }
}

const exported = { VadChunker, frameRms, FRAME_MS, ABSOLUTE_SILENCE };

/* 同一份文件要在两个环境里用：主进程/测试里 require，渲染层里当普通脚本加载。
   和 dict-db.js 一样的双导出写法。 */
if (typeof module !== 'undefined' && module.exports) module.exports = exported;
else if (typeof globalThis !== 'undefined') globalThis.LexicaVad = exported;
