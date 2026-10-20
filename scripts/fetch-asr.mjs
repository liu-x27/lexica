#!/usr/bin/env node
/**
 * 下载语音识别所需的东西：whisper.cpp 的 Windows 预编译版 + GGML 模型。
 *
 *   node scripts/fetch-asr.mjs              下 base.en（推荐）
 *   node scripts/fetch-asr.mjs --model tiny 更快但准确率低
 *   node scripts/fetch-asr.mjs --model small 更准但跑不动实时，只适合课后转写
 *   node scripts/fetch-asr.mjs --all        三个模型都下
 *   node scripts/fetch-asr.mjs --cuda       另下同一构建的 CUDA 12.4 版（约 643 MB）到 data/asr-cuda/，
 *                                           模型共用 data/asr/models。基准和 eval:asr 用 --asr-bin / --bin 指过去
 *   node scripts/fetch-asr.mjs --nemo       流式识别：NVIDIA NeMo-Speech.cpp 0.2.0（Apache-2.0）+ Nemotron Speech
 *                                           Streaming EN 0.6B（NVIDIA Open Model License），到 data/asr-nemo/。
 *                                           有 NVIDIA 显卡下 CUDA 版运行时（97 MB），没有下 CPU 版（5 MB）；
 *                                           --nemo-cpu / --nemo-cuda 指定，两个都要就都写。模型 667 MB
 *
 * 为什么用预编译的 exe 而不是 Node 原生模块：本机没有 MSVC，编不了原生模块
 * （见 memory: node-sqlite-instead-of-native）。而 whisper.cpp 官方发布 Windows
 * 二进制，当子进程用就行——项目里已经有先例（划词取词那个常驻 PowerShell 助手）。
 *
 * 为什么不用 transformers.js 的 ONNX Whisper：实测 10 秒分段只有 1.04x 实时，
 * 必须拉到 20-30 秒分段才跑得动，上课时延迟半分钟没法用。
 * whisper.cpp 同样的 base 模型在 5 秒分段上是 2.33x，延迟 2.2 秒。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { request, proxyUrl, verifyAgainstOrigin } from './lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(ROOT, 'data', 'asr');
const MODEL_DIR = path.join(BIN_DIR, 'models');

/* 锁定具体构建号而不是用 latest：whisper.cpp 的 vX.Y.Z 标签常常没有发布资产，
   只有 bNNNN 这种 CI 构建才带 Windows 二进制。 */
const BUILD = 'b5130';
const ZIP = 'whisper-blas-bin-x64.zip';
const ZIP_ORIGIN = `https://github.com/ggml-org/whisper.cpp/releases/download/${BUILD}/${ZIP}`;

/* BLAS 版比纯 CPU 版明显快（实测 base.en 5 秒分段 2.15s vs 2.98s），
   代价是多一个 48MB 的 libopenblas.dll，值得。 */
const MIRRORS = [
  (u) => `https://gh-proxy.com/${u}`,
  (u) => `https://ghfast.top/${u}`,
  (u) => u,
];

/** 运行时真正需要的文件。压缩包里还有 llama/SDL/测试程序，一概不要 */
const WANTED = [
  'whisper-cli.exe',
  'whisper-server.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-blas.dll',
  'libopenblas.dll',
  // ggml 按微架构分了多份 CPU 后端，运行时自己挑，必须全留
  /^ggml-cpu-.*\.dll$/,
];

const MODELS = {
  tiny: { file: 'ggml-tiny.en-q5_1.bin', mb: 31, note: '最快，准确率一般' },
  base: { file: 'ggml-base.en-q5_1.bin', mb: 57, note: '推荐：实时够快且够准' },
  small: { file: 'ggml-small.en-q5_1.bin', mb: 181, note: '最准，但跑不动实时' },
};

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const wanted = (name) => WANTED.some((w) => (typeof w === 'string' ? w === name : w.test(name)));

