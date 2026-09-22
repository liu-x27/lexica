/**
 * 在线翻译的回归测试。全部用注入的假 fetch，**不联网**。
 *
 * 盯的是三件会在上课途中出事的事：
 *   1. 断网/超时必须快速失败并退回本地，不能把字幕拖住；
 *   2. 批量翻译行数对不上时不能错位（那比慢更糟）；
 *   3. 连续失败要进冷却，不能每句都去撞一次超时。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { OnlineTranslator, FAIL_LIMIT } = require(path.join(ROOT, 'src', 'main', 'translate-online.js'));

/** 造一个假 fetch：按 q 参数返回指定译文 */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
    calls.push(q);
    return handler(q, opts, calls.length);
  };
  fn.calls = calls;
  return fn;
}

/** Google 的返回结构：[[[译文片段, 原文片段, …], …], …] */
const body = (zh) => ({
  ok: true,
  status: 200,
  json: async () => [zh.split('\n').map((line, i, all) => [i < all.length - 1 ? `${line}\n` : line, '']), null, 'en'],
});

const httpError = (status) => ({ ok: false, status, json: async () => null });

describe('在线翻译：基本行为', () => {
  test('翻一句', async () => {
    const t = new OnlineTranslator({
      enabled: true,
      fetchImpl: fakeFetch(() => body('标量奖励。')),
    });
    const r = await t.translate('A scalar reward.');
    assert.equal(r.ok, true);
    assert.equal(r.text, '标量奖励。');
  });

  test('没开启时不发请求', async () => {
    const f = fakeFetch(() => body('x'));
    const t = new OnlineTranslator({ enabled: false, fetchImpl: f });
    const r = await t.translate('hello');
    assert.equal(r.ok, false);
    assert.equal(f.calls.length, 0, '关着还发请求就等于偷偷外发数据');
  });

  /* 电影字幕和上课口头语会大量重复，命中缓存是 0ms */
  test('同一句只发一次', async () => {
    const f = fakeFetch(() => body('你好。'));
    const t = new OnlineTranslator({ enabled: true, fetchImpl: f });
    await t.translate('Hello.');
    const r = await t.translate('Hello.');
    assert.equal(f.calls.length, 1);
    assert.equal(r.cached, true);
    assert.equal(r.text, '你好。');
  });

  test('空文本不发请求', async () => {
    const f = fakeFetch(() => body('x'));
    const t = new OnlineTranslator({ enabled: true, fetchImpl: f });
    assert.equal((await t.translate('   ')).ok, false);
    assert.equal(f.calls.length, 0);
  });
});

describe('在线翻译：失败必须快速退回', () => {
  test('HTTP 错误当失败', async () => {
    const t = new OnlineTranslator({ enabled: true, fetchImpl: fakeFetch(() => httpError(429)) });
    const r = await t.translate('hello');
    assert.equal(r.ok, false);
    assert.match(r.reason, /429/);
  });

  test('超时当失败，且报「超时」', async () => {
    const t = new OnlineTranslator({
      enabled: true,
      fetchImpl: async (_u, opts) => {
        // 模拟 AbortController 触发
        await new Promise((r) => setTimeout(r, 50));
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      },
    });
    const r = await t.translate('hello', { timeoutMs: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, '超时');
  });

  test('返回结构不认识也算失败，不能把垃圾当译文', async () => {
    const t = new OnlineTranslator({
      enabled: true,
      fetchImpl: fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ oops: 1 }) })),
    });
    assert.equal((await t.translate('hello')).ok, false);
  });

  /* 断网时如果每句都去等一次超时，字幕会被拖慢——那比不开在线更糟 */
  test('连续失败进冷却，之后不再发请求', async () => {
    const f = fakeFetch(() => httpError(500));
    const t = new OnlineTranslator({ enabled: true, fetchImpl: f });
    for (let i = 0; i < FAIL_LIMIT; i++) await t.translate(`句子 ${i}`);
    assert.equal(f.calls.length, FAIL_LIMIT);
    assert.equal(t.available, false, '应当进入冷却');

    const r = await t.translate('又一句');
    assert.equal(r.ok, false);
    assert.equal(f.calls.length, FAIL_LIMIT, '冷却期内不该再发请求');
  });

  test('成功一次就把失败计数清零', async () => {
    let n = 0;
    const t = new OnlineTranslator({
      enabled: true,
      fetchImpl: fakeFetch(() => { n += 1; return n <= 2 ? httpError(500) : body('好了。'); }),
    });
    await t.translate('a');
    await t.translate('b');
    assert.equal((await t.translate('c')).ok, true);
    assert.equal(t.failures, 0);
    assert.equal(t.available, true);
  });

  test('手动重新开启会解除冷却', async () => {
    const t = new OnlineTranslator({ enabled: true, fetchImpl: fakeFetch(() => httpError(500)) });
    for (let i = 0; i < FAIL_LIMIT; i++) await t.translate(`x${i}`);
    assert.equal(t.available, false);
    t.setEnabled(true);
    assert.equal(t.available, true, '用户手动打开等于说「再试一次」');
  });
});

