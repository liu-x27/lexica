/**
 * 带代理与重定向支持的 HTTPS 下载原语。
 *
 * Node 的 fetch 不读 HTTP(S)_PROXY 环境变量，这里自己建 CONNECT 隧道。
 * fetch-data.mjs 与 fetch-model.mjs 共用。
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/** 从环境变量解析代理地址；命令行带 --no-proxy 则不用代理 */
export function proxyUrl() {
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

/** 通过 HTTP CONNECT 打隧道再套 TLS，让 https.request 走代理 */
export class TunnelAgent extends https.Agent {
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

/**
 * 发起 GET，自动跟随重定向。
 * @returns {Promise<{res, resumed:boolean, total:number}>}
 */
export function request(url, { offset = 0, rangeEnd = null, proxy, redirects = 0 } = {}) {
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
export async function readRange(url, start, end, proxy) {
  const { res } = await request(url, { offset: start, rangeEnd: end, proxy });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

/**
 * 镜像完整性抽查：从原站取头/中/尾三段，与本地文件对应位置比对。
 *
 * 镜像是第三方，内容可能被替换，而这些文件会被打进应用，所以值得花十几秒验一下。
 * zip 的中央目录在文件末尾，尾部那段尤其值得比。
 *
 * @returns true=一致，false=不一致，null=原站取不到（无法判定，别当成通过）
 */
export async function verifyAgainstOrigin(originUrl, file, proxy) {
  if (!originUrl) return null;
  const fsp = await import('node:fs/promises');
  const size = (await fsp.stat(file)).size;
  const seg = Math.min(512 * 1024, size);
  const spots = [
    [0, seg - 1],
    [Math.floor(size / 2), Math.min(size - 1, Math.floor(size / 2) + seg - 1)],
    [Math.max(0, size - seg), size - 1],
  ];
  const fh = await fsp.open(file, 'r');
  try {
    for (const [a, b] of spots) {
      let remote;
      try {
        remote = await readRange(originUrl, a, b, proxy);
      } catch {
        try {
          remote = await readRange(originUrl, a, b, null);
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
