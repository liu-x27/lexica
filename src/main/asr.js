'use strict';
/**
 * 语音识别引擎：whisper.cpp 常驻服务的包装。
 *
 * 为什么是常驻服务而不是每段起一次 whisper-cli：模型加载要 0.5~2 秒，
 * 而实时转写是每 5 秒来一段——每段都重新加载的话，光加载就吃掉一半预算。
 * whisper-server 把模型常驻内存，实测 base.en 在 5 秒分段上只要 2.15 秒。
 *
 * 为什么不用 Node 原生绑定：本机没有 MSVC，编不了原生模块。
 * 官方的 Windows 预编译 exe 当子进程用就行，项目里已有先例（划词的 PowerShell 助手）。
 *
 * 速度实测（Ultra 9 275HX / 12 线程 / BLAS 版 / base.en-q5_1 / 5 秒分段）：
 *   默认参数                 3.34s  1.50x
 *   + 禁温度回退 -nf         2.73s  1.83x
 *   + --audio-ctx 512        1.25s  4.00x  ← 决定性的那个参数
 * 文本三者逐字相同。audio-ctx 的取值不能随便定，见 _spawn 里的注释。
 *
 * 质量实测（同一段 127 词的音频，按 WER 打分，脚本见 scratchpad/asr-quality.mjs）：
 *   base  贪心                4.7%   最慢段  314ms   19.3x
 *   base  + beam5             6.3%   ← beam search 对 base 反而有害
 *   base  + 领域提示词        3.1%           648ms   13.3x
 *   small 贪心                4.7%          1289ms    5.1x
 *   small + 提示词            1.6%          1628ms    3.8x
 *   small + beam5 + 提示词    0.8%          1702ms    3.7x  ← 默认用这套
 *
 * **早先「small 跑不动实时（0.62x）」的结论是错的**：那是用 whisper-cli
 * 每段重载模型、且没有 audio-ctx 时测的。常驻服务 + audio-ctx 之后它有 3.7 倍余量。
 * 领域提示词是单项收益最大的一项（错词 6 → 2），成本只有几百毫秒。
 *
 * 另外分段不能按固定时长切（会把句子剖开），交给 vad-chunker.js 按静音切。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

/** 识别模型档位。key 与设置项 asrModel 对应 */
const ASR_MODELS = {
  tiny: { file: 'ggml-tiny.en-q5_1.bin', label: '最快（tiny）', realtime: true, beam: 1 },
  base: { file: 'ggml-base.en-q5_1.bin', label: '均衡（base）', realtime: true, beam: 1 },
  /* small 也能实时：3.7 倍余量、WER 0.8%。
     beam search 只在 small 上有正收益（1.6% → 0.8%），base 上反而变差（4.7% → 6.3%），
     所以每档各自带自己的 beam 设置。 */
  small: { file: 'ggml-small.en-q5_1.bin', label: '最准（small，推荐）', realtime: true, beam: 5 },
};

const PORT_RANGE = [8710, 8760];
const READY_TIMEOUT = 40000;

/** 16-bit PCM 裹上 WAV 头。whisper-server 要完整 WAV，不收裸 PCM */
function wrapWav(pcm16, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm16.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);   // PCM
  h.writeUInt16LE(1, 22);   // 单声道
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([h, pcm16]);
}

/** Float32 [-1,1] → 16-bit PCM */
function floatToPcm16(float32) {
  const out = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return out;
}

