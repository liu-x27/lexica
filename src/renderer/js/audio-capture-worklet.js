/**
 * 采音用的 AudioWorklet。
 *
 * 只做一件事：把 128 采样一帧的输入攒成大块，丢给主线程。
 * 静音切分与 IPC 都在主线程做——放在这里的话，切分器的状态
 * 就跟音频线程绑死了，调参和写测试都不方便。
 *
 * 用 AudioWorklet 而不是已废弃的 ScriptProcessorNode：后者跑在主线程上，
 * 界面一忙（比如正在重绘一屏字幕）就会丢采样，而丢采样是听不出来的静默故障。
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // 攒到这么多采样再发一次。太小会让 IPC 过于频繁，太大会拖慢切分判定
    this.blockSize = opts.blockSize || 2048;
    this.buf = new Float32Array(this.blockSize);
    this.at = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    // 没有输入（设备被拔掉、或者轨道被静音）时保持节点存活，别结束处理
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.buf[this.at] = ch[i];
      this.at += 1;
      if (this.at >= this.blockSize) {
        // 转移所有权，避免每块都复制一次
        const out = this.buf;
        this.buf = new Float32Array(this.blockSize);
        this.at = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('lexica-capture', CaptureProcessor);