async function grab(url, dest, label, { origin = null } = {}) {
  if (fs.existsSync(dest) && (await fsp.stat(dest)).size > 0) {
    console.log(`  ✓ 已存在  ${label}  ${mb((await fsp.stat(dest)).size)}`);
    return dest;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const proxy = proxyUrl();
  /* 顺序是实测出来的：GitHub 大文件走本机代理最慢（55 KB/s），
     gh-proxy 能到 1.3 MB/s，见 memory: github-download-mirror */
  const cands = url.includes('github.com')
    ? [...MIRRORS.map((m) => [m(url), null]), [url, proxy]]
    : [[url, null], [url, proxy]];

  let lastErr = null;
  for (const [u, p] of cands) {
    try {
      const t0 = Date.now();
      const { res, total } = await request(u, { proxy: p });
      let got = 0;
      let tick = 0;
      res.on('data', (c) => {
        got += c.length;
        if (Date.now() - tick > 400) {
          tick = Date.now();
          const kbs = (got / 1024 / ((Date.now() - t0) / 1000)).toFixed(0);
          process.stdout.write(`\r    ${label}  ${mb(got)}/${mb(total)}  ${kbs} KB/s   `);
        }
      });
      await streamPipeline(res, fs.createWriteStream(`${dest}.part`));
      process.stdout.write(`\r${' '.repeat(74)}\r`);
      await fsp.rename(`${dest}.part`, dest);
      console.log(`  ✓ ${label}  ${mb((await fsp.stat(dest)).size)}`);

      // 走了镜像就回原站抽查，这个文件要打进应用
      if (origin && u !== url) {
        process.stdout.write('    回原站校验头/中/尾…');
        const ok = await verifyAgainstOrigin(origin, dest, proxy);
        if (ok === true) console.log(' 一致 ✓');
        else if (ok === false) {
          console.log(' 不一致 ✗');
          await fsp.rm(dest, { force: true });
          throw new Error('镜像内容与原站不一致，已删除');
        } else console.log(' 原站不可达，无法判定');
      }
      return dest;
    } catch (e) {
      lastErr = e;
      await fsp.rm(`${dest}.part`, { force: true });
    }
  }
  throw new Error(`${label} 下载失败：${lastErr?.message}`);
}

/** 用 PowerShell 的 Expand-Archive 解压，不引入第三方依赖 */
function unzip(zip, dest) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败：${err.slice(0, 300)}`))));
    ps.once('error', reject);
  });
}

/* CUDA 版：和上面 CPU 版同一个构建号，这样拿两边的转写逐字比，差别只可能来自后端。
   这个包是给 sm_50~sm_90 编的，没有 50 系（sm_120）的机器码，只带 compute_90 的 PTX，
   在 50 系显卡上靠驱动现编（第一次启动会慢），能不能跑要实测（npm run eval:asr -- --bin）。
   压缩包自带 cudart/cuBLAS 的 dll，不用装 CUDA 工具包。sha256 取自 GitHub release API。 */
const CUDA_ZIP = {
  name: 'whisper-cublas-12.4.0-bin-x64.zip',
  bytes: 674539285,
  sha256: 'af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7',
};
const CUDA_DIR = path.join(ROOT, 'data', 'asr-cuda');

async function fetchCuda() {
  const origin = `https://github.com/ggml-org/whisper.cpp/releases/download/${BUILD}/${CUDA_ZIP.name}`;
  console.log(`下载 whisper.cpp ${BUILD} 的 CUDA 12.4 版 → ${CUDA_DIR}\n`);
  if (fs.existsSync(path.join(CUDA_DIR, 'whisper-server.exe'))) {
    console.log('  ✓ 已存在（要重下就先删掉 data/asr-cuda）');
    return;
  }
  const { grabVerified } = await import('./lib/fetch-verified.mjs');
  const tmp = path.join(CUDA_DIR, `.${CUDA_ZIP.name}`);
  await grabVerified([...MIRRORS.map((m) => m(origin))], tmp, { ...CUDA_ZIP, label: CUDA_ZIP.name });
  const stage = path.join(CUDA_DIR, '.stage');
  await fsp.rm(stage, { recursive: true, force: true });
  await unzip(tmp, stage);
  let picked = 0;
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      // CUDA 版的 dll 多（ggml-cuda、cudart、cublas、cublasLt），一律留着
      if (!/^whisper-(server|cli)\.exe$/.test(e.name) && !/\.dll$/i.test(e.name)) continue;
      await fsp.copyFile(p, path.join(CUDA_DIR, e.name));
      picked++;
    }
  };
  await walk(stage);
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.rm(tmp, { force: true });
  if (!fs.existsSync(path.join(CUDA_DIR, 'whisper-server.exe'))) {
    throw new Error('解压后找不到 whisper-server.exe，压缩包结构可能变了');
  }
  console.log(`  取出 ${picked} 个文件。核对：npm run eval:asr -- --bin data/asr-cuda --against dist/asr-quality/<CPU 那一轮>`);
}

