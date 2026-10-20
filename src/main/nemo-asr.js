'use strict';
/**
 * 流式语音识别：NVIDIA NeMo-Speech.cpp（nemo-speech serve）+ Nemotron Speech Streaming EN 0.6B。
 *
 * 为什么加它：whisper 是整段识别的模型，实时字幕只能按停顿切块、一块一块送，块和块之间互相看不见；
 * 在公开基准（MCIF 21 场 ACL 演讲）上 small 的词错率去重后还有 14.7%，大头是原地打转和接缝处的重说。
 * Nemotron 是缓存式流式模型（cache-aware FastConformer-RNNT）：音频连续推进去，编码器缓存着前 4 秒多的
 * 上下文，一边听一边吐字，句子说完（尾部静音）发定稿。同一份 21 场离线重放的词错率见 README。
 *
 * 和 whisper 的接法不同：
 *   - 不再按 VAD 切块。渲染层/自测把每一块原始音频都推过来，原样转给服务端；
 *   - 滚动字幕直接用它的临时稿事件，不用另起一个小模型隔 1.5 秒重识别一遍；
 *   - 字幕边界由 stream-captions.js 按句末标点和停顿重新拼。
 *
 * 和 asr.js、llama-server.js 一样是官方预编译 exe 当子进程（本机编不了原生模块）：
 * CUDA 版和 CPU 版各一个包（data/asr-nemo/cuda、data/asr-nemo/cpu），npm run fetch:asr -- --nemo 下载。
 * 通信是它自己的 HTTP + WebSocket（/v1/audio/transcriptions/realtime），用 Node 自带的 WebSocket，
 * 不加依赖。
 */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { freePort } = require('./asr');

/** 识别模型档位。key 与设置项 asrModel 共用一个命名空间（tiny/base/small 是 whisper 的） */
const NEMO_MODELS = {
  nemotron: {
    file: 'nemotron-speech-streaming-en-0.6b.q8_0.gguf',
    label: '流式（Nemotron，推荐）',
    streaming: true,
  },
};

const PORT_RANGE = [8800, 8830];
/** 0.6B 的 Q8 权重 700MB，冷盘读进来 + 预热，CPU 上要十几秒 */
const READY_TIMEOUT = 90_000;

/**
 * 右侧上下文（80ms 帧数），决定每一步多长：1 → 160ms，6 → 560ms，13 → 1.12s。
 * 词每走一步出一截，定稿也只在步与步之间判，所以步长直接加在字幕的时延上。
 * MCIF 21 场离线重放（同一套拼字幕规则）：
 *   步长 1.12s + 静音 800ms   WER 8.06%   英文侧 LongYAAL（CU）4.59s
 *   步长 560ms + 静音 500ms   WER 8.03%                       3.71s
 *   步长 160ms + 静音 500ms   WER 8.45%                       3.07s
 * 560ms 准确率不掉、时延少将近一秒；160ms 再快 0.6 秒，但词错率多 0.4 个点，送去翻译的字幕也更碎。
 * CPU 上 560ms 约 8 倍实时（本机 Ultra 9），1.12s 约 10 倍。
 */
const RIGHT_CONTEXT = 6;
/** 尾部静音多久算一句话说完（毫秒）。服务端默认 800；上面那组数里 500 比 800 快半秒，词错率不变 */
const ENDPOINT_MS = 500;

