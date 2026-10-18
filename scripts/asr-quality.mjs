/**
 * 识别质量与速度的对比：按 WER（词错误率）客观打分。README 里那张
 * 「识别质量：三个可调项的实测」的表就是它跑出来的。
 *
 *   npm run eval:asr
 *
 * 要先 `npm run fetch:asr -- --all`（base 与 small 两个模型都要）。
 *
 * 测试音频 scripts/fixtures/lecture.wav 是用 Windows 自带 TTS 按下面的 REF 合成的
 * （16k 单声道），所以有参考答案可比；比真实教室干净，绝对数字会偏好，
 * 但配置之间的相对排序可信。合成时用的语音与语速没有留下记录，用本机的
 * Zira / David 重新合成出来的字节对不上，所以音频本身入库，换机器也是同一段。
 *
 * 每个配置起一个独立的 whisper-server，所有配置共用同一批 VAD 分段。
 * 识别结果过一遍和应用里一样的去重（repeat-guard.js），量的是落盘的那份；去重删了词会在行尾标出来。
 * 各配置的转写结果写到 dist/asr-quality/，方便逐句看错在哪。
 *
 * 换 whisper.cpp 构建（比如 CUDA 版）时用这几个参数核对：
 *   --bin <目录>       用这个目录里的 whisper-server.exe（模型照旧读 data/asr/models）
 *   --out <目录>       转写结果写到别处，默认 dist/asr-quality
 *   --against <目录>   和另一轮的转写逐字比对（比如 CPU 版那一轮的 --out）
 *   --only <关键词>    只跑名字里带这个词的配置，比如 --only 默认
 * 服务的启动日志存成 <配置>.server.log，里面能看出它实际用的是 CPU 还是 CUDA。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASR = path.join(ROOT, 'data', 'asr');
const WAV = path.join(ROOT, 'scripts', 'fixtures', 'lecture.wav');
const PORT = 8802;
const require = createRequire(import.meta.url);
const { VadChunker } = require('../src/main/vad-chunker.js');
const { collapseRepeats, trimSeamRepeat } = require('../src/main/repeat-guard.js');

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const BIN = arg('--bin') ? path.resolve(arg('--bin')) : ASR;
const OUT = arg('--out') ? path.resolve(arg('--out')) : path.join(ROOT, 'dist', 'asr-quality');
const AGAINST = arg('--against') ? path.resolve(arg('--against')) : null;
const ONLY = arg('--only');

const MODELS = { base: 'ggml-base.en-q5_1.bin', small: 'ggml-small.en-q5_1.bin' };
const missing = [path.join(BIN, 'whisper-server.exe'), ...Object.values(MODELS).map((m) => path.join(ASR, 'models', m))]
  .filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error(`缺少识别组件：\n  ${missing.map((f) => path.relative(ROOT, f)).join('\n  ')}\n`
              + '先运行 npm run fetch:asr -- --all');
  process.exit(1);
}

/** 合成音频时用的原文，作为参考答案 */
const REF = `Today we will discuss the fundamentals of reinforcement learning. The agent interacts with an
environment and receives a scalar reward signal at each time step. Our goal is to learn a policy that
maximizes the expected cumulative discounted reward. Recall from last lecture that the value function
satisfies the Bellman equation. In practice, we approximate the value function with a neural network,
and we train it using temporal difference learning. A key difficulty is that the targets are
non-stationary, because they depend on the current parameters. Deep Q networks address this with a
target network and a replay buffer. The replay buffer breaks the correlation between consecutive
samples, which stabilizes training considerably. Next week we will move on to policy gradient methods,
including the actor critic family.`;