/* ---- 流式识别：NeMo-Speech.cpp ----
   运行时是 NVIDIA 官方的 Windows 预编译包（GitHub release，sha256 取自 release API 的 digest）。
   CUDA 版是 CUDA 13 编的，带 sm_120（50 系）的机器码和 cuBLAS 垫片，不用装 CUDA 工具包，要 580 以上的驱动。
   模型是 Hugging Face 上 NVIDIA 自己发的 Q8 GGUF，钉在 NeMo-Speech.cpp 0.2.0 的模型索引
   （models/index.json）指定的那个提交上，sha256 也是索引里的。文件名和 src/main/nemo-asr.js 的 NEMO_MODELS 一致。 */
const NEMO_DIR = path.join(ROOT, 'data', 'asr-nemo');
const NEMO_VERSION = 'v0.2.0';
const NEMO_RUNTIMES = {
  cuda: { name: 'nemo-speech-0.2.0-windows-x86_64-cuda.zip', bytes: 102183465,
    sha256: '9ffe5e842c39a7d3211f3b2c3b3aa1bca8c0b2455d96d961ed5f22ec5108f98d' },
  cpu: { name: 'nemo-speech-0.2.0-windows-x86_64-cpu.zip', bytes: 5528418,
    sha256: '82c80451086e86194aba9af19f800da77cd66d1c28d993d0efceffd6cdb49bb8' },
};
const NEMO_MODEL = {
  repo: 'nvidia/nemotron-speech-streaming-en-0.6b',
  revision: 'ebe59e5a817142986528bbbee5dba8db7b38ed50',
  file: 'nemotron-speech-streaming-en-0.6b.q8_0.gguf',
  bytes: 699872960,
  sha256: 'd9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d',
};

