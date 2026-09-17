/**
 * 分析 dict.db 的体积构成，为移动版裁剪提供依据。
 * SQLite 没有直接的「每表占多少字节」，用 dbstat 虚拟表按页统计。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'dict.db'), { readOnly: true });

const mb = (n) => (n / 1024 / 1024).toFixed(1).padStart(8) + ' MB';
const num = (n) => Number(n).toLocaleString('en-US');

const pageSize = db.prepare('PRAGMA page_size').get().page_size;
const pageCount = db.prepare('PRAGMA page_count').get().page_count;
console.log(`页大小 ${pageSize}  总页数 ${num(pageCount)}  总计 ${mb(pageSize * pageCount)}\n`);

let rows = [];
try {
  rows = db
    .prepare(
      `SELECT name, SUM(pgsize) bytes, COUNT(*) pages
         FROM dbstat GROUP BY name ORDER BY bytes DESC`,
    )
    .all();
} catch (e) {
  console.log('dbstat 不可用：', e.message);
}

if (rows.length) {
  console.log('按对象占用排序：');
  const total = rows.reduce((s, r) => s + Number(r.bytes), 0);
  for (const r of rows) {
    const pct = ((Number(r.bytes) / total) * 100).toFixed(1);
    console.log(`  ${String(r.name).padEnd(24)} ${mb(Number(r.bytes))}  ${pct.padStart(5)}%`);
  }
}

console.log('\n各表行数：');
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all();
for (const t of tables) {
  try {
    const c = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c;
    console.log(`  ${t.name.padEnd(24)} ${num(c).padStart(12)}`);
  } catch { /* 虚表的影子表跳过 */ }
}

console.log('\n裁剪候选（词组按有无维基条目/专业标记分类）：');
const q = (sql) => db.prepare(sql).get().n;
const phraseTotal = q('SELECT COUNT(*) n FROM words WHERE is_single = 0');
const phraseWiki = q('SELECT COUNT(*) n FROM words WHERE is_single = 0 AND wiki = 1');
const phraseDomain = q(
  `SELECT COUNT(*) n FROM words WHERE is_single = 0 AND wiki = 0
     AND translation GLOB '[[]*[]]*' AND translation NOT LIKE '[网络]%'`,
);
const phraseNet = q("SELECT COUNT(*) n FROM words WHERE is_single = 0 AND wiki = 0 AND translation LIKE '[网络]%'");
console.log(`  词组总数              ${num(phraseTotal).padStart(12)}`);
console.log(`    有维基条目          ${num(phraseWiki).padStart(12)}  ← 保留`);
console.log(`    无维基但有专业标记  ${num(phraseDomain).padStart(12)}  ← 保留`);
console.log(`    [网络] 机翻         ${num(phraseNet).padStart(12)}  ← 可砍`);
console.log(`    其余无信号          ${num(phraseTotal - phraseWiki - phraseDomain - phraseNet).padStart(12)}  ← 可砍`);

const singleTotal = q('SELECT COUNT(*) n FROM words WHERE is_single = 1');
const singleKeep = q(
  `SELECT COUNT(*) n FROM words WHERE is_single = 1
     AND (weak = 0 OR wiki = 1 OR translation IS NOT NULL)`,
);
console.log(`\n  单词总数              ${num(singleTotal).padStart(12)}`);
console.log(`    有释义/权威/维基    ${num(singleKeep).padStart(12)}`);

db.close();
