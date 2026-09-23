/**
 * 桌面与安卓共用的业务层（src/main/app-core.js）。
 *
 * 这一层原先写了两遍，安卓那份抄漏过两处。现在只有一份，要盯的是它和
 * 两个平台之间的接线：桌面靠 IPC_CHANNELS 把方法挂到通道上，preload 再把
 * 通道暴露给渲染层——三处任何一处漏一个，渲染层点下去就没反应，不会报错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCore, IPC_CHANNELS } = require('../src/main/app-core.js');
const { UserDB, parseWordList } = require('../src/main/user-db.js');

const ROOT = path.resolve(import.meta.dirname, '..');

/** 只看方法表，不调用：依赖给空对象就够了 */
const apiNames = Object.keys(createCore({ dict: {}, user: {}, quiz: {}, emit() {} }).api);

test('api 的每个方法桌面都挂了通道，通道表里的每一项都是 api 的方法', () => {
  const wired = new Set([...Object.values(IPC_CHANNELS), 'wbRemoveContext']);
  assert.deepEqual(apiNames.filter((m) => !wired.has(m)), [], '这些方法桌面版没挂 IPC 通道');
  assert.deepEqual(
    Object.values(IPC_CHANNELS).filter((m) => !apiNames.includes(m)),
    [],
    '通道表指向了不存在的方法',
  );
});

test('preload 暴露的正是通道表里的那个通道', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf8');
  const wrong = [];
  for (const [channel, method] of Object.entries(IPC_CHANNELS)) {
    const line = preload.split('\n').find((l) => new RegExp(`^\\s+${method}:`).test(l));
    if (!line || !line.includes(`call('${channel}'`)) wrong.push(`${method} → ${channel}：${line?.trim() ?? '（preload 里没有）'}`);
  }
  assert.deepEqual(wrong, []);
});

test('导入预览数出的词，就是建词表时存进去的那些', () => {
  const text = '# 课程词表\n1. Apple, 苹果\n- apple\nBanana；香蕉\n\n  cherry\t樱桃\n' + 'x'.repeat(65);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexica-core-'));
  const user = new UserDB(dir);
  const r = user.createList('t', text);
  assert.equal(r.count, parseWordList(text).length);
  assert.deepEqual(user.listWords(r.id), ['apple', 'banana', 'cherry']);
  user.close();
});