const norm = (s) => String(s).toLowerCase()
  .replace(/[^a-z0-9'\s-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** 词级编辑距离 → WER */
function wer(ref, hyp) {
  const r = norm(ref).split(' ');
  const h = norm(hyp).split(' ');
  const d = Array.from({ length: r.length + 1 }, (_, i) => {
    const row = new Array(h.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
    }
  }
  return { wer: d[r.length][h.length] / r.length, errs: d[r.length][h.length], words: r.length };
}

function readWav(f) {
  const b = fs.readFileSync(f);
  let pos = 12; let off = -1; let len = 0; let rate = 16000;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const sz = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(pos + 12);
    else if (id === 'data') { off = pos + 8; len = sz; }
    pos += 8 + sz + (sz % 2);
  }
  const n = len / 2;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = b.readInt16LE(off + i * 2) / 32768;
  return { audio: a, rate };
}

function wrapWav(f32, rate) {
  const pcm = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f32[i])) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function post(wav, extra = {}) {
  return new Promise((resolve, reject) => {
    const B = '----q';
    const parts = [
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n`
        + 'Content-Type: audio/wav\r\n\r\n'),
      wav,
    ];
    const fields = { response_format: 'json', ...extra };
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`\r\n--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`));
    }
    parts.push(Buffer.from(`\r\n--${B}--\r\n`));
    const body = Buffer.concat(parts);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/inference', method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${B}`, 'content-length': body.length },
    }, (r) => {
      const c = [];
      r.on('data', (x) => c.push(x));
      r.on('end', () => {
        const s = Buffer.concat(c).toString();
        try { resolve(JSON.parse(s)); } catch { resolve({ text: s }); }
      });
    });
    req.setTimeout(180000, () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    req.end(body);
  });
}

const { audio, rate } = readWav(WAV);

/** 用真实的切分器切好，所有配置共用同一批分段，可比 */
function cutAll(maxSec) {
  const vad = new VadChunker({ rate, maxMs: maxSec * 1000 });
  const step = Math.round(rate * 0.1);
  const out = [];
  for (let i = 0; i < audio.length; i += step) {
    out.push(...vad.push(audio.subarray(i, Math.min(i + step, audio.length))));
  }
  const t = vad.flush();
  if (t) out.push(t);
  return out;
}

const DOMAIN_PROMPT = 'Lecture on reinforcement learning: policy, value function, Bellman equation, '
  + 'temporal difference learning, non-stationary targets, Deep Q networks, replay buffer, '
  + 'policy gradient, actor critic, neural network, gradient descent.';

const CONFIGS = [
  { name: 'base 贪心', model: 'base', args: ['-bo', '1', '-bs', '1'] },
  { name: 'base + beam5', model: 'base', args: ['-bo', '5', '-bs', '5'] },
  { name: 'base + 领域提示词', model: 'base', args: ['-bo', '1', '-bs', '1'], prompt: DOMAIN_PROMPT },
  { name: 'base + beam5 + 提示词', model: 'base', args: ['-bo', '5', '-bs', '5'], prompt: DOMAIN_PROMPT },
  { name: 'small 贪心', model: 'small', args: ['-bo', '1', '-bs', '1'] },
  { name: 'small + 提示词', model: 'small', args: ['-bo', '1', '-bs', '1'], prompt: DOMAIN_PROMPT },
  { name: 'small + beam5 + 提示词（默认）', model: 'small', args: ['-bo', '5', '-bs', '5'], prompt: DOMAIN_PROMPT },
];

const MAXSEC = 9;
const chunks = cutAll(MAXSEC);
const audioSec = audio.length / rate;
const ac = Math.max(256, Math.min(1500, Math.ceil(MAXSEC * 49 * 1.1)));
fs.mkdirSync(OUT, { recursive: true });

console.log(`音频 ${audioSec.toFixed(1)}s，切成 ${chunks.length} 段，audio-ctx ${ac}`);
console.log(`参考答案 ${norm(REF).split(' ').length} 词`);
if (BIN !== ASR) console.log(`whisper 构建：${BIN}`);
console.log('\n  配置                        WER      错词   最慢段   实时倍率  判定');

/**
 * 从服务的启动日志里看它实际用的是什么后端。CUDA 版找不到能用的显卡时会悄悄退回 CPU，
 * 只看速度分不清，要看这两行：
 *   whisper_backend_init_gpu: using CUDA0 backend   （或者 no GPU found）
 *   ggml_cuda_init: … Device 0: NVIDIA …, compute capability 12.0
 */
function backendOf(log) {
  const gpu = log.match(/whisper_backend_init_gpu: using (\S+) backend/);
  if (!gpu) return /no GPU found/.test(log) ? 'CPU（日志：no GPU found）' : 'CPU';
  const dev = log.match(/Device \d+: ([^\n,]+), compute capability ([\d.]+)/);
  return `${gpu[1]}${dev ? `（${dev[1].trim()}，算力 ${dev[2]}）` : ''}`;
}