describe('在线翻译：批量不能错位', () => {
  test('一次请求翻多句', async () => {
    const f = fakeFetch(() => body('第一句。\n第二句。\n第三句。'));
    const t = new OnlineTranslator({ enabled: true, fetchImpl: f });
    const r = await t.translateLines(['One.', 'Two.', 'Three.']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.texts, ['第一句。', '第二句。', '第三句。']);
    assert.equal(f.calls.length, 1, '三句应当一次往返');
  });

  /* 服务端有可能合并或拆分行。行数对不上还硬用，译文就和原文错位了 */
  test('行数对不上就退回逐句，绝不错位', async () => {
    const f = fakeFetch((q) => {
      // 第一次是批量（含换行），故意少返回一行
      if (q.includes('\n')) return body('合并成了一行');
      return body(`单句：${q}`);
    });
    const t = new OnlineTranslator({ enabled: true, fetchImpl: f });
    const r = await t.translateLines(['One.', 'Two.', 'Three.']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.texts, ['单句：One.', '单句：Two.', '单句：Three.']);
    assert.equal(f.calls.length, 4, '一次批量失败 + 三次逐句');
  });

  test('缓存命中的句子不再发出去', async () => {
    const f = fakeFetch((q) => body(q.includes('\n') ? '甲。\n乙。' : '甲。'));
    const t = new OnlineTranslator({ enabled: true, fetchImpl: f });
    await t.translate('A.');                       // 先缓存一句
    const r = await t.translateLines(['A.', 'B.']);
    assert.equal(r.ok, true);
    assert.equal(r.texts[0], '甲。');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1], 'B.', '只该发没缓存的那句');
  });

  test('全部命中缓存时一次请求都不发', async () => {
    const f = fakeFetch(() => body('甲。'));
    const t = new OnlineTranslator({ enabled: true, fetchImpl: f });
    await t.translate('A.');
    const r = await t.translateLines(['A.']);
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, 1);
  });

  test('超长会分批，不会拼出一个巨大的 URL', async () => {
    const f = fakeFetch((q) => body(q.split('\n').map(() => '一句。').join('\n')));
    const t = new OnlineTranslator({ enabled: true, fetchImpl: f });
    const long = Array.from({ length: 30 }, (_, i) => `${'x'.repeat(100)} ${i}.`);
    const r = await t.translateLines(long);
    assert.equal(r.ok, true);
    assert.equal(r.texts.length, 30);
    assert.ok(f.calls.length > 1, '30 句共约 3000 字符，应当分批');
    for (const q of f.calls) assert.ok(q.length <= 1600, `单批过长：${q.length}`);
  });

  test('换服务要清缓存', async () => {
    const f = fakeFetch(() => body('甲。'));
    const t = new OnlineTranslator({ enabled: true, fetchImpl: f });
    await t.translate('A.');
    t.setProvider('google');      // 同一个，不该清
    assert.equal((await t.translate('A.')).cached, true);
  });
});

describe('在线翻译：统计', () => {
  test('调用数、命中数、错误数都记下来', async () => {
    let n = 0;
    const t = new OnlineTranslator({
      enabled: true,
      fetchImpl: fakeFetch(() => { n += 1; return n === 2 ? httpError(500) : body('甲。'); }),
    });
    await t.translate('A.');
    await t.translate('B.');   // 失败
    await t.translate('A.');   // 缓存
    const s = t.stats();
    assert.equal(s.calls, 1);
    assert.equal(s.cacheHits, 1);
    assert.equal(s.errors, 1);
    assert.equal(s.enabled, true);
    assert.equal(s.provider, 'google');
  });
});
