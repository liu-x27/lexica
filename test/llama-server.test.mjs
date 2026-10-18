/**
 * llama-server 包装的回归测试：用一个假服务（test/fixtures/fake-llama-server.mjs）
 * 走一遍真实的起进程 → 等 /health → 发请求 → 停进程。
 *
 * 盯的是两种容易静默出错的情况：模型还没载完就开始发请求（真服务这时回 503），
 * 以及服务一启动就退出（参数写错、显存不够）时 start() 要报出它的 stderr，
 * 而不是干等到超时。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { LlamaServer } = require(path.join(ROOT, 'src', 'main', 'llama-server.js'));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-llama-server.mjs');

/** 把 exe 换成 node 跑假服务；其余（端口、等待、请求、停止）都是真代码 */
class FakeServer extends LlamaServer {
  constructor(extra = []) {
    super(os.tmpdir(), { tag: 'fake-llama' });
    this.extra = extra;
  }

  get exePath() { return process.execPath; }

  spawnArgs(_model, port) { return [FAKE, '--port', String(port), ...this.extra]; }
}

const servers = [];
const make = (extra) => { const s = new FakeServer(extra); servers.push(s); return s; };
after(() => { for (const s of servers) s.stop(); });

describe('llama-server 包装', () => {
  test('模型没载完时（/health 回 503）要等，载完了才算启动', async () => {
    const s = make(['--warm', '600']);
    const t0 = Date.now();
    const port = await s.start(FAKE);
    assert.ok(port > 0);
    assert.ok(Date.now() - t0 >= 550, '应当等到 /health 回 200');
    const r = await s.chat([{ role: 'user', content: 'Hello.' }], { temperature: 0 });
    assert.equal(r.text, '译：Hello.');
    assert.equal(r.outTokens, 5);
  });

  test('同一个模型重复 start 不会再起一个进程', async () => {
    const s = make();
    const p1 = await s.start(FAKE);
    const proc = s.proc;
    const p2 = await s.start(FAKE);
    assert.equal(p1, p2);
    assert.equal(s.proc, proc);
  });

  test('一启动就退出的服务要立刻报错，并带上它的 stderr', async () => {
    const s = make(['--crash']);
    await assert.rejects(() => s.start(FAKE), /启动即退出[\s\S]*failed to load model/);
    assert.equal(s.running, false);
  });

  test('请求失败时报出状态码', async () => {
    const s = make();
    await s.start(FAKE);
    await assert.rejects(() => s.chat([{ role: 'user', content: 'FAIL500' }]), /HTTP 500/);
  });

  test('没启动就发请求要报错，而不是连到别的端口上', async () => {
    const s = make();
    await assert.rejects(() => s.chat([{ role: 'user', content: 'x' }]), /没有运行/);
  });

  test('stop 之后进程真的退出', async () => {
    const s = make();
    await s.start(FAKE);
    const proc = s.proc;
    const exited = new Promise((r) => proc.once('exit', r));
    s.stop();
    await exited;
    assert.equal(s.running, false);
  });

  test('模型文件不在就别起进程', async () => {
    const s = make();
    await assert.rejects(() => s.start(path.join(os.tmpdir(), 'no-such-model.gguf')), /模型不在/);
    assert.equal(s.running, false);
  });

  test('启动参数：全部层上显卡、单槽、用 GGUF 自带的模板', () => {
    const args = new LlamaServer('x').spawnArgs('m.gguf', 8777);
    const at = (k) => args[args.indexOf(k) + 1];
    assert.equal(at('-m'), 'm.gguf');
    assert.equal(at('--port'), '8777');
    assert.equal(at('-ngl'), '999');
    assert.equal(at('-np'), '1');
    assert.ok(args.includes('--jinja'));
    assert.ok(fs.existsSync(FAKE));
  });
});
