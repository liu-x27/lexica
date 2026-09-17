#!/usr/bin/env node
/**
 * 下载语音识别所需的东西：whisper.cpp 的 Windows 预编译版 + GGML 模型。
 *
 *   node scripts/fetch-asr.mjs              下 base.en（推荐）
 *   node scripts/fetch-asr.mjs --model tiny 更快但准确率低
 *   node scripts/fetch-asr.mjs --model small 更准但跑不动实时，只适合课后转写
 *   node scripts/fetch-asr.mjs --all        三个模型都下
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
import { spawn } from 'node:child_process';
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

async function main() {
  const argv = process.argv.slice(2);
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
