'use strict';
/**
 * llama.cpp 的 llama-server 常驻服务的包装，给 GGUF 格式的翻译模型（Hy-MT2）用。
 *
 * 和 asr.js 包 whisper-server 是同一个套路：llama.cpp 官方发 Windows 预编译 exe
 * （有 CUDA 版），当子进程用，绕开本机编不了原生模块的限制；常驻而不是每句起一次，
 * 因为 7B 的权重载一次要好几秒。
 *
 * 这个文件不认识任何具体模型：提示词模板在 hymt.js，守卫和兜底在 translate.js。
 */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { freePort } = require('./asr');

const PORT_RANGE = [8770, 8800];
/** 7B 的 Q4 权重从冷盘读进显存，慢的时候要二三十秒 */
const READY_TIMEOUT = 120_000;

class LlamaServer {
  /**
   * @param dir        放 llama-server.exe 和它那些 dll 的目录
   * @param gpuLayers  放到显卡上的层数，999 = 全部。没有能用的显卡时 llama.cpp 自己退回 CPU
   * @param ctx        上下文长度。一句字幕加模板不到 300 token，4096 绰绰有余
   * @param threads    CPU 线程。全部层都在显卡上时它几乎不吃 CPU，
   *                   别给多了去和 whisper 抢核（见 README「实时场景下翻译模型要用快的」）
   */
  constructor(dir, { gpuLayers = 999, ctx = 4096, threads = 4, tag = 'llama' } = {}) {
    this.dir = dir;
    this.gpuLayers = gpuLayers;
    this.ctx = ctx;
    this.threads = threads;
    this.tag = tag;
    this.proc = null;
    this.port = 0;
    this.modelPath = null;
    this.starting = null;
    this.failures = 0;
    this.disabled = false;
    this.log = '';
  }

  get exePath() { return path.join(this.dir, 'llama-server.exe'); }

  get available() { return fs.existsSync(this.exePath); }

  get running() { return !!this.proc; }

  /** 启动参数。单独拿出来是为了测试能换掉 */
  spawnArgs(modelPath, port) {
    return [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-ngl', String(this.gpuLayers),
      '-c', String(this.ctx),
      '-t', String(this.threads),
      // 只服务一个请求槽：字幕一句一句来，并发只会让每一句都变慢
      '-np', '1',
      // 用 GGUF 里自带的对话模板，和官方示例一致
      '--jinja',
    ];
  }

  /** 拉起服务并等到能应答。重复调用幂等；换模型会先停掉再起 */
  async start(modelPath) {
    if (this.disabled) throw new Error('llama-server 已停用（反复退出）');
    if (!this.available) throw new Error(`找不到 ${this.exePath}`);
    if (!fs.existsSync(modelPath)) throw new Error(`模型不在：${modelPath}`);
    if (this.starting) await this.starting.catch(() => {});
    if (this.proc && this.modelPath === modelPath) return this.port;
    if (this.proc) this.stop();

    this.starting = this._spawn(modelPath);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async _spawn(modelPath) {
    const port = await freePort(PORT_RANGE[0], PORT_RANGE[1]);
    this.log = '';
    const proc = spawn(this.exePath, this.spawnArgs(modelPath, port), {
      cwd: this.dir,          // CUDA 的 dll 在同目录，必须让它找得到
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // 服务的报错只打在它自己的 stderr 里（参数写错时尤其如此），留着尾巴好排查
    const keep = (d) => { this.log = (this.log + d).slice(-6000); };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    proc.once('error', (e) => keep(`\n无法启动：${e.message}`));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.modelPath = null;
      if (code !== 0) {
        this.failures += 1;
        console.error(`[${this.tag}] 服务退出（code ${code}），已失败 ${this.failures} 次\n${this.log.slice(-800)}`);
        if (this.failures >= 3) this.disabled = true;
      }
    });

    this.proc = proc;
    this.port = port;
    this.modelPath = modelPath;

    const t0 = Date.now();
    while (Date.now() - t0 < READY_TIMEOUT) {
      if (this.proc !== proc) throw new Error(`llama-server 启动即退出：\n${this.log.slice(-800)}`);
      // /health 在模型载完之前回 503，载完回 200
      const ok = await this._get('/health', 2000).then((r) => r.status === 200, () => false);
      if (ok) {
        console.log(`[${this.tag}] 就绪：${path.basename(modelPath)}，端口 ${port}，`
          + `-ngl ${this.gpuLayers}，${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return port;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    this.stop();
    throw new Error(`llama-server 启动超时：\n${this.log.slice(-800)}`);
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.modelPath = null;
    if (p) {
      try { p.kill(); } catch { /* 忽略 */ }
    }
  }

  _request(method, pathname, body, timeout) {
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = http.request({
        host: '127.0.0.1',
        port: this.port,
        path: pathname,
        method,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(timeout, () => req.destroy(new Error('llama-server 超时')));
      req.once('error', reject);
      req.end(data || undefined);
    });
  }

  _get(pathname, timeout) { return this._request('GET', pathname, null, timeout); }

  /**
   * 一轮对话补全（OpenAI 兼容的 /v1/chat/completions）。
   * @returns {Promise<{ text:string, ms:number, promptTokens?:number, outTokens?:number }>}
   */
  async chat(messages, params = {}, { timeout = 30_000 } = {}) {
    if (!this.proc) throw new Error('llama-server 没有运行');
    const t0 = Date.now();
    const r = await this._request('POST', '/v1/chat/completions', {
      messages, stream: false, ...params,
    }, timeout);
    if (r.status !== 200) throw new Error(`llama-server HTTP ${r.status}：${r.text.slice(0, 200)}`);
    let j;
    try { j = JSON.parse(r.text); } catch { throw new Error(`llama-server 返回的不是 JSON：${r.text.slice(0, 200)}`); }
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error(`llama-server 返回结构不认识：${r.text.slice(0, 200)}`);
    return {
      text,
      ms: Date.now() - t0,
      promptTokens: j.usage?.prompt_tokens,
      outTokens: j.usage?.completion_tokens,
    };
  }

  dispose() { this.stop(); }
}

module.exports = { LlamaServer, PORT_RANGE };
