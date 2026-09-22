'use strict';
/**
 * 采音：拿到音频流、重采样到 16k、按静音切段。
 *
 * 实时字幕页和电影字幕悬浮窗都用它，所以抽出来共用——两处各抄一份的话，
 * 采样率、VAD 参数、清理顺序这些细节必然会漂。
 *
 * 三种来源：
 *   mic     麦克风。线下课用。
 *   system  系统声音。电影、网课、录播用；Windows 上只能走 getDisplayMedia + loopback。
 */
(function (g) {
  const { VadChunker } = g.LexicaVad;

  /** 必须 16000：whisper 只吃这个采样率，重采样交给 AudioContext */
  const RATE = 16000;

  async function openStream(source) {
    if (source === 'system') {
      /* Windows 上抓系统输出只能走 getDisplayMedia 的 loopback。
         主进程装了 setDisplayMediaRequestHandler 直接回 loopback，所以不弹选择窗。
         video 必须要——部分版本不给 video 就拿不到音轨；拿到后立刻把视频轨停掉。 */
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      for (const t of s.getVideoTracks()) { t.stop(); s.removeTrack(t); }
      if (!s.getAudioTracks().length) {
        throw new Error('没有取到系统声音轨。请确认共享时勾选了「共享系统音频」。');
      }
      return s;
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        // 没有回放要抵消，开了反而会削掉远处的人声
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  }

  /**
   * 开始采音。
   * @param source     'mic' | 'system'
   * @param onChunk    每切出一段调用一次，参数是 { pcm, startMs, endMs, reason }
   * @param onLevel    电平回调（0~1），给界面画音量条
   * @param maxChunkSec 单段上限，必须与主进程的 LECTURE_MAX_CHUNK_SEC 一致
   * @param silenceMs  多长静音算一句话说完
   * @param onPartial  滚动字幕用：每 partialMs 给一次「说到一半」的音频快照
   * @param partialMs  快照间隔；0 或不传 onPartial 就完全不启用
   * @returns 一个句柄，调用 stop() 收尾（会把尾巴吐出来）
   */
  async function start(source, {
    onChunk, onLevel = null, maxChunkSec = 9, silenceMs = 420,
    onPartial = null, partialMs = 0,
  } = {}) {
    const stream = await openStream(source);

    /* 直接让 AudioContext 按 16k 跑，重采样由它做——
       自己写重采样器只会多一处出错的地方。 */
    const ctx = new AudioContext({ sampleRate: RATE });
    if (ctx.sampleRate !== RATE) {
      // 极少数设备不接受指定采样率，此时必须明确报错而不是喂错采样率的音频
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      throw new Error(`系统不接受 16kHz 采样率（实际 ${ctx.sampleRate}Hz），无法识别`);
    }

    await ctx.audioWorklet.addModule('js/audio-capture-worklet.js');
    const node = new AudioWorkletNode(ctx, 'lexica-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { blockSize: 2048 },
    });

    const vad = new VadChunker({ rate: RATE, maxMs: maxChunkSec * 1000, silenceMs });
    let level = 0;
    let lastPartial = 0;
    let sentPartial = false;

    node.port.onmessage = (e) => {
      const pcm = new Float32Array(e.data);
      if (onLevel) {
        // 画音量条：取这一块的峰值就够，不必精确
        let peak = 0;
        for (let i = 0; i < pcm.length; i += 8) {
          const v = Math.abs(pcm[i]);
          if (v > peak) peak = v;
        }
        level = level * 0.7 + peak * 0.3;
        onLevel(level);
      }
      const cuts = vad.push(pcm);
      for (const cut of cuts) onChunk(cut);

      /* 滚动字幕的节奏由**音频回调**驱动，绝不能用 setTimeout。
       *
       * Chromium 会把不可见/被遮挡窗口的定时器限流到每秒一次甚至更慢——
       * 而滚动字幕最需要它的场景恰好就是「主窗口被播放器遮住」。
       * 音频线程不受这个限制，每来一块就顺手判断一次时间到没到。
       * （同一个坑在自测的音频喂入上踩过一次。） */
      if (onPartial && partialMs > 0) {
        // 刚切过段就不必再出临时稿了，正式字幕马上就到
        if (cuts.length) { lastPartial = Date.now(); sentPartial = false; return; }
        const now = Date.now();
        if (now - lastPartial >= partialMs) {
          lastPartial = now;
          const snap = vad.peek();
          // 没说话就别送：whisper 对纯静音会凭空编出句子来
          if (snap && snap.sawSpeech) {
            sentPartial = true;
            onPartial(snap);
          } else if (sentPartial) {
            /* 说着说着停了（缓冲被静音清空、或者压根没语音）。
               这时不会有定稿来覆盖临时稿，不主动撤掉的话，最后那半句
               会一直挂在屏幕上——实测尾音上 whisper 还会编出一整句
               不存在的话，就那么留着。 */
            sentPartial = false;
            onPartial(null);
          }
        }
      }
    };

    const src = ctx.createMediaStreamSource(stream);
    src.connect(node);

    return {
      rate: RATE,
      async stop() {
        try {
          // 先把尾巴吐出去再关，否则最后一句会丢
          const tail = vad.flush();
          if (tail) onChunk(tail);
        } catch { /* 忽略 */ }
        try { node.port.onmessage = null; node.disconnect(); } catch { /* 忽略 */ }
        try { src.disconnect(); } catch { /* 忽略 */ }
        try { stream.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
        try { await ctx.close(); } catch { /* 忽略 */ }
      },
    };
  }

  g.LexicaAudio = { start, openStream, RATE };
})(window);
