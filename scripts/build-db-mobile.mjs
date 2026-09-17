/**
 * 从完整 dict.db 生成移动版精简库。
 *
 *   node scripts/build-db-mobile.mjs
 *
 * 裁剪依据来自 scripts/analyze-db.mjs 的实测占用：
 *   · words 的索引（359MB）比表本身（335MB）还大，其中 idx_words_wkey 与
 *     idx_words_pref 完全被 idx_words_strong(wkey, weak, rank) 覆盖 —— 只建一个
 *   · 204 万词组里有 155.6 万既无维基条目也无专业标记，基本是工业词表碎片，砍掉
 *   · zh_seg 连索引占 243MB，只保留短片段（长片段做精确匹配没有意义）
 *
 * 保留全部功能所需的表，不砍能力，只砍数据量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'dict.db');

/** zh_seg 只留这么长以内的片段 */
const MAX_SEG = 8;
/** 每个词最多保留几条例句 */
const MAX_EX = 4;

/**
 * --slim 会再砍掉「纯长尾单词」：既不权威、无维基条目、无例句义项、也没有专业域标记的。
 * 实测这批是化学品名、古生物属名、生僻缩写、人名音译（Lycopterocypris 狼星介属、
 * Valmidum 炔己蚁胺、tabo 人名），日常与读论文都基本用不到，但占了近百万条。
 */
const SLIM = process.argv.includes('--slim');
const DOMAIN_MARK = "translation GLOB '[[]*[]]*' AND translation NOT LIKE '[网络]%'";
const SINGLE_FILTER = SLIM
  ? `is_single = 1 AND (weak = 0 OR wiki = 1 OR n_ex > 0 OR n_senses > 0 OR (${DOMAIN_MARK}))`
  : 'is_single = 1';

const OUT = path.join(ROOT, 'data', SLIM ? 'dict-mobile-slim.db' : 'dict-mobile.db');

const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
const num = (n) => Number(n).toLocaleString('en-US');
const mb = (n) => (n / 1024 / 1024).toFixed(0) + ' MB';

if (!fs.existsSync(SRC)) {
  console.error('找不到 data/dict.db，先运行 npm run data');
  process.exit(1);
}

fs.rmSync(OUT, { force: true });
const db = new DatabaseSync(OUT);
db.exec(`
  PRAGMA page_size = 4096;   -- 手机上页小一点更省空间
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -262144;
`);
db.exec(`ATTACH DATABASE '${SRC.replace(/'/g, "''")}' AS full`);

/* ---------------------------------------------------------------- words */

/**
 * 按源库的建表语句原样建表，再带条件整表拷贝。
 *
 * 不能手抄 schema：word_tags 在源库里是 (tag, word_id, rank, quiz)，
 * 手写成 (word_id, tag, ...) 之后 `INSERT ... SELECT *` 会静默错位，
 * 结果练习范围的标签全变成了数字 ID —— 实测踩过这个坑。
 */
function cloneTable(name, where = '') {
  const ddl = db.prepare("SELECT sql FROM full.sqlite_master WHERE type='table' AND name=?").get(name);
  if (!ddl?.sql) return false;
  db.exec(ddl.sql); // DDL 里表名不带库前缀，会建在 main 里
  db.exec(`INSERT INTO "${name}" SELECT * FROM full."${name}"${where ? ` WHERE ${where}` : ''}`);
  return true;
}

step('筛选词条…');
/* 单词按档位取舍；词组只留有维基条目或专业域标记的——
   其余是工业词表碎片，既查不到也会把有用的结果挤下去。 */
cloneTable(
  'words',
  `translation IS NOT NULL
     AND ((${SINGLE_FILTER}) OR (is_single = 0 AND (wiki = 1 OR (${DOMAIN_MARK}))))`,
);
const nWords = db.prepare('SELECT COUNT(*) c FROM words').get().c;
const nSingle = db.prepare('SELECT COUNT(*) c FROM words WHERE is_single = 1').get().c;
step(`  保留 ${num(nWords)} 条（单词 ${num(nSingle)}，词组 ${num(nWords - nSingle)}）`);

/* -------------------------------------------------------------- 其余表 */

step('复制词形、义项、术语…');
const inWords = 'word_id IN (SELECT id FROM words)';
cloneTable('forms');
cloneTable('senses', inWords);
cloneTable('terms');
cloneTable('etym', inWords);
cloneTable('quotes', inWords);
cloneTable('confusables', `${inWords} AND other_id IN (SELECT id FROM words)`);
cloneTable('word_tags', inWords);
cloneTable('fuzzy', 'wkey IN (SELECT wkey FROM words WHERE is_single = 1)');
cloneTable('meta');