/** 有没有能用的 NVIDIA 显卡。CUDA_VISIBLE_DEVICES=-1（基准的 --cpu-only）时按没有算 */
function hasNvidiaGpu() {
  if (process.env.CUDA_VISIBLE_DEVICES === '-1') return false;
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 一整篇带时间的词 → 字幕段。词间停顿超过 gapSec 的地方当作定稿边界（服务端的 endpointing 就是这么判的），
 * 然后和实时一样交给 CaptionAssembler。
 * @returns [{ t0, t1, text }]（毫秒）
 */
function wordsToSegments(words, { gapSec = 0.8, maxSec = 9 } = {}) {
  const { CaptionAssembler } = require('./stream-captions');
  /* 导入录音不算时延，按长一点的规则拼：整句送去翻译译得更好（实时那套为了快，字幕切得更碎） */
  const a = new CaptionAssembler({ maxSec, minSec: 2.5, holdSec: 5, pauseSec: 1.5 });
  const out = [];
  let group = [];
  const close = () => {
    if (!group.length) return;
    const end = Number(group[group.length - 1].end) || 0;
    out.push(...a.final({ words: group, audioSec: end + gapSec }));
    group = [];
  };
  for (const w of words) {
    if (group.length && Number(w.start) - Number(group[group.length - 1].end) >= gapSec) close();
    group.push(w);
  }
  close();
  out.push(...a.flush(words.length ? Number(words[words.length - 1].end) + gapSec : 0));
  return out.map((c) => ({ t0: c.t0, t1: c.t1, text: c.en }));  // 导入不算时延，用说话的起止
}

/** Float32 [-1,1] → little-endian PCM16，WebSocket 二进制帧就收这个 */
function toPcm16(float32) {
  const out = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return out;
}

class NemoAsr extends EventEmitter {
  /**
   * @param dir data/asr-nemo：下面是 cuda/、cpu/ 两个运行时和 models/
   * @param device 'auto' | 'cuda' | 'cpu'。auto：有 CUDA 版运行时、又有 NVIDIA 显卡就用显卡
   */
  constructor(dir, { tag = 'nemo', device = process.env.LEXICA_NEMO_DEVICE || 'auto',
    rightContext = RIGHT_CONTEXT } = {}) {
    super();
    this.dir = dir;
    this.modelDir = path.join(dir, 'models');
    this.tag = tag;
    this.device = device;
    this.rightContext = rightContext;
    this.proc = null;
    this.port = 0;
    this.model = null;
    this.backend = null;
    this.starting = null;
    this.failures = 0;
    this.disabled = false;
    this.log = '';
  }

  exeOf(backend) { return path.join(this.dir, backend, 'bin', 'nemo-speech.exe'); }

  /** 这台机器上用哪个运行时：{ backend: 'cuda'|'cpu', device: 'cuda:0'|'cpu' }，一个都没有就是 null */
  pickBackend() {
    const have = (b) => fs.existsSync(this.exeOf(b));
    const wantGpu = this.device === 'cuda' || (this.device === 'auto' && have('cuda') && hasNvidiaGpu());
    if (wantGpu && have('cuda')) return { backend: 'cuda', device: 'cuda:0' };
    if (have('cpu')) return { backend: 'cpu', device: 'cpu' };
    // 只装了 CUDA 版、却要跑 CPU：CUDA 版里也带着 CPU 后端
    if (have('cuda')) return { backend: 'cuda', device: 'cpu' };
    return null;
  }

  get runtimeInstalled() { return fs.existsSync(this.exeOf('cuda')) || fs.existsSync(this.exeOf('cpu')); }

  get available() {
    return !this.disabled && this.runtimeInstalled
      && Object.values(NEMO_MODELS).some((m) => fs.existsSync(path.join(this.modelDir, m.file)));
  }

  installedModels() {
    if (!this.runtimeInstalled) return [];
    return Object.entries(NEMO_MODELS)
      .filter(([, m]) => fs.existsSync(path.join(this.modelDir, m.file)))
      .map(([key, m]) => ({ key, ...m, engine: 'nemo' }));
  }

  get running() { return !!this.proc; }

  /* ------------------------------------------------------------ 生命周期 */

  /** 启动参数。单独拿出来是为了测试能换掉 */
  spawnArgs(modelPath, port, device) {
    return [
      'serve',
      '--asr-model', modelPath,
      '--device', device,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--no-ui',
      // 句子说完要发定稿（默认只在流结束时发一个）
      '--asr.endpointing.enable=true',
      '--asr.streaming.rnnt_right_context', String(this.rightContext),
      /* 批处理是给一台服务器同时服务很多路的：要攒 5~20ms 凑批。这里只有一路，关掉 */
      '--asr.batching.enabled=false',
    ];
  }

  get exePath() { return this.backend ? this.exeOf(this.backend) : null; }

  async start(modelKey = 'nemotron') {
    if (this.disabled) throw new Error('流式识别已停用（服务反复退出）');
    const m = NEMO_MODELS[modelKey];
    if (!m) throw new Error(`没有这个流式模型：${modelKey}`);
    const modelPath = path.join(this.modelDir, m.file);
    if (!fs.existsSync(modelPath)) throw new Error(`模型不在：${m.file}，运行 npm run fetch:asr -- --nemo`);
    if (this.starting) await this.starting.catch(() => {});
    if (this.proc && this.model === modelKey) return this.port;
    if (this.proc) this.stop();
    this.starting = this._spawn(modelKey, modelPath);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async _spawn(modelKey, modelPath) {
    const pick = this.pickBackend();
    if (!pick) throw new Error('没有安装 NeMo-Speech.cpp 运行时，运行 npm run fetch:asr -- --nemo');
    this.backend = pick.backend;
    const port = await freePort(PORT_RANGE[0], PORT_RANGE[1]);
    this.log = '';
    const exe = this.exeOf(pick.backend);
    const proc = spawn(exe, this.spawnArgs(modelPath, port, pick.device), {
      cwd: path.dirname(exe),     // CUDA 的 dll 在同目录
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        /* 给的都是本地路径，它不会去下载；万一要下，也落在我们自己的目录，不往 %LOCALAPPDATA% 里塞 */
        NEMO_SPEECH_MODEL_DIR: this.modelDir,
        NO_COLOR: '1',
      },
    });
    const keep = (d) => { this.log = (this.log + d).slice(-6000); };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    proc.once('error', (e) => keep(`\n无法启动：${e.message}`));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.model = null;
      this.failures += 1;
      console.error(`[${this.tag}] 服务退出（code ${code}），已失败 ${this.failures} 次\n${this.log.slice(-800)}`);
      if (this.failures >= 3) this.disabled = true;
      this.emit('crashed', { code });
    });

    this.proc = proc;
    this.port = port;
    this.model = modelKey;

    const t0 = Date.now();
    while (Date.now() - t0 < READY_TIMEOUT) {
      if (this.proc !== proc) throw new Error(`nemo-speech 启动即退出：\n${this.log.slice(-800)}`);
      // /ready 在模型载完、预热完之前回 503
      const ready = await this._get('/ready', 2000)
        .then((r) => r.status === 200 && /"ready"\s*:\s*true/.test(r.text), () => false);
      if (ready) {
        console.log(`[${this.tag}] 就绪：${NEMO_MODELS[modelKey].file}，${pick.backend} 版 --device ${pick.device}，`
          + `端口 ${port}，分块 ${((this.rightContext + 1) * 0.08).toFixed(2)}s，${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return port;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    this.stop();
    throw new Error(`nemo-speech 启动超时：\n${this.log.slice(-800)}`);
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.model = null;
    if (p) {
      try { p.kill(); } catch { /* 忽略 */ }
    }
  }

  dispose() { this.stop(); }

  _get(pathname, timeout) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: pathname }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(timeout, () => req.destroy(new Error('nemo-speech 超时')));
      req.once('error', reject);
    });
  }

  /**
   * 整个文件转写（导入已有录音）。走 CLI 的 transcribe --stream：和实时字幕同一个流式解码，
   * 只是不按实时节奏喂。输出里只有整篇文字和带时间的词，没有定稿边界，
   * 所以按词间停顿（gapSec）切出「定稿」，再交给 CaptionAssembler 拼成字幕，和实时的口径一样。
   * @param file 16k 单声道 WAV
   * @returns {Promise<{ segments: Array<{t0,t1,text}>, text: string }>}
   */
  transcribeFile(file, { modelKey = 'nemotron', gapSec = 0.8, onProgress = null } = {}) {
    return new Promise((resolve, reject) => {
      const m = NEMO_MODELS[modelKey];
      const pick = this.pickBackend();
      if (!m || !pick) return reject(new Error('没有安装 NeMo-Speech.cpp 运行时或模型'));
      const modelPath = path.join(this.modelDir, m.file);
      if (!fs.existsSync(modelPath)) return reject(new Error(`模型不在：${m.file}`));
      const out = `${file}.nemo.json`;
      const exe = this.exeOf(pick.backend);
      const proc = spawn(exe, ['transcribe', file, '--model', modelPath, '--device', pick.device,
        '--stream', '--endpointing', '-f', 'json', '-o', out, '--force',
        '--asr.streaming.rnnt_right_context', String(this.rightContext)], {
        cwd: path.dirname(exe), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, NEMO_SPEECH_MODEL_DIR: this.modelDir, NO_COLOR: '1' },
      });
      let log = '';
      const keep = (d) => { log = (log + d).slice(-4000); };
      proc.stdout.on('data', keep);
      proc.stderr.on('data', keep);
      if (onProgress) onProgress(0);
      proc.once('error', reject);
      proc.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`转写失败（code ${code}）：${log.slice(-400)}`));
        try {
          const j = JSON.parse(fs.readFileSync(out, 'utf8'));
          fs.rmSync(out, { force: true });
          const segments = wordsToSegments(j.words || [], { gapSec, maxSec: 9 });
          if (onProgress) onProgress(100);
          return resolve({ segments, text: segments.map((s) => s.text).join(' ') });
        } catch (e) {
          return reject(new Error(`读不出转写结果：${e.message}`));
        }
      });
    });
  }

  /**
   * 开一路流式识别（一节课一路）。
   * @param endpointMs 尾部静音多久发定稿
   * @param boost      要增强的词（术语表的英文），[{ phrases: [...], boost: N }]，缓存式 RNNT 一般给 2~3
   */
  async openStream({ endpointMs = ENDPOINT_MS, boost = [] } = {}) {
    if (!this.proc) throw new Error('流式识别服务没有运行');
    const s = new NemoStream(`ws://127.0.0.1:${this.port}/v1/audio/transcriptions/realtime`, {
      sample_rate: 16000,
      automatic_punctuation: true,
      word_timestamps: true,
      endpointing_ms: endpointMs,
      ...(boost.length ? { speech_contexts: boost } : {}),
    }, { tag: this.tag, chunkSec: (this.rightContext + 1) * 0.08 });
    await s.open();
    return s;
  }
}

