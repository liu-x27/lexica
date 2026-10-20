/**
 * 流式识别包装（src/main/nemo-asr.js）的回归测试：用一个假服务（test/fixtures/fake-nemo-server.mjs）
 * 走一遍真实的起进程 → 等 /ready → 开 WebSocket → 推音频 → 收临时稿和定稿 → 收尾。
 *
 * 盯的是几种容易静默出错的情况：模型还没载完就开流（真服务这时 /ready 回 503）、
 * 服务一启动就退出时要报出它的 stderr、会话配置（定稿的静音阈值、术语表增强）真的送到了、
 * 半路服务崩了要报错（index.js 靠它换回 whisper），以及收尾时最后一句的定稿不能丢。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { NemoAsr, NEMO_MODELS, wordsToSegments, toPcm16 } = require(path.join(ROOT, 'src', 'main', 'nemo-asr.js'));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-nemo-server.mjs');

/** 一个装了「模型」的临时目录：start() 只看模型文件在不在 */
function fakeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexica-nemo-'));
  fs.mkdirSync(path.join(dir, 'models'));
  fs.writeFileSync(path.join(dir, 'models', NEMO_MODELS.nemotron.file), 'GGUF');
  return dir;
}

/** 把 exe 换成 node 跑假服务；其余（选端口、等就绪、WebSocket、停进程）都是真代码 */
class FakeNemo extends NemoAsr {
  constructor(extra = []) {
    super(fakeDataDir(), { tag: 'fake-nemo' });
    this.extra = extra;
  }

  pickBackend() { return { backend: 'fake', device: 'cpu' }; }

  exeOf() { return process.execPath; }

  spawnArgs(_model, port) { return [FAKE, '--port', String(port), ...this.extra]; }
}

const servers = [];
const make = (extra) => { const s = new FakeNemo(extra); servers.push(s); return s; };
after(() => { for (const s of servers) s.stop(); });

const LOUD = new Float32Array(2048).fill(0.2);
const QUIET = new Float32Array(2048);
const getJson = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let t = '';
    res.on('data', (d) => { t += d; });
    res.on('end', () => resolve(JSON.parse(t)));
  }).once('error', reject);
});
/** 等某个事件来（来不了就超时失败，别让测试挂住） */
const once = (em, ev, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`等不到 ${ev}`)), ms);
  em.once(ev, (x) => { clearTimeout(t); resolve(x); });
});

