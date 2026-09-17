/**
 * 下载本地翻译模型（opus-mt-en-zh 量化版）。
 *
 * 单独一个脚本、不并进 npm run data：模型是可选功能，
 * 只有需要「词典查不到时机器翻译兜底」的人才下。
 *
 *   node scripts/fetch-model.mjs
 *
 * 模型放在 data/model/ 下，运行时由 transformers.js 以本地模式加载，
 * 全程不联网（env.allowRemoteModels = false）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { request, proxyUrl } from './lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Xenova/opus-mt-en-zh';
const OUT = path.join(ROOT, 'data', 'model', REPO);

/* 只下量化版权重：encoder 50MB + decoder 57MB，
   fp32 版加起来 400MB 以上，对「偶尔兜底一次」不值得。 */
const FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.json',
  'source.spm',
  'target.spm',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

const MIRRORS = [
  (f) => `https://hf-mirror.com/${REPO}/resolve/main/${f}`,
  (f) => `https://huggingface.co/${REPO}/resolve/main/${f}`,
];

const mb = (n) => (n / 1024 / 1024).toFixed(1).padStart(6) + ' MB';

async function fetchFile(rel, proxy) {
  const dest = path.join(OUT, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest) && (await fsp.stat(dest)).size > 0) {
    console.log(`  ✓ 已存在  ${rel}  ${mb((await fsp.stat(dest)).size)}`);
    return;
  }

  let lastErr = null;
  for (const make of MIRRORS) {
    for (const useProxy of [null, proxy]) {
      const url = make(rel);
      try {
        const { res, total } = await request(url, { proxy: useProxy });
        let got = 0;
        let tick = 0;
        res.on('data', (c) => {
          got += c.length;
          const now = Date.now();
          if (now - tick > 400) {
            tick = now;
            const pct = total ? ((got / total) * 100).toFixed(0) : '?';
            process.stdout.write(`\r    ${rel}  ${mb(got)} / ${mb(total)}  ${pct}%   `);
          }
        });
        await pipeline(res, fs.createWriteStream(`${dest}.part`));
        process.stdout.write('\r' + ' '.repeat(76) + '\r');
        await fsp.rename(`${dest}.part`, dest);
        console.log(`  ✓ ${rel}  ${mb((await fsp.stat(dest)).size)}`);
        return;
      } catch (e) {
        lastErr = e;
        await fsp.rm(`${dest}.part`, { force: true });
      }
    }
  }
  throw new Error(`${rel} 下载失败：${lastErr?.message}`);
}

async function main() {
  console.log('下载本地翻译模型 opus-mt-en-zh（量化版，约 110MB）\n');
  console.log('  目标目录：', OUT, '\n');
  const proxy = proxyUrl();

  for (const f of FILES) await fetchFile(f, proxy);

  let total = 0;
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await fsp.stat(p)).size;
    }
  };
  await walk(OUT);

  console.log(`\n模型就绪，共 ${mb(total)}`);
  console.log('在设置页打开「机器翻译兜底」即可启用。');
}

main().catch((e) => {
  console.error('\n下载失败：', e.message);
  process.exit(1);
});
