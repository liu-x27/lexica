#!/usr/bin/env node
/**
 * 下载 Hy-MT2 翻译模型（腾讯，Apache-2.0，官方 GGUF）和跑它用的 llama.cpp。
 *
 *   npm run fetch:mt:hymt                   7B Q4_K_M（4.6 GB）+ llama.cpp CUDA 版（约 575 MB）
 *   npm run fetch:mt:hymt -- --model 1.8b   换成 1.8B Q8_0（1.9 GB）
 *   npm run fetch:mt:hymt -- --no-llama     只下模型。机器上已有 llama.cpp 的话，
 *                                            启动前设 LEXICA_LLAMA_DIR 指过去就行
 *   npm run fetch:mt:hymt -- --cpu          llama.cpp 用纯 CPU 版（19 MB，7B 一句要好几秒）
 *   npm run fetch:mt:hymt -- --probe        只列出要下什么、多大，不下载
 *
 * 模型放 data/model/tencent/…（和 opus、NLLB 一个位置），llama.cpp 放 data/llama/。
 * 两样都不进版本库（data/ 整个在 .gitignore 里）。
 *
 * 每个文件的 sha256 都钉死在下面：模型取自 Hugging Face 的 LFS 记录，llama.cpp 取自
 * GitHub release API 的 digest。走镜像下的也一样核，核不上就删掉，不会留下被换过的文件。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { grabVerified, mb } from './lib/fetch-verified.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = path.join(ROOT, 'data', 'model');
const LLAMA_DIR = path.join(ROOT, 'data', 'llama');

/* 文件名和 src/main/hymt.js 的 HYMT_MODELS 一致；改一边记得改另一边 */
const MODELS = {
  '7b': {
    repo: 'tencent/Hy-MT2-7B-GGUF',
    file: 'Hy-MT2-7B-Q4_K_M.gguf',
    bytes: 4624648896,
    sha256: '9f96256500f3fc1ab4d64336b58f52a949a95ad7516b0c229476eef782f9f77b',
  },
  '1.8b': {
    repo: 'tencent/Hy-MT2-1.8B-GGUF',
    file: 'Hy-MT2-1.8B-Q8_0.gguf',
    bytes: 1908528192,
    sha256: '5c3fe0b1408a5ceb0143184ef247b11b579c525f4b02b060e6c851bb76fef1a4',
  },
};

/* llama.cpp 锁定构建号：hunyuan-dense 从 b6058 起支持，对话模板的修复在 b6099；
   b11190 是 2026-09-25 的构建，本机实测过。CUDA 13.4 原生支持 50 系显卡（sm_120）。 */
const LLAMA_BUILD = 'b11190';
const LLAMA_ZIPS = {
  cuda: [
    { name: `llama-${LLAMA_BUILD}-bin-win-cuda-13.4-x64.zip`, bytes: 151720791, license: 'MIT',
      sha256: 'f77b13ca74c491fa9bb9c74d1bbe22dd5b1f5f3c68fbca244e14a4b27f521db0' },
    // CUDA 运行库（cudart / cuBLAS）单独一个包，不装 CUDA 工具包也能跑
    { name: 'cudart-llama-bin-win-cuda-13.4-x64.zip', bytes: 423535356, license: 'NVIDIA 可再分发运行库',
      sha256: '738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668' },
  ],
  cpu: [
    { name: `llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`, bytes: 18574281, license: 'MIT',
      sha256: '0a1f14c164adb35a411daf4b3c061ef02e2e1f1898f5e9b1a957f6a80dfa1c41' },
  ],
};
const GH = (name) => `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${name}`;
const GH_MIRRORS = [(u) => `https://gh-proxy.com/${u}`, (u) => `https://ghfast.top/${u}`, (u) => u];

/** 用 PowerShell 的 Expand-Archive 解压，不引入第三方依赖（和 fetch-asr.mjs 一样） */
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

/** 运行时只要 llama-server 和 dll，压缩包里另外几十个命令行工具不要 */
const keepLlama = (name) => name === 'llama-server.exe' || /\.dll$/i.test(name) || /^LICENSE/i.test(name);

async function main() {
  const argv = process.argv.slice(2);
  const key = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : '7b';
  const m = MODELS[key];
  if (!m) { console.error(`--model 只认 ${Object.keys(MODELS).join(' / ')}`); process.exit(2); }
  const withLlama = !argv.includes('--no-llama');
  const zips = withLlama ? LLAMA_ZIPS[argv.includes('--cpu') ? 'cpu' : 'cuda'] : [];

  console.log('下载 Hy-MT2 翻译模型' + (withLlama ? ' + llama.cpp' : '') + '\n');
  console.log(`  ${m.file}  ${mb(m.bytes)}  ← huggingface.co/${m.repo}（Apache-2.0）`);
  for (const z of zips) console.log(`  ${z.name}  ${mb(z.bytes)}  ← github.com/ggml-org/llama.cpp ${LLAMA_BUILD}（${z.license}）`);
  const total = m.bytes + zips.reduce((s, z) => s + z.bytes, 0);
  console.log(`  合计 ${mb(total)}\n`);
  if (argv.includes('--probe')) return;

  await grabVerified([
    `https://huggingface.co/${m.repo}/resolve/main/${m.file}`,
    `https://hf-mirror.com/${m.repo}/resolve/main/${m.file}`,
  ], path.join(MODEL_DIR, m.repo, m.file), { ...m, label: m.file });

  if (withLlama) {
    if (fs.existsSync(path.join(LLAMA_DIR, 'llama-server.exe'))) {
      console.log('  ✓ 已存在  llama-server.exe（要换构建就先删掉 data/llama）');
    } else {
      const stage = path.join(LLAMA_DIR, '.stage');
      await fsp.rm(stage, { recursive: true, force: true });
      for (const z of zips) {
        const tmp = path.join(LLAMA_DIR, `.${z.name}`);
        await grabVerified(GH_MIRRORS.map((f) => f(GH(z.name))), tmp, { ...z, label: z.name });
        await unzip(tmp, stage);
        await fsp.rm(tmp, { force: true });
      }
      let picked = 0;
      const walk = async (dir) => {
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (keepLlama(e.name)) { await fsp.copyFile(p, path.join(LLAMA_DIR, e.name)); picked++; }
        }
      };
      await walk(stage);
      await fsp.rm(stage, { recursive: true, force: true });
      if (!fs.existsSync(path.join(LLAMA_DIR, 'llama-server.exe'))) {
        throw new Error('解压后找不到 llama-server.exe，压缩包结构可能变了');
      }
      console.log(`    取出 ${picked} 个运行时文件 → ${path.relative(ROOT, LLAMA_DIR)}`);
    }
  }

  console.log('\n就绪。设置 → 翻译模型里选「Hy-MT2」。');
  if (!withLlama) console.log('没下 llama.cpp：启动前设 LEXICA_LLAMA_DIR=<llama-server.exe 所在目录>。');
}

main().catch((e) => {
  console.error('\n失败：', e.message);
  process.exit(1);
});