/**
 * 一路流：推音频进去，吐 'partial' { text, audioSec } 和 'final' { text, words, audioSec }。
 * text 是上一个定稿之后累计的临时稿（服务端发的是增量，这里拼起来）；audioSec 是服务端已经处理到的位置。
 * 出错或者连接意外断开发 'error'。
 */
class NemoStream extends EventEmitter {
  constructor(url, session, { tag = 'nemo', chunkSec = 1.12 } = {}) {
    super();
    this.url = url;
    this.session = session;
    this.tag = tag;
    this.chunkSec = chunkSec;
    this.ws = null;
    this.partialText = '';
    this.pushedSamples = 0;
    this.audioSec = 0;
    this.closed = false;
    this.failed = false;
    this.finishing = null;
  }

  /** 出错只报一次：连接断开时 onerror 和 onclose 会接连来，index.js 只该换一次 whisper */
  _fail(err) {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.emit('error', err);
  }

  /** 推进去了多少、服务端处理到了哪，差值就是积压（秒） */
  get lagSec() { return this.pushedSamples / 16000 - this.audioSec; }

  open(timeout = 10_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { this._shut(); reject(err); } else resolve();
      };
      const timer = setTimeout(() => done(new Error('连不上流式识别服务（超时）')), timeout);
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        done(e);
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')); } catch { return; }
        if (m.type === 'session.created') {
          ws.send(JSON.stringify({ type: 'session.update', session: this.session }));
        } else if (m.type === 'session.updated') {
          done();
        } else if (m.type === 'error') {
          const err = new Error(`流式识别报错：${m.error?.message || JSON.stringify(m).slice(0, 200)}`);
          if (!settled) done(err); else this._fail(err);
        } else {
          this._event(m);
        }
      };
      ws.onerror = () => {
        const err = new Error('流式识别连接出错');
        if (!settled) done(err); else this._fail(err);
      };
      ws.onclose = () => {
        if (!settled) done(new Error('流式识别连接被关闭'));
        else if (!this.finishing) this._fail(new Error('流式识别连接意外断开'));
        this.closed = true;
        this.emit('closed');
      };
    });
  }

  _event(m) {
    if (typeof m.audio_processed === 'number') this.audioSec = Math.max(this.audioSec, m.audio_processed);
    if (m.type === 'conversation.item.input_audio_transcription.delta') {
      /* 服务端在临时稿延续上一版时只发新增的部分（RNNT 贪心解码只增不改，实测一直是这样）；
         延续不上时发整句。分不出来，就按增量拼——定稿来了会整句覆盖 */
      this.partialText += m.delta || '';
      this.emit('partial', { text: this.partialText, audioSec: this.audioSec });
    } else if (m.type === 'conversation.item.input_audio_transcription.completed') {
      this.partialText = '';
      this.emit('final', {
        text: String(m.transcript || '').trim(),
        words: Array.isArray(m.words) ? m.words : [],
        audioSec: this.audioSec,
      });
    } else if (m.type === 'input_audio_buffer.committed') {
      this.emit('committed');
    }
  }

  /** 推一块 16k 单声道 Float32 音频 */
  push(float32) {
    if (this.closed || !this.ws || this.ws.readyState !== 1 || this.finishing) return false;
    this.ws.send(toPcm16(float32));
    this.pushedSamples += float32.length;
    return true;
  }

  /**
   * 收尾：告诉服务端音频完了，等它把最后一句的定稿发回来。
   * 积压着的音频要先处理完，所以等待时间按积压量放宽。
   */
  finish(timeout = 20_000) {
    if (this.finishing) return this.finishing;
    if (this.closed || !this.ws || this.ws.readyState !== 1) return Promise.resolve();
    this.finishing = new Promise((resolve) => {
      const wait = timeout + Math.max(0, this.lagSec) * 1000;
      const timer = setTimeout(() => {
        console.warn(`[${this.tag}] 收尾等了 ${(wait / 1000).toFixed(0)}s 没等到最后的定稿，放弃`);
        resolve();
      }, wait);
      const end = () => { clearTimeout(timer); resolve(); };
      this.once('committed', end);
      this.once('closed', end);
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    });
    return this.finishing;
  }

  close() {
    this.closed = true;
    this._shut();
  }

  _shut() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch { /* 忽略 */ }
    }
  }
}

module.exports = {
  NemoAsr, NemoStream, NEMO_MODELS, toPcm16, wordsToSegments, hasNvidiaGpu, RIGHT_CONTEXT, ENDPOINT_MS,
};
