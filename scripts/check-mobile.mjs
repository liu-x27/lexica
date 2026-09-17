/** 检查移动版词库的实际覆盖，确认裁剪没砍掉真正会查的词 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { DictDB } = require(path.join(ROOT, 'src', 'main', 'dict-db.js'));

const file = process.argv[2] || path.join(ROOT, 'data', 'dict-mobile-slim.db');
const db = new DictDB(file);
if (!db.open()) {
  console.error('打不开：', db.error);
  process.exit(1);
}
console.log(`词库：${path.basename(file)}\n`);

const GROUPS = {
  常用词: ['run', 'take', 'good', 'happy', 'water', 'people', 'think', 'because'],
  考纲词: ['ephemeral', 'meticulous', 'ubiquitous', 'serendipity', 'candid', 'resilient', 'paradigm', 'nuance'],
  学术词组: ['gradient descent', 'confidence interval', 'cross-validation', 'transfer learning',
    'zero-shot learning', 'natural selection', 'supply chain', 'meta-analysis'],
  专业单词: ['photosynthesis', 'mitochondria', 'entropy', 'covariance', 'catalyst', 'algorithm',
    'chromosome', 'thermodynamics'],
  变形与纠错: ['ran', 'mice', 'children', 'happiest', 'recieve', 'seperate'],
};

let total = 0;
let hit = 0;
for (const [name, list] of Object.entries(GROUPS)) {
  const miss = [];
  for (const w of list) {
    total++;
    const r = db.lookup(w, { noHistory: true });
    if (r.status === 'ok') hit++;
    else miss.push(w);
  }
  console.log(`  ${name.padEnd(10)} ${list.length - miss.length}/${list.length}${miss.length ? '  未命中: ' + miss.join(', ') : ''}`);
}
console.log(`\n合计 ${hit}/${total}`);

console.log('\n中文反查：');
for (const zh of ['光合作用', '梯度下降', '置信区间', '奔跑', '短暂的', '地铁']) {
  const r = db.search(zh, 4);
  console.log(`  ${zh.padEnd(8)} ${r.items.map((i) => i.word).join(', ').slice(0, 60) || '(无)'}`);
}

console.log('\n词条完整性抽查（run）：');
const e = db.lookup('run', { noHistory: true }).entry;
console.log(`  音标 ${e.phon?.main}  标签 ${e.tags.map((t) => t.label).join('/')}  柯林斯 ${e.collins}`);
console.log(`  词形 ${e.forms.length} 组  义项 ${e.senses.reduce((n, g) => n + g.senses.length, 0)} 条`);
console.log(`  例句 ${e.examples.length + Object.values(e.examplesByPos || {}).flat().length} 条`);
console.log(`  词源 ${e.etym ? '有' : '无'}  引文 ${e.quotes.length}  易混词 ${e.confusables.length}`);

console.log('\n练习范围：');
const scopes = db.db.prepare('SELECT tag, COUNT(*) n FROM word_tags WHERE quiz=1 GROUP BY tag ORDER BY n DESC').all();
console.log('  ' + scopes.map((s) => `${s.tag}:${s.n}`).join('  '));

db.close();