describe('nemo-speech serve 包装', () => {
  test('模型没载完时（/ready 回 503）要等，载完了才算启动', async () => {
    const s = make(['--warm', '600']);
    const t0 = Date.now();
    const port = await s.start('nemotron');
    assert.ok(port > 0);
    assert.ok(Date.now() - t0 >= 550, '应当等到 /ready 回 ready:true');
    assert.equal(s.running, true);
  });

  test('一启动就退出的服务要立刻报错，并带上它的 stderr', async () => {
    const s = make(['--crash']);
    await assert.rejects(() => s.start('nemotron'), /启动即退出[\s\S]*failed to load model/);
    assert.equal(s.running, false);
  });

  test('没装的模型要报错，而不是起一个服务', async () => {
    const s = make();
    await assert.rejects(() => s.start('nope'), /没有这个流式模型/);
  });

  test('开流时把静音阈值、词时间戳、术语表增强送给服务端', async () => {
    const s = make();
    const port = await s.start('nemotron');
    const st = await s.openStream({ endpointMs: 600, boost: [{ phrases: ['SimulST', 'EDAtt'], boost: 2.5 }] });
    const got = await getJson(port, '/debug/session');
    assert.equal(got.sample_rate, 16000);
    assert.equal(got.endpointing_ms, 600);
    assert.equal(got.word_timestamps, true);
    assert.deepEqual(got.speech_contexts, [{ phrases: ['SimulST', 'EDAtt'], boost: 2.5 }]);
    st.close();
  });

  test('临时稿按增量拼成整句，停顿后来定稿，带词的时间', async () => {
    const s = make(['--eou', '3']);
    await s.start('nemotron');
    const st = await s.openStream();
    const partials = [];
    st.on('partial', (p) => partials.push(p));
    const final = once(st, 'final');
    for (let i = 0; i < 4; i++) st.push(LOUD);
    for (let i = 0; i < 3; i++) st.push(QUIET);
    const f = await final;
    assert.equal(f.text, 'Hello, this is a');
    assert.equal(f.words.length, 4);
    assert.ok(Math.abs(f.words[1].start - 0.128) < 1e-6, '第二个词从第二块（128ms）开始');
    assert.ok(Math.abs(f.audioSec - (7 * 2048) / 16000) < 1e-6, 'audioSec 是服务端已经处理到的位置');
    const texts = partials.map((p) => p.text).filter(Boolean);
    assert.equal(texts[3], 'Hello, this is a', '临时稿是累计的，不是只有增量');
    assert.ok(Math.abs(st.lagSec) < 1e-6, '全部处理完了，没有积压');
    st.close();
  });

  test('收尾时最后一句不等停顿也要定稿', async () => {
    const s = make(['--eou', '50']);
    await s.start('nemotron');
    const st = await s.openStream();
    const finals = [];
    st.on('final', (f) => finals.push(f.text));
    st.push(LOUD);
    st.push(LOUD);
    await st.finish();
    assert.deepEqual(finals, ['Hello, this']);
    assert.equal(st.push(LOUD), false, '收尾之后不再收音频');
    st.close();
  });

  test('服务半路崩了要报错（index.js 靠它换回 whisper）', async () => {
    const s = make(['--die-after', '3']);
    await s.start('nemotron');
    const st = await s.openStream();
    const failed = once(st, 'error', 5000);
    const crashed = once(s, 'crashed', 5000);
    for (let i = 0; i < 4; i++) st.push(LOUD);
    assert.match((await failed).message, /断开|出错/);
    await crashed;
    assert.equal(s.running, false);
  });

  test('stop 之后进程真的退出', async () => {
    const s = make();
    await s.start('nemotron');
    const proc = s.proc;
    const exited = new Promise((r) => proc.once('exit', r));
    s.stop();
    await exited;
    assert.equal(s.running, false);
  });
});

describe('整个文件转写：按停顿切成字幕', () => {
  const w = (word, start, end) => ({ word, start, end });

  test('停顿超过 gapSec 的地方算一个定稿，再按句末标点拼', () => {
    const segs = wordsToSegments([
      w('What', 0.0, 0.2), w('is', 0.3, 0.4),
      // 0.9 秒的停顿：一个定稿边界，但停在虚词 "is" 上、又不到 minSec，先扣着
      w('simultaneous', 1.3, 1.9), w('speech', 2.0, 2.4), w('translation?', 2.5, 3.1),
      w('It', 3.3, 3.4), w('is', 3.5, 3.6), w('the', 3.7, 3.8), w('process', 3.9, 4.4), w('of', 4.5, 4.6),
      w('translating.', 4.7, 5.4),
    ], { gapSec: 0.8 });
    assert.deepEqual(segs.map((s) => s.text), ['What is simultaneous speech translation? It is the process of translating.']);
    assert.equal(segs[0].t0, 0);
  });

  test('一个词都不丢', () => {
    const words = [];
    for (let i = 0; i < 120; i++) words.push(w(`w${i}`, i * 0.3, i * 0.3 + 0.2));
    const segs = wordsToSegments(words, { gapSec: 0.8, maxSec: 9 });
    assert.equal(segs.map((s) => s.text).join(' ').split(' ').length, 120);
    for (const s of segs) assert.ok((s.t1 - s.t0) / 1000 <= 10, `${s.text.slice(0, 20)} 太长`);
  });
});

test('PCM16 转换：截断到 [-1, 1]，小端', () => {
  const b = toPcm16(new Float32Array([0, 1, -1, 2, -0.5]));
  // 和 asr.js 的 floatToPcm16 同一个公式：Math.round(-16383.5) 是 -16383
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => b.readInt16LE(i * 2)), [0, 32767, -32767, 32767, -16383]);
});
