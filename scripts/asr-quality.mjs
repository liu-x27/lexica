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
 * 各配置的转写结果写到 dist/asr-quality/，方便逐句看错在哪。
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
const OUT = path.join(ROOT, 'dist', 'asr-quality');
const PORT = 8802;
const require = createRequire(import.meta.url);
const { VadChunker } = require('../src/main/vad-chunker.js');

const MODELS = { base: 'ggml-base.en-q5_1.bin', small: 'ggml-small.en-q5_1.bin' };
const missing = [path.join(ASR, 'whisper-server.exe'), ...Object.values(MODELS).map((m) => path.join(ASR, 'models', m))]
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
console.log(`参考答案 ${norm(REF).split(' ').length} 词\n`);
console.log('  配置                        WER      错词   最慢段   实时倍率  判定');

for (const cfg of CONFIGS) {
  const srv = spawn(path.join(ASR, 'whisper-server.exe'), [
    '-m', path.join(ASR, 'models', MODELS[cfg.model]),
    '--host', '127.0.0.1', '--port', String(PORT),
    '-t', '12', '-ac', String(ac), ...cfg.args,
    ...(cfg.prompt ? ['--prompt', cfg.prompt, '--carry-initial-prompt'] : []),
  ], { cwd: ASR, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });

  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try { await post(wrapWav(audio.subarray(0, rate), rate)); up = true; } catch { /* 还没起来 */ }
    }
    if (!up) { console.log(`  ${cfg.name.padEnd(26)} 启动失败`); continue; }

    const texts = [];
    let total = 0;
    let slowest = 0;
    for (const c of chunks) {
      const t = Date.now();
      const r = await post(wrapWav(c.pcm, rate));
      const ms = Date.now() - t;
      total += ms;
      slowest = Math.max(slowest, ms);
      texts.push(String(r.text || '').trim());
    }
    const hyp = texts.join(' ');
    const w = wer(REF, hyp);
    const rtf = audioSec / (total / 1000);
    const ok = slowest < MAXSEC * 1000 ? (rtf > 2 ? '✓ 有余量' : '△ 勉强') : '✗ 跟不上';
    console.log(`  ${cfg.name.padEnd(26)} ${(w.wer * 100).toFixed(1).padStart(5)}%  `
              + `${String(w.errs).padStart(4)}   ${String(slowest).padStart(5)}ms  `
              + `${rtf.toFixed(2).padStart(7)}x  ${ok}`);
    fs.writeFileSync(path.join(OUT, `${cfg.name.replace(/[^\w]/g, '_')}.txt`), hyp, 'utf8');
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 700));
  }
}
console.log(`\n转写结果在 ${path.relative(ROOT, OUT)}`);
