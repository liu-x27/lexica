/** 分析移动版词库的占用构成，判断还能不能再砍 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'dict-mobile.db'), { readOnly: true });
const mb = (n) => (n / 1024 / 1024).toFixed(1).padStart(7) + ' MB';
const num = (n) => Number(n).toLocaleString('en-US');

const total = db.prepare('SELECT SUM(pgsize) n FROM dbstat').get().n;
console.log('占用前 14：');
for (const r of db.prepare('SELECT name, SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 14').all()) {
  console.log(`  ${String(r.name).padEnd(22)} ${mb(Number(r.bytes))}  ${((r.bytes / total) * 100).toFixed(1).padStart(5)}%`);
}

const q = (s) => db.prepare(s).get().n;
const DOMAIN = "translation GLOB '[[]*[]]*' AND translation NOT LIKE '[网络]%'";

console.log('\n单词按权威性分布：');
console.log(`  权威单词(weak=0)   ${num(q('SELECT COUNT(*) n FROM words WHERE is_single=1 AND weak=0')).padStart(12)}`);
console.log(`  有维基条目         ${num(q('SELECT COUNT(*) n FROM words WHERE is_single=1 AND wiki=1')).padStart(12)}`);
console.log(`  有例句或义项       ${num(q('SELECT COUNT(*) n FROM words WHERE is_single=1 AND (n_ex>0 OR n_senses>0)')).padStart(12)}`);
console.log(`  有专业域标记       ${num(q(`SELECT COUNT(*) n FROM words WHERE is_single=1 AND ${DOMAIN}`)).padStart(12)}`);

const keep = q(`SELECT COUNT(*) n FROM words WHERE is_single=1 AND
  (weak=0 OR wiki=1 OR n_ex>0 OR n_senses>0 OR (${DOMAIN}))`);
const all = q('SELECT COUNT(*) n FROM words WHERE is_single=1');
console.log(`\n  满足任一条件       ${num(keep).padStart(12)} / ${num(all)}`);
console.log(`  纯长尾（可再砍）   ${num(all - keep).padStart(12)}`);

console.log('\n长尾单词样例（这些砍掉影响大不大）：');
for (const r of db
  .prepare(
    `SELECT word, translation FROM words
      WHERE is_single=1 AND weak=1 AND wiki=0 AND n_ex=0 AND n_senses=0
        AND NOT (${DOMAIN})
      ORDER BY random() LIMIT 12`,
  )
  .all()) {
  console.log(`  ${r.word.padEnd(26)} ${String(r.translation).split('\n')[0].slice(0, 40)}`);
}

db.close();