step('裁剪例句…');
// 建表用源库的 DDL，但内容按「每词最多 N 条」过滤
{
  const ddl = (n) => db.prepare("SELECT sql FROM full.sqlite_master WHERE type='table' AND name=?").get(n).sql;
  db.exec(ddl('word_sentences'));
  db.exec(ddl('sentences'));
  const cols = db
    .prepare('SELECT * FROM pragma_table_info(?)')
    .all('word_sentences')
    .map((c) => `"${c.name}"`)
    .join(', ');
  db.exec(`
    INSERT INTO word_sentences
    SELECT ${cols} FROM (
      SELECT ws.*, ROW_NUMBER() OVER (PARTITION BY ws.word_id ORDER BY ws.score DESC) rn
        FROM full.word_sentences ws
       WHERE ws.word_id IN (SELECT id FROM words)
    ) WHERE rn <= ${MAX_EX};

    INSERT INTO sentences SELECT * FROM full.sentences
     WHERE id IN (SELECT sent_id FROM word_sentences);
  `);
}
step(`  例句 ${num(db.prepare('SELECT COUNT(*) c FROM sentences').get().c)} 条`);

step('裁剪中文片段索引…');
/* 只留 MAX_SEG 字以内的片段：更长的片段做精确匹配没有意义，
   而它连索引在完整库里占了 243MB */
cloneTable('zh_seg', `length(seg) <= ${MAX_SEG} AND word_id IN (SELECT id FROM words)`);
step(`  片段 ${num(db.prepare('SELECT COUNT(*) c FROM zh_seg').get().c)} 条`);

/* ------------------------------------------------------------ 全文索引 */

step('重建全文索引…');
db.exec(`
  CREATE VIRTUAL TABLE fts_zh USING fts5(zh, tokenize = 'unicode61 remove_diacritics 0', content = '');
  CREATE VIRTUAL TABLE fts_en USING fts5(word, definition, tokenize = 'porter unicode61 remove_diacritics 2', content = '');
  CREATE VIRTUAL TABLE fts_tri USING fts5(w, tokenize = 'trigram', content = '');
`);

// space_cjk 与桌面版保持一致：汉字之间插空格，任意长度中文都能反查
db.function('space_cjk', { deterministic: true }, (s) => {
  if (!s) return '';
  let out = '';
  let prev = false;
  for (const ch of String(s)) {
    const cjk = ch >= '一' && ch <= '鿿';
    if (cjk) out += (out && !out.endsWith(' ') ? ' ' : '') + ch;
    else {
      if (prev && ch !== ' ') out += ' ';
      out += ch;
    }
    prev = cjk;
  }
  return out;
});

db.exec(`
  INSERT INTO fts_zh (rowid, zh) SELECT id, space_cjk(translation) FROM words WHERE translation IS NOT NULL;
  INSERT INTO fts_en (rowid, word, definition) SELECT id, word, COALESCE(definition,'') FROM words WHERE definition IS NOT NULL;
  INSERT INTO fts_tri (rowid, w) SELECT id, wkey FROM words
   WHERE is_single = 1 AND weak = 0 AND wkey GLOB '[a-z]*' AND length(wkey) BETWEEN 3 AND 24;
`);

/* ---------------------------------------------------------------- 索引 */

step('建索引…');
db.exec(`
  /* 只建一个 words 的复合索引：wkey 在最前，等值查找与前缀范围都能用，
     完整库里的 idx_words_wkey / idx_words_pref 完全被它覆盖，白占 170MB */
  CREATE INDEX idx_words_strong ON words(wkey, weak, rank);
  CREATE INDEX idx_words_wiki   ON words(wiki, rank);
  CREATE INDEX idx_forms_form   ON forms(form);
  CREATE INDEX idx_forms_lemma  ON forms(lemma);
  CREATE INDEX idx_senses_word  ON senses(word_id, pos, sense_num);
  CREATE INDEX idx_ws_word      ON word_sentences(word_id, score DESC);
  CREATE INDEX idx_ws_pos       ON word_sentences(word_id, pos);
  CREATE INDEX idx_terms_key    ON terms(en_key);
  CREATE INDEX idx_zhseg        ON zh_seg(seg, weak, rank);
  CREATE INDEX idx_quotes_word  ON quotes(word_id);
  CREATE INDEX idx_fuzzy_sdx    ON fuzzy(sdx, rank);
  CREATE INDEX idx_fuzzy_len    ON fuzzy(len, rank);
  CREATE INDEX idx_wt_pick      ON word_tags(tag, quiz, rank);
  CREATE INDEX idx_wt_word      ON word_tags(word_id);
`);

db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('mobile', '1');
db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('words', String(nWords));

step('整理与压实…');
db.exec('ANALYZE');
db.exec('DETACH DATABASE full');
db.exec('VACUUM');
db.close();

const size = fs.statSync(OUT).size;
console.log(`\n移动版词库：${OUT}`);
console.log(`  体积  ${mb(size)}（完整版 ${mb(fs.statSync(SRC).size)}）`);
console.log(`  词条  ${num(nWords)}`);
console.log(`\n耗时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`);