const ONLY_CONFIGS = ONLY ? CONFIGS.filter((c) => c.name.includes(ONLY)) : CONFIGS;
if (!ONLY_CONFIGS.length) { console.error(`没有名字里带「${ONLY}」的配置`); process.exit(2); }

const fileOf = (cfg) => `${cfg.name.replace(/[^\w]/g, '_')}.txt`;
for (const cfg of ONLY_CONFIGS) {
  const srv = spawn(path.join(BIN, 'whisper-server.exe'), [
    '-m', path.join(ASR, 'models', MODELS[cfg.model]),
    '--host', '127.0.0.1', '--port', String(PORT),
    '-t', '12', '-ac', String(ac), ...cfg.args,
    ...(cfg.prompt ? ['--prompt', cfg.prompt, '--carry-initial-prompt'] : []),
  ], { cwd: BIN, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  const keep = (d) => { log += d; };
  srv.stdout.on('data', keep);
  srv.stderr.on('data', keep);

  try {
    let up = false;
    // CUDA 版第一次在新显卡上要把 PTX 现编成机器码，可能要好几分钟，等久一点
    for (let i = 0; i < 2000 && !up; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (srv.exitCode !== null) break;
      try { await post(wrapWav(audio.subarray(0, rate), rate)); up = true; } catch { /* 还没起来 */ }
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, fileOf(cfg).replace(/\.txt$/, '.server.log')), log, 'utf8');
    if (!up) { console.log(`  ${cfg.name.padEnd(26)} 启动失败（日志见 .server.log）`); continue; }

    const texts = [];
    let total = 0;
    let slowest = 0;
    let guarded = 0;
    let prev = { text: '', endMs: -1 };
    for (const c of chunks) {
      const t = Date.now();
      const r = await post(wrapWav(c.pcm, rate));
      const ms = Date.now() - t;
      total += ms;
      slowest = Math.max(slowest, ms);
      // 和 drainLecture 一样：先折打转，首尾相接的两块再查接缝处的重说
      const loop = collapseRepeats(String(r.text || '').trim(), { seconds: c.pcm.length / rate });
      const seam = prev.endMs >= 0 && c.startMs - prev.endMs <= 500
        ? trimSeamRepeat(prev.text, loop.text) : { text: loop.text, removed: 0 };
      guarded += loop.removed + seam.removed;
      if (seam.text) prev = { text: seam.text, endMs: c.endMs };
      texts.push(seam.text);
    }
    const hyp = texts.join(' ');
    const w = wer(REF, hyp);
    const rtf = audioSec / (total / 1000);
    const ok = slowest < MAXSEC * 1000 ? (rtf > 2 ? '✓ 有余量' : '△ 勉强') : '✗ 跟不上';
    console.log(`  ${cfg.name.padEnd(26)} ${(w.wer * 100).toFixed(1).padStart(5)}%  `
              + `${String(w.errs).padStart(4)}   ${String(slowest).padStart(5)}ms  `
              + `${rtf.toFixed(2).padStart(7)}x  ${ok}  ${backendOf(log)}`
              + `${guarded ? `  去重删了 ${guarded} 词` : ''}`);
    fs.writeFileSync(path.join(OUT, fileOf(cfg)), hyp, 'utf8');
    // 最后再存一次日志：识别过程中打的（显存分配之类）也要留下
    fs.writeFileSync(path.join(OUT, fileOf(cfg).replace(/\.txt$/, '.server.log')), log, 'utf8');

    if (AGAINST) {
      const other = path.join(AGAINST, fileOf(cfg));
      if (!fs.existsSync(other)) {
        console.log(`    （${path.relative(ROOT, AGAINST)} 里没有这个配置的转写，没比）`);
      } else {
        const theirs = fs.readFileSync(other, 'utf8');
        if (theirs === hyp) console.log('    与对照那一轮逐字相同 ✓');
        else {
          let i = 0;
          while (i < hyp.length && hyp[i] === theirs[i]) i++;
          console.log(`    与对照那一轮不同 ✗，第 ${i} 个字符起：\n      本轮 …${hyp.slice(Math.max(0, i - 30), i + 50)}\n`
            + `      对照 …${theirs.slice(Math.max(0, i - 30), i + 50)}`);
        }
      }
    }
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 700));
  }
}
console.log(`\n转写结果在 ${path.relative(ROOT, OUT)}`);