function hasNvidia() {
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function fetchNemo(argv) {
  const { grabVerified } = await import('./lib/fetch-verified.mjs');
  const picked = ['cuda', 'cpu'].filter((b) => argv.includes(`--nemo-${b}`));
  const backends = picked.length ? picked : [hasNvidia() ? 'cuda' : 'cpu'];
  console.log(`下载流式识别：NeMo-Speech.cpp ${NEMO_VERSION}（${backends.join(' + ')} 版）+ Nemotron → ${NEMO_DIR}\n`);

  for (const b of backends) {
    const z = NEMO_RUNTIMES[b];
    const dest = path.join(NEMO_DIR, b);
    if (fs.existsSync(path.join(dest, 'bin', 'nemo-speech.exe'))) {
      console.log(`  ✓ 已存在  ${b} 版运行时（要重下就先删掉 data/asr-nemo/${b}）`);
      continue;
    }
    const origin = `https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/${NEMO_VERSION}/${z.name}`;
    const zip = path.join(NEMO_DIR, '.dl', z.name);
    await grabVerified(MIRRORS.map((m) => m(origin)), zip, { ...z, label: `${z.name}（Apache-2.0）` });
    const stage = path.join(NEMO_DIR, `.stage-${b}`);
    await fsp.rm(stage, { recursive: true, force: true });
    await unzip(zip, stage);
    // 压缩包里是 nemo-speech-0.2.0-windows-x86_64-<b>/{bin,share,include,lib}，只留运行要的 bin 和许可证所在的 share
    const [top] = (await fsp.readdir(stage, { withFileTypes: true })).filter((e) => e.isDirectory());
    if (!top || !fs.existsSync(path.join(stage, top.name, 'bin', 'nemo-speech.exe'))) {
      throw new Error('解压后找不到 bin/nemo-speech.exe，压缩包结构可能变了');
    }
    await fsp.mkdir(dest, { recursive: true });
    for (const sub of ['bin', 'share']) {
      await fsp.rename(path.join(stage, top.name, sub), path.join(dest, sub));
    }
    await fsp.rm(stage, { recursive: true, force: true });
    await fsp.rm(zip, { force: true });
    console.log(`    解压到 data/asr-nemo/${b}（bin/ 和 share/licenses/）`);
  }

  const m = NEMO_MODEL;
  await grabVerified([
    `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`,
    `https://hf-mirror.com/${m.repo}/resolve/${m.revision}/${m.file}`,
  ], path.join(NEMO_DIR, 'models', m.file), { ...m, label: `${m.file}（NVIDIA Open Model License）` });

  // 跑一下，确认 exe 和它那些 dll 能起来
  for (const b of backends) {
    const exe = path.join(NEMO_DIR, b, 'bin', 'nemo-speech.exe');
    try {
      const v = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();
      console.log(`  ✓ ${b} 版：${v}`);
    } catch (e) {
      console.log(`  ✗ ${b} 版起不来：${e.message.split('\n')[0]}`);
    }
  }
  console.log('\n流式识别已就绪。设置 →「实时字幕」→ 识别模型选「流式（Nemotron）」（默认就是它）。');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--cuda')) return fetchCuda();
  if (argv.some((a) => a.startsWith('--nemo'))) return fetchNemo(argv);
  const only = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null;
  const all = argv.includes('--all');
  const picks = all ? Object.keys(MODELS) : [only && MODELS[only] ? only : 'base'];

  console.log('下载语音识别组件（whisper.cpp + GGML 模型）\n');
  console.log('  目标目录：', BIN_DIR, '\n');

  /* ---- 二进制 ---- */
  const tmpZip = path.join(BIN_DIR, '.whisper.zip');
  const cliPath = path.join(BIN_DIR, 'whisper-cli.exe');
  if (fs.existsSync(cliPath)) {
    console.log('  ✓ 已存在  whisper.cpp 运行时');
  } else {
    await grab(ZIP_ORIGIN, tmpZip, ZIP, { origin: ZIP_ORIGIN });
    const stage = path.join(BIN_DIR, '.stage');
    await fsp.rm(stage, { recursive: true, force: true });
    await unzip(tmpZip, stage);

    // 压缩包里是 Release/ 一层，把要用的平铺出来
    let picked = 0;
    let bytes = 0;
    const walk = async (dir) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(p); continue; }
        if (!wanted(e.name)) continue;
        await fsp.copyFile(p, path.join(BIN_DIR, e.name));
        bytes += (await fsp.stat(p)).size;
        picked++;
      }
    };
    await walk(stage);
    await fsp.rm(stage, { recursive: true, force: true });
    await fsp.rm(tmpZip, { force: true });
    console.log(`    取出 ${picked} 个运行时文件，${mb(bytes)}（压缩包里的 llama/SDL/测试程序已丢弃）`);

    if (!fs.existsSync(cliPath)) throw new Error('解压后找不到 whisper-cli.exe，压缩包结构可能变了');
  }

  /* ---- 模型 ---- */
  console.log('');
  const HF = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/';
  const HF2 = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
  for (const key of picks) {
    const m = MODELS[key];
    const dest = path.join(MODEL_DIR, m.file);
    try {
      await grab(HF + m.file, dest, `${m.file}（${m.note}）`);
    } catch {
      await grab(HF2 + m.file, dest, m.file);
    }
  }

  let total = 0;
  const sum = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await sum(p);
      else total += (await fsp.stat(p)).size;
    }
  };
  await sum(BIN_DIR);
  console.log(`\n语音识别已就绪，共 ${mb(total)}`);
  console.log('在「实时字幕」页即可开始。');
}

main().catch((e) => {
  console.error('\n失败：', e.message);
  process.exit(1);
});
