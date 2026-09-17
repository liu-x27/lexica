/**
 * 下载并解包 Lexica 所需的三份开源词典数据。
 *
 *   ECDICT   中英释义 / 音标 / 词形变化 / 难度标签 / 词频 / 柯林斯星级
 *   WordNet  分词性义项 / 英文释义 / 官方例句 / 同反义词 / 上下位词
 *   Tatoeba  英文例句 + 英汉对照
 *
 * 只依赖 unbzip2-stream；zip 与 tar.gz 交给 Windows 自带的 bsdtar(tar.exe)。
 * Node 的 fetch 不读 HTTP(S)_PROXY，这里自己建 CONNECT 隧道，并支持断点续传。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import bz2 from 'unbzip2-stream';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');

const ECDICT_ORIGIN =
  'https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip';

/**
 * 每个数据源给一串候选地址，按顺序尝试。
 *   proxy:'none' 直连，'env' 走 HTTP(S)_PROXY。
 * GitHub 在国内直连很慢，优先走公共加速镜像；镜像下完后会回原站抽样比对字节。
 */
const SOURCES = [
  {
    key: 'ecdict',
    file: 'ecdict-sqlite-28.zip',
    bytes: 216_735_000,
    origin: ECDICT_ORIGIN,
    urls: [
      { url: `https://gh-proxy.com/${ECDICT_ORIGIN}`, proxy: 'none' },
      { url: `https://ghfast.top/${ECDICT_ORIGIN}`, proxy: 'none' },
      { url: `https://ghproxy.net/${ECDICT_ORIGIN}`, proxy: 'none' },
      { url: ECDICT_ORIGIN, proxy: 'none' },
      { url: ECDICT_ORIGIN, proxy: 'env' },
    ],
    unpack: { type: 'zip', into: 'ecdict', expect: 'stardict.db' },
    note: 'ECDICT 完整版 340 万词条',
  },
  {
    key: 'wordnet',
    file: 'wn3.1.dict.tar.gz',
    bytes: 16_358_468,
    urls: [
      { url: 'https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz', proxy: 'none' },
      { url: 'https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz', proxy: 'env' },
    ],
    unpack: { type: 'tgz', into: 'wordnet', expect: path.join('dict', 'data.noun') },
    note: 'Princeton WordNet 3.1',
  },
  {
    key: 'gcide',
    file: 'gcide-0.53.tar.xz',
    bytes: 14_400_000,
    urls: [
      { url: 'https://ftp.gnu.org/gnu/gcide/gcide-0.53.tar.xz', proxy: 'none' },
      { url: 'https://ftp.gnu.org/gnu/gcide/gcide-0.53.tar.xz', proxy: 'env' },
    ],
    unpack: { type: 'txz', into: 'gcide', expect: path.join('gcide-0.53', 'CIDE.A') },
    note: 'GCIDE 韦氏 1913（词源与古典引文，公版）',
  },
  /* 中文维基的跨语言链接：zh 条目 ↔ en 条目标题。
     这是学术术语最好的离线来源——标题对是人工校准的，
     而且「有没有维基条目」本身就是判断一个词组是不是真实术语的强信号
     （gradient descent 有条目，gradient gun 没有）。 */
  {
    key: 'wiki-langlinks',
    file: 'zhwiki-langlinks.sql.gz',
    bytes: 285_000_000,
    urls: [
      { url: 'https://dumps.wikimedia.org/zhwiki/latest/zhwiki-latest-langlinks.sql.gz', proxy: 'none' },
      { url: 'https://dumps.wikimedia.org/zhwiki/latest/zhwiki-latest-langlinks.sql.gz', proxy: 'env' },
    ],
    unpack: null, // 直接流式解析 .gz，不落解压文件
    note: '中文维基跨语言链接',
  },
  {
    key: 'wiki-page',
    file: 'zhwiki-page.sql.gz',
    bytes: 282_000_000,
    urls: [
      { url: 'https://dumps.wikimedia.org/zhwiki/latest/zhwiki-latest-page.sql.gz', proxy: 'none' },
      { url: 'https://dumps.wikimedia.org/zhwiki/latest/zhwiki-latest-page.sql.gz', proxy: 'env' },
    ],
    unpack: null,
    note: '中文维基条目标题',
  },
  /* OpenCC 的繁→简对照表。中文维基约一半条目标题是繁体，不转换的话
     查出来一半是「信賴區間」「過適」这种，对简体用户很别扭。 */
  {
    key: 'opencc',
    file: 'TSCharacters.txt',
    bytes: 40_000,
    urls: [
      { url: 'https://gh-proxy.com/https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt', proxy: 'none' },
      { url: 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt', proxy: 'env' },
    ],
    unpack: null,
    note: 'OpenCC 繁简字表',
  },
  {
    key: 'opencc-phrases',
    file: 'TSPhrases.txt',
    bytes: 30_000,
    urls: [
      { url: 'https://gh-proxy.com/https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSPhrases.txt', proxy: 'none' },
      { url: 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSPhrases.txt', proxy: 'env' },
    ],
    unpack: null,
    note: 'OpenCC 繁简词组表',
  },
  {
    key: 'tatoeba-eng',
    file: 'eng_sentences.tsv.bz2',
    bytes: 24_806_163,
    urls: [
      { url: 'https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2', proxy: 'none' },
      { url: 'https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2', proxy: 'env' },
    ],
    unpack: { type: 'bz2', out: 'eng_sentences.tsv' },
    note: 'Tatoeba 英文句库',
  },
  {
    key: 'tatoeba-cmn',
    file: 'cmn_sentences.tsv.bz2',
    bytes: 1_300_000,
    urls: [
      { url: 'https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2', proxy: 'none' },
      { url: 'https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2', proxy: 'env' },
    ],
    unpack: { type: 'bz2', out: 'cmn_sentences.tsv' },
    note: 'Tatoeba 中文句库',
  },
  {
    key: 'tatoeba-links',
    file: 'eng-cmn_links.tsv.bz2',
    bytes: 560_000,
    urls: [
      { url: 'https://downloads.tatoeba.org/exports/per_language/eng/eng-cmn_links.tsv.bz2', proxy: 'none' },
      { url: 'https://downloads.tatoeba.org/exports/per_language/eng/eng-cmn_links.tsv.bz2', proxy: 'env' },
    ],
    unpack: { type: 'bz2', out: 'eng-cmn_links.tsv' },
    note: 'Tatoeba 英汉对照映射',
  },
];

/* 可变字重网页字体（OFL 协议）。下载失败不阻断流程，CSS 会退回系统字体。 */
const FONTS = [
  'inter-latin-wght-normal.woff2',
  'source-serif-4-latin-wght-normal.woff2',
  'source-serif-4-latin-wght-italic.woff2',
];
const FONT_BASE = {
  'inter-latin-wght-normal.woff2': 'https://cdn.jsdelivr.net/npm/@fontsource-variable/inter/files/',
  'source-serif-4-latin-wght-normal.woff2': 'https://cdn.jsdelivr.net/npm/@fontsource-variable/source-serif-4/files/',
  'source-serif-4-latin-wght-italic.woff2': 'https://cdn.jsdelivr.net/npm/@fontsource-variable/source-serif-4/files/',
};

/* ------------------------------------------------------------------ 代理 */

function proxyUrl() {
  if (process.argv.includes('--no-proxy')) return null;
  const raw =
    process.env.DICT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!raw) return null;
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

/** 通过 HTTP CONNECT 打隧道再套 TLS，让 https.request 走代理。 */
class TunnelAgent extends https.Agent {
  constructor(proxy, opts) {
    super({ keepAlive: false, ...opts });
    this.proxy = proxy;
  }
  createConnection(options, cb) {
    const target = `${options.host}:${options.port || 443}`;
    const headers = { host: target };
    if (this.proxy.username) {
      const cred = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
      headers['proxy-authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
    }
    const req = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port) || 80,
      method: 'CONNECT',
      path: target,
      headers,
      agent: false,
    });
    req.setTimeout(30_000, () => req.destroy(new Error('代理 CONNECT 超时')));
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return cb(new Error(`代理 CONNECT 返回 ${res.statusCode}`));
      }
      socket.setTimeout(0);
      cb(null, tls.connect({ socket, servername: options.host, ALPNProtocols: ['http/1.1'] }));
    });
    req.once('error', cb);
    req.end();
  }
}

