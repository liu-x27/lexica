/**
 * src/main/text-keys.js 和已经建好的 dict.db 对得上。
 *
 * 这些键建库时写进索引，查询时再按同一套规则算一遍。改了 text-keys.js 而
 * 没重建词库，查询算出来的键就和库里存的不一样——不报错，只是拼写纠错拿不到
 * 候选、中文反查漏结果。这里抽一部分库里的真实数据重算一遍，对不上就说明
 * 要么规则改坏了，要么该重跑 npm run data 了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { soundex, spaceCJK, zhSegments } = require('../src/main/text-keys.js');

const DICT = path.resolve(import.meta.dirname, '../data/dict.db');
const hasDict = fs.existsSync(DICT);

test('fuzzy.sdx 就是 soundex(wkey)', { skip: !hasDict && '需要 data/dict.db' }, () => {
  const db = new DatabaseSync(DICT, { readOnly: true });
  const rows = db.prepare('SELECT wkey, sdx FROM fuzzy ORDER BY rank LIMIT 5000').all();
  db.close();
  assert.ok(rows.length > 1000);
  const bad = rows.filter((r) => soundex(r.wkey) !== r.sdx).slice(0, 5);
  assert.deepEqual(bad, []);
});

test('zh_seg 里每个词的片段都是 zhSegments 切出来的', { skip: !hasDict && '需要 data/dict.db' }, () => {
  const db = new DatabaseSync(DICT, { readOnly: true });
  const words = db.prepare(
    'SELECT id, translation FROM words WHERE translation IS NOT NULL AND id % 4999 = 0 LIMIT 300',
  ).all();
  // zh_seg 的索引以 seg 打头，按 (seg, word_id) 查是走索引的
  const has = db.prepare('SELECT 1 FROM zh_seg WHERE seg = ? AND word_id = ? LIMIT 1');
  const missing = [];
  let checked = 0;
  for (const w of words) {
    for (const { text } of zhSegments(w.translation)) {
      // 与 build-db.mjs 的 buildZhSegments 同一个筛选：只收含中文、不超过 10 字的片段
      if (text.length > 10 || !/[一-鿿]/.test(text)) continue;
      checked++;
      if (!has.get(text, w.id)) missing.push({ id: w.id, seg: text });
    }
  }
  db.close();
  assert.ok(checked > 100, `只查到 ${checked} 个片段，样本太少`);
  assert.deepEqual(missing.slice(0, 5), []);
});

test('spaceCJK 在汉字之间插空格，英文原样', () => {
  assert.equal(spaceCJK('高速铁路'), '高 速 铁 路');
  assert.equal(spaceCJK('high-speed 铁路'), 'high-speed 铁 路');
  assert.equal(spaceCJK(''), '');
});
