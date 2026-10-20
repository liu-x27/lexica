'use strict';
/**
 * 采音：拿到音频流、重采样到 16k、一块块（2048 个采样点，128ms）送出去。
 *
 * 实时字幕页和电影字幕悬浮窗都用它，所以抽出来共用——两处各抄一份的话，
 * 采样率、清理顺序这些细节必然会漂。
 *
 * 切分（按静音切成句子）和滚动字幕的节奏原先也在这里，现在都在主进程（index.js 的 feedBlock）：
 * 流式识别要的是不切的连续音频，而自测和基准本来就在主进程里喂，两份判断只剩一份。
 *
 * 两种来源：
 *   mic     麦克风。线下课用。
 *   system  系统声音。电影、网课、录播用；Windows 上只能走 getDisplayMedia + loopback。
 */
(function (g) {
  /** 必须 16000：识别模型只吃这个采样率，重采样交给 AudioContext */
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
   * @param source  'mic' | 'system'
   * @param onPcm   每来一块调用一次，参数是 Float32Array（16k 单声道）。
   *                节奏由音频线程驱动，不受 Chromium 对不可见窗口的定时器限流影响
   * @param onLevel 电平回调（0~1），给界面画音量条
   * @returns 一个句柄，调用 stop() 收尾
   */
  async function start(source, { onPcm, onLevel = null } = {}) {
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

    let level = 0;
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
      if (onPcm) onPcm(pcm);
    };

    const src = ctx.createMediaStreamSource(stream);
    src.connect(node);

    return {
      rate: RATE,
      async stop() {
        // 最后一句的尾巴由主进程在 lec:stop 时收（切分器在那边）
        try { node.port.onmessage = null; node.disconnect(); } catch { /* 忽略 */ }
        try { src.disconnect(); } catch { /* 忽略 */ }
        try { stream.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
        try { await ctx.close(); } catch { /* 忽略 */ }
      },
    };
  }

  g.LexicaAudio = { start, openStream, RATE };
})(window);
