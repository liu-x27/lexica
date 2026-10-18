/**
 * 按 sha256 核对的下载：断点续传，几个地址按顺序试，下完核哈希，核不上就删。
 * fetch-mt-hymt.mjs（模型权重）和 fetch-bench.mjs（公开测试集）共用。
 *
 * 和 http.mjs 里 verifyAgainstOrigin 的抽查不同：这里每个文件的哈希事先钉死在脚本里
 * （Hugging Face 的 LFS 记录、GitHub release API 的 digest），整份核，
 * 所以走第三方镜像也放心——内容被换过一个字节都过不去。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { request, proxyUrl } from './http.mjs';

export const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

export async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await streamPipeline(fs.createReadStream(file, { highWaterMark: 8 << 20 }), h);
  return h.digest('hex');
}

/**
 * 下一个文件到 dest。已经在且哈希对得上就跳过。
 * @param urls  候选地址，按顺序试；每个地址先直连、再走代理（设了代理的话）
 * @param bytes 期望大小
 * @param sha256 期望哈希（小写十六进制）
 */
export async function grabVerified(urls, dest, { bytes, sha256: want, label, quiet = false }) {
  const say = quiet ? () => {} : (s) => console.log(s);
  if (fs.existsSync(dest) && (await fsp.stat(dest)).size === bytes) {
    if ((await sha256File(dest)) === want) { say(`  ✓ 已存在  ${label}`); return dest; }
    say(`  ${label} 的 sha256 不对，重新下载`);
    await fsp.rm(dest, { force: true });
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const proxy = proxyUrl();
  let lastErr = null;

  for (const url of urls) {
    /* 换地址时 .part 接着用：各处给的是同一份文件，最后的 sha256 兜底，
       混进了不一样的字节也会被发现 */
    for (const p of proxy ? [null, proxy] : [null]) {
      try {
        const have = fs.existsSync(part) ? (await fsp.stat(part)).size : 0;
        const { res, resumed, total } = await request(url, { offset: have, proxy: p });
        const start = resumed ? have : 0;
        if (!resumed && have) await fsp.rm(part, { force: true });
        let got = start;
        let tick = 0;
        const t0 = Date.now();
        res.on('data', (c) => {
          got += c.length;
          if (!quiet && Date.now() - tick > 500) {
            tick = Date.now();
            const kbs = ((got - start) / 1024 / ((Date.now() - t0) / 1000)).toFixed(0);
            process.stdout.write(`\r    ${label}  ${mb(got)}/${mb(bytes)}  ${kbs} KB/s   `);
          }
        });
        await streamPipeline(res, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
        if (!quiet) process.stdout.write(`\r${' '.repeat(80)}\r`);
        const size = (await fsp.stat(part)).size;
        if (size !== bytes) throw new Error(`大小不对：${size}，应为 ${bytes}${total ? `（服务端报 ${total}）` : ''}`);
        if ((await sha256File(part)) !== want) {
          await fsp.rm(part, { force: true });
          throw new Error('sha256 对不上，已删除（镜像可能替换了内容）');
        }
        await fsp.rename(part, dest);
        say(`  ✓ ${label}  ${mb(bytes)}`);
        return dest;
      } catch (e) {
        lastErr = e;
        if (!quiet) process.stdout.write('\n');
        say(`    ${new URL(url).host}${p ? '（代理）' : ''} 失败：${e.message}`);
      }
    }
  }
  throw new Error(`${label} 下载失败：${lastErr?.message}`);
}