/* --------------------------------------------------------------- 下载核心 */

const fmt = (n) => (n / 1024 / 1024).toFixed(1).padStart(7) + ' MB';

function request(url, { offset = 0, rangeEnd = null, proxy, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向次数过多'));
    const u = new URL(url);
    const headers = {
      'user-agent': 'Mozilla/5.0 Lexica-fetch/1.0',
      accept: '*/*',
      connection: 'close',
    };
    if (rangeEnd !== null) headers.range = `bytes=${offset}-${rangeEnd}`;
    else if (offset > 0) headers.range = `bytes=${offset}-`;

    const opts = {
      method: 'GET',
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
    };
    const isHttps = u.protocol === 'https:';
    if (proxy) {
      if (isHttps) opts.agent = new TunnelAgent(proxy);
      else {
        opts.host = proxy.hostname;
        opts.port = Number(proxy.port) || 80;
        opts.path = url; // 明文 HTTP 走绝对路径转发
      }
    }

    const req = (isHttps ? https : http).request(opts, (res) => {
      const { statusCode, headers: h } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && h.location) {
        res.resume();
        const next = new URL(h.location, url).toString();
        return resolve(request(next, { offset, rangeEnd, proxy, redirects: redirects + 1 }));
      }
      if (statusCode !== 200 && statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} — ${url}`));
      }
      resolve({ res, resumed: statusCode === 206, total: Number(h['content-length']) || 0 });
    });
    req.setTimeout(60_000, () => req.destroy(new Error('读取超时')));
    req.once('error', reject);
    req.end();
  });
}

/** 从指定地址读一段字节到内存（用于镜像抽样比对） */
async function readRange(url, start, end, proxy) {
  const { res } = await request(url, { offset: start, rangeEnd: end, proxy });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

/**
 * 镜像完整性抽查：从原站取头/中/尾三段，与本地文件对应位置比对。
 * 镜像可能被中间人替换内容，而这个文件会被打进应用，所以值得花十几秒验一下。
 * 返回 true=一致，false=不一致，null=原站取不到（无法判定）。
 */
async function verifyAgainstOrigin(src, file, proxy) {
  if (!src.origin) return null;
  const size = (await fsp.stat(file)).size;
  const seg = 512 * 1024;
  const spots = [
    [0, seg - 1],
    [Math.floor(size / 2), Math.floor(size / 2) + seg - 1],
    [Math.max(0, size - seg), size - 1],
  ];
  const fh = await fsp.open(file, 'r');
  try {
    for (const [a, b] of spots) {
      let remote;
      try {
        remote = await readRange(src.origin, a, b, proxy);
      } catch {
        try {
          remote = await readRange(src.origin, a, b, null);
        } catch {
          return null; // 原站不可达，判定不了
        }
      }
      const local = Buffer.alloc(b - a + 1);
      const { bytesRead } = await fh.read(local, 0, local.length, a);
      if (!remote.equals(local.subarray(0, bytesRead))) return false;
    }
    return true;
  } finally {
    await fh.close();
  }
}

async function download(src, envProxy) {
  const dest = path.join(RAW, src.file);
  const part = `${dest}.part`;

  if (fs.existsSync(dest)) {
    const { size } = await fsp.stat(dest);
    // 已完成的文件按体积粗校验（±5%），避免半截文件被当成成品
    if (size > src.bytes * 0.95) {
      console.log(`  ✓ 已存在  ${src.file}  ${fmt(size)}`);
      return dest;
    }
    console.log(`  ! ${src.file} 体积异常(${fmt(size)})，重新下载`);
    await fsp.rm(dest);
  }

  let offset = fs.existsSync(part) ? (await fsp.stat(part)).size : 0;
  if (offset > 0) console.log(`    发现未完成的下载 ${fmt(offset)}，尝试续传`);

  const attempts = [];
  for (const cand of src.urls) {
    attempts.push(cand, cand); // 每个地址给两次机会
  }

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const { url, proxy: mode } = attempts[i];
    const proxy = mode === 'env' ? envProxy : null;
    const host = new URL(url).host;
    try {
      const { res, resumed, total } = await request(url, { offset, proxy });
      if (offset > 0 && !resumed) {
        offset = 0; // 该地址不支持 Range，只能重来
        await fsp.rm(part, { force: true });
      }
      const grand = (resumed ? offset : 0) + total;
      let got = resumed ? offset : 0;
      const t0 = Date.now();
      let lastTick = 0;

      res.on('data', (chunk) => {
        got += chunk.length;
        const now = Date.now();
        if (now - lastTick > 400) {
          lastTick = now;
          const pct = grand ? ((got / grand) * 100).toFixed(1) : '?';
          const kbs = ((got - (resumed ? offset : 0)) / 1024 / ((now - t0) / 1000)).toFixed(0);
          process.stdout.write(`\r    ${host}  ${fmt(got)} / ${fmt(grand)}  ${pct}%  ${kbs} KB/s   `);
        }
      });

      await pipeline(res, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
      process.stdout.write('\r' + ' '.repeat(88) + '\r');

      const size = (await fsp.stat(part)).size;
      // 以服务端给出的 Content-Length 为准；拿不到时才退回用配置里的估值粗判，
      // 否则估值稍微偏大就会把已下载完的文件判成不完整。
      const expected = grand > 0 ? grand : Math.floor(src.bytes * 0.5);
      if (size < expected) throw new Error(`下载不完整：${fmt(size)} / ${fmt(expected)}`);
      await fsp.rename(part, dest);
      console.log(`  ✓ 下载完成 ${src.file}  ${fmt(size)}  （源：${host}）`);

      if (src.origin && host !== new URL(src.origin).host) {
        process.stdout.write('    校验镜像与原站字节一致性…');
        const ok = await verifyAgainstOrigin(src, dest, envProxy);
        if (ok === true) console.log(' 一致 ✓');
        else if (ok === false) {
          console.log(' 不一致 ✗');
          await fsp.rm(dest, { force: true });
          throw new Error('镜像内容与 GitHub 原站不一致，已删除并换源');
        } else console.log(' 原站不可达，跳过（构建时仍会校验数据库结构）');
      }
      return dest;
    } catch (err) {
      lastErr = err;
      console.log(`\r  ! ${host} 失败：${err.message}`);
      // 416 = 请求的 Range 超出文件末尾，说明本地 .part 比远端文件还大，只能弃掉重下
      if (/\b416\b/.test(err.message)) {
        await fsp.rm(part, { force: true });
        offset = 0;
      } else {
        offset = fs.existsSync(part) ? (await fsp.stat(part)).size : 0;
      }
      if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw lastErr || new Error('所有地址均失败');
}

/* ----------------------------------------------------------------- 解包 */

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, so, se) =>
      e ? reject(new Error(`${cmd} 失败：${se || e.message}`)) : resolve(so),
    ),
  );

async function unpack(src, archive) {
  const { unpack: u } = src;
  if (!u) return; // 有些源（维基转储）由构建脚本流式读取，不需要解包
  if (u.type === 'bz2') {
    const out = path.join(RAW, u.out);
    if (fs.existsSync(out) && (await fsp.stat(out)).size > 0) {
      console.log(`  ✓ 已解包  ${u.out}`);
      return;
    }
    process.stdout.write(`    解压 ${src.file} → ${u.out} …`);
    await pipeline(fs.createReadStream(archive), bz2(), fs.createWriteStream(`${out}.tmp`));
    await fsp.rename(`${out}.tmp`, out);
    console.log(` ${fmt((await fsp.stat(out)).size)}`);
    return;
  }

  const into = path.join(RAW, u.into);
  if (u.expect && fs.existsSync(path.join(into, u.expect))) {
    console.log(`  ✓ 已解包  ${u.into}/`);
    return;
  }
  await fsp.mkdir(into, { recursive: true });
  process.stdout.write(`    解包 ${src.file} → ${u.into}/ …`);
  // bsdtar（Windows 自带，带 liblzma）能自动识别 zip / tar.gz / tar.xz
  await run('tar', ['-xf', archive, '-C', into]);
  console.log(' 完成');
}

/* ------------------------------------------------------------------ main */

async function fetchFonts(proxy) {
  const dir = path.join(ROOT, 'assets', 'fonts');
  await fsp.mkdir(dir, { recursive: true });
  for (const name of FONTS) {
    const dest = path.join(dir, name);
    if (fs.existsSync(dest) && (await fsp.stat(dest)).size > 10_000) {
      console.log(`  ✓ 已存在  ${name}`);
      continue;
    }
    try {
      let res;
      try {
        ({ res } = await request(FONT_BASE[name] + name, { proxy: null }));
      } catch {
        ({ res } = await request(FONT_BASE[name] + name, { proxy }));
      }
      await pipeline(res, fs.createWriteStream(`${dest}.tmp`));
      await fsp.rename(`${dest}.tmp`, dest);
      console.log(`  ✓ ${name}  ${fmt((await fsp.stat(dest)).size)}`);
    } catch (err) {
      await fsp.rm(`${dest}.tmp`, { force: true });
      console.log(`  – ${name} 下载失败(${err.message})，将使用系统字体`);
    }
  }
}

async function main() {
  await fsp.mkdir(RAW, { recursive: true });
  const proxy = proxyUrl();
  console.log('Lexica 数据下载');
  console.log('  目标目录：', RAW);
  console.log('  代理：', proxy ? `${proxy.hostname}:${proxy.port}` : '不使用');
  console.log('');

  const only = process.argv.filter((a) => !a.startsWith('-')).slice(2);
  const list = only.length ? SOURCES.filter((s) => only.includes(s.key)) : SOURCES;

  for (const src of list) {
    console.log(`[${src.key}] ${src.note}`);
    const archive = await download(src, proxy);
    await unpack(src, archive);
    console.log('');
  }

  if (!only.length) {
    console.log('[fonts] 界面字体（Inter / Source Serif 4，OFL）');
    await fetchFonts(proxy);
    console.log('');
  }

  console.log('全部数据就绪。下一步：npm run build:db');
}

main().catch((err) => {
  console.error('\n下载失败：', err.message);
  console.error('可尝试：设置 DICT_PROXY=http://127.0.0.1:7890，或加 --no-proxy 直连；重跑会自动续传。');
  process.exit(1);
});