/** 找一个空闲端口。whisper-server 不支持绑 :0，只能自己探 */
function freePort(from, to) {
  return new Promise((resolve, reject) => {
    let p = from;
    const tryOne = () => {
      if (p > to) return reject(new Error(`${from}-${to} 之间没有空闲端口`));
      const srv = net.createServer();
      srv.once('error', () => { p += 1; tryOne(); });
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryOne();
  });
}

class AsrEngine extends EventEmitter {
  /**
   * @param dir data/asr 目录
   * @param maxChunkSec 单段音频上限（秒）。必须与 VadChunker 的 maxMs 一致——
   *        它决定 --audio-ctx 取多大，超出会静默截断（见 _spawn 的注释）。
   */
  constructor(dir, { maxChunkSec = 9 } = {}) {
    super();
    this.dir = dir;
    this.maxChunkSec = maxChunkSec;
    this.modelDir = path.join(dir, 'models');
    this.proc = null;
    this.port = 0;
    this.model = null;
    this.starting = null;
    this.disabled = false;
    this.failures = 0;
  }

  get exePath() { return path.join(this.dir, 'whisper-server.exe'); }

  get cliPath() { return path.join(this.dir, 'whisper-cli.exe'); }

  /** 运行时和至少一个模型都在，才算可用 */
  get available() {
    if (!fs.existsSync(this.exePath)) return false;
    return Object.values(ASR_MODELS).some((m) => fs.existsSync(path.join(this.modelDir, m.file)));
  }

  installedModels() {
    return Object.entries(ASR_MODELS)
      .filter(([, m]) => fs.existsSync(path.join(this.modelDir, m.file)))
      .map(([key, m]) => ({ key, ...m }));
  }

  status() {
    return {
      available: this.available,
      running: !!this.proc,
      model: this.model,
      prompt: this.prompt,
      models: this.installedModels(),
      disabled: this.disabled,
      dir: this.dir,
    };
  }

  /* ------------------------------------------------------------ 生命周期 */

  /**
   * 拉起常驻服务。重复调用幂等；换模型会先停掉再起。
   * @param modelKey tiny | base | small
   */
  async start(modelKey = 'base', { prompt = '' } = {}) {
    if (this.disabled) throw new Error('语音识别已停用（服务反复退出）');
    if (!this.available) throw new Error('没有安装语音识别组件，请先运行 npm run fetch:asr');

    const want = String(prompt || '').trim().slice(0, 900);
    /* 提示词变了也要重启：--prompt 是服务级参数，不能按请求传。
       每节课设一次，重启一次两三秒，可以接受。 */
    if (this.proc && this.model === modelKey && this.prompt === want) return this.port;
    if (this.starting) await this.starting.catch(() => {});
    if (this.proc && (this.model !== modelKey || this.prompt !== want)) this.stop();
    if (this.proc) return this.port;

    this.starting = this._spawn(modelKey, want);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async _spawn(modelKey, prompt = '') {
    const m = ASR_MODELS[modelKey] || ASR_MODELS.base;
    const modelPath = path.join(this.modelDir, m.file);
    if (!fs.existsSync(modelPath)) {
      throw new Error(`模型不在：${m.file}，运行 npm run fetch:asr -- --model ${modelKey}`);
    }

    const port = await freePort(PORT_RANGE[0], PORT_RANGE[1]);
    /* 线程数留两个核给翻译进程和界面。识别是 CPU 密集的，
       给满反而会和翻译抢核，两边都变慢。 */
    const threads = Math.max(4, Math.min(12, os.cpus().length - 2));

    /* --audio-ctx 是这个功能能不能用的关键参数。
       whisper 的编码器窗口固定 30 秒（1500 帧），短音频也按满窗算，白付一大笔开销。
       缩小它在 5 秒分段上实测把 1.50x 提到 4.00x，文本逐字相同。

       但它**不能随便设小**：实测 ac=512 只覆盖约 10.5 秒，喂 14 秒音频时
       不只是丢掉尾巴，而是退化成重复循环（"The agent interacts with..." 反复吐）。
       所以按「约 49 帧/秒」的实测比例从分段上限推出来，再留一成余量，
       并且夹在 [256, 1500]——1500 就是满窗，等于不限制。 */
    const audioCtx = Math.max(256, Math.min(1500, Math.ceil(this.maxChunkSec * 49 * 1.1)));

    /* beam size 按档位给，不是一刀切：实测 beam5 让 small 的 WER 从 1.6% 降到 0.8%，
       但让 base 从 4.7% 涨到 6.3%——小模型的候选序列本来就不可靠，
       扩大搜索反而更容易选到错的。 */
    const beam = m.beam || 1;

    const args = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-t', String(threads),
      '-bo', String(beam), '-bs', String(beam),
      '-ac', String(audioCtx),
      /* 温度回退保留（不加 -nf）：配了 audio-ctx 之后它几乎不花钱
         （实测 4.00x vs 禁用的 3.85x），而教室噪声下重试一次能救回一段。 */
    ];

    /* 领域提示词：单项收益最大的一项（base 4.7%→3.1%，small 4.7%→1.6%）。
       whisper 会把它当已经转写过的上文，于是更倾向于输出里面出现过的写法——
       课程名 + 术语列表能把 "twinning" 这种同音错词拉回 "training"。
       carry-initial-prompt 让它对每一段都生效，而不是只有第一段。 */
    if (prompt) args.push('--prompt', prompt, '--carry-initial-prompt');

    const proc = spawn(this.exePath, args, {
      cwd: this.dir,          // dll 在同目录，必须让它找得到
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let log = '';
    const keep = (d) => { log = (log + d).slice(-4000); };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);

    proc.on('exit', (code) => {
      const wasRunning = this.proc === proc;
      if (wasRunning) {
        this.proc = null;
        this.model = null;
      }
      if (code !== 0 && wasRunning) {
        this.failures += 1;
        console.error(`[asr] 服务退出（code ${code}），已失败 ${this.failures} 次\n${log.slice(-800)}`);
        if (this.failures >= 3) {
          this.disabled = true;
          console.error('[asr] 反复退出，已停用');
        }
        this.emit('crashed', { code });
      }
    });
    proc.once('error', (e) => console.error('[asr] 无法启动：', e.message));

    this.proc = proc;
    this.model = modelKey;
    this.prompt = prompt;
    this.port = port;

    // 等到真能应答再返回：模型加载要几秒，这期间 POST 会连不上
    const t0 = Date.now();
    const probe = wrapWav(floatToPcm16(new Float32Array(8000))); // 0.5 秒静音
    while (Date.now() - t0 < READY_TIMEOUT) {
      if (!this.proc) throw new Error(`服务启动即退出：\n${log.slice(-600)}`);
      try {
        await this._post(probe, 'json');
        console.log(`[asr] ${m.label} 就绪，端口 ${port}，${threads} 线程，beam ${beam}，`
                  + `audio-ctx ${audioCtx}（覆盖约 ${(audioCtx / 49).toFixed(0)}s）`
                  + `${prompt ? `，提示词 ${prompt.length} 字` : ''}，`
                  + `${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return port;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    this.stop();
    throw new Error(`语音识别服务启动超时：\n${log.slice(-600)}`);
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.model = null;
    this.prompt = '';
    if (p) {
      try { p.kill(); } catch { /* 忽略 */ }
    }
  }

  /* -------------------------------------------------------------- 识别 */

  _post(wav, format = 'verbose_json', timeout = 60000) {
    return new Promise((resolve, reject) => {
      const B = '----lexica-asr-boundary';
      const body = Buffer.concat([
        Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="chunk.wav"\r\n`
                  + 'Content-Type: audio/wav\r\n\r\n'),
        wav,
        Buffer.from(`\r\n--${B}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\n`
                  + `${format}\r\n--${B}--\r\n`),
      ]);

      const req = http.request({
        host: '127.0.0.1',
        port: this.port,
        path: '/inference',
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${B}`,
          'content-length': body.length,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}：${text.slice(0, 200)}`));
          }
          if (format === 'json' || format === 'verbose_json') {
            try { return resolve(JSON.parse(text)); } catch {
              return reject(new Error(`返回不是 JSON：${text.slice(0, 200)}`));
            }
          }
          return resolve({ text });
        });
      });
      req.setTimeout(timeout, () => req.destroy(new Error('识别超时')));
      req.once('error', reject);
      req.end(body);
    });
  }

  /**
   * 识别一段音频。
   * @param {Float32Array|Buffer} audio Float32（[-1,1]）或已是 16-bit PCM 的 Buffer
   * @param {number} rate 采样率，必须是 16000
   * @param {number} baseMs 这段在整场录音里的起始毫秒，用来把段内时间换成绝对时间
   * @returns {Promise<{text:string, segments:Array<{t0:number,t1:number,text:string}>}>}
   */
  async transcribe(audio, { rate = 16000, baseMs = 0 } = {}) {
    if (!this.proc) throw new Error('语音识别服务没有运行');
    const pcm = Buffer.isBuffer(audio) ? audio : floatToPcm16(audio);

    /* 超过 audio-ctx 覆盖范围会被静默截断、甚至退化成重复循环，
       所以宁可在这里吵一声——切分器不该送来这么长的段。 */
    const sec = pcm.length / 2 / rate;
    if (sec > this.maxChunkSec + 0.5) {
      console.warn(`[asr] 收到 ${sec.toFixed(1)}s 的段，超过上限 ${this.maxChunkSec}s，`
                 + '尾部可能被截断——检查切分器的 maxMs 是否与 maxChunkSec 一致');
    }
    const r = await this._post(wrapWav(pcm, rate), 'verbose_json');

    /* verbose_json 里段时间有两种形状：OpenAI 风格的 start/end（秒），
       或 whisper.cpp 自己的 offsets.from/to（毫秒）。两种都认，
       别假设只有一种——换个构建号就可能变。 */
    const segs = (r.segments || []).map((s) => {
      const startMs = s.offsets ? Number(s.offsets.from)
        : (s.start != null ? Number(s.start) * 1000 : 0);
      const endMs = s.offsets ? Number(s.offsets.to)
        : (s.end != null ? Number(s.end) * 1000 : startMs);
      return { t0: baseMs + startMs, t1: baseMs + endMs, text: String(s.text || '').trim() };
    }).filter((s) => s.text);

    const text = String(r.text || segs.map((s) => s.text).join(' ')).trim();
    return {
      text,
      segments: segs.length ? segs : (text ? [{ t0: baseMs, t1: baseMs, text }] : []),
    };
  }

  /**
   * 整个文件转写（导入已有录音）。走 whisper-cli 而不是常驻服务：
   * 一次性任务不在乎加载开销，而且可以用跑不动实时的 small 模型换准确率。
   * @param file 必须已经是 16k 单声道 WAV（whisper-cli 只吃这个）
   */
  transcribeFile(file, { modelKey = 'base', prompt = '', onProgress = null } = {}) {
    return new Promise((resolve, reject) => {
      const m = ASR_MODELS[modelKey] || ASR_MODELS.base;
      const modelPath = path.join(this.modelDir, m.file);
      if (!fs.existsSync(modelPath)) return reject(new Error(`模型不在：${m.file}`));
      if (!fs.existsSync(this.cliPath)) return reject(new Error('找不到 whisper-cli.exe'));

      const threads = Math.max(4, os.cpus().length - 2);
      const outBase = `${file}.out`;
      const beam = m.beam || 1;
      const proc = spawn(this.cliPath, [
        '-m', modelPath, '-f', file,
        '-t', String(threads),
        '-bo', String(beam), '-bs', String(beam),
        ...(prompt ? ['--prompt', prompt] : []),
        '-oj', '-of', outBase,
        '-pp',
      ], { cwd: this.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      let log = '';
      const onData = (d) => {
        const s = String(d);
        log = (log + s).slice(-4000);
        const hit = s.match(/progress\s*=\s*(\d+)%/);
        if (hit && onProgress) onProgress(Number(hit[1]));
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`转写失败（code ${code}）：${log.slice(-400)}`));
        const out = `${outBase}.json`;
        try {
          const j = JSON.parse(fs.readFileSync(out, 'utf8'));
          fs.rmSync(out, { force: true });
          const segments = (j.transcription || []).map((s) => ({
            t0: Number(s.offsets && s.offsets.from) || 0,
            t1: Number(s.offsets && s.offsets.to) || 0,
            text: String(s.text || '').trim(),
          })).filter((s) => s.text);
          return resolve({ segments, text: segments.map((s) => s.text).join(' ') });
        } catch (e) {
          return reject(new Error(`读不出转写结果：${e.message}`));
        }
      });
      proc.once('error', reject);
    });
  }

  dispose() { this.stop(); }
}

module.exports = {
  AsrEngine, ASR_MODELS, wrapWav, floatToPcm16, freePort,
};
