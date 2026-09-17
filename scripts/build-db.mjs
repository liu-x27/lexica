/**
 * 把三份原始数据合成一个离线词典库 data/dict.db。
 *
 *   words      词头 + 音标 + 中英释义 + 难度标签 + 词频 + 柯林斯星级 + 词性占比
 *   forms      词形 → 原形 映射（复数/时态/比较级/派生），来自 ECDICT exchange 字段
 *   senses     WordNet 按词性分组的义项：英文释义 + 语义域 + 同/反义 + 上下位
 *   sentences  例句库（英文 + 可选中文对照）
 *   word_sentences  词 ↔ 例句 关联（按质量打分）
 *   fts_en / fts_zh 全文检索（英文 porter 词干；中文按字切分后索引，支持任意长度中文反查）
 *   fuzzy      soundex + trigram 双通道拼写纠错候选
 *
 * 全程只用 node:sqlite，不需要任何原生模块编译。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const OUT = path.join(ROOT, 'data', 'dict.db');

const EC_DB = path.join(RAW, 'ecdict', 'stardict.db');
const WN_DIR = path.join(RAW, 'wordnet', 'dict');
const GCIDE_DIR = path.join(RAW, 'gcide', 'gcide-0.53');
const T_ENG = path.join(RAW, 'eng_sentences.tsv');
const T_CMN = path.join(RAW, 'cmn_sentences.tsv');
const T_LINK = path.join(RAW, 'eng-cmn_links.tsv');

/* 每个词最多挂多少条例句；先用中英对照填满，再用纯英文补齐 */
const EX_PER_WORD = 8;
const EX_MIN_TOKENS = 4;   // 句长下限（按全部单词计，不是实词）
const EX_MAX_TOKENS = 22;
const EX_TARGETS_PER_SENT = 6; // 一句最多挂给几个词，避免例句库无谓膨胀

const t0 = Date.now();
const step = (msg) => {
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${s.padStart(6)}s] ${msg}`);
};
const num = (n) => n.toLocaleString('en-US');

/* ========================================================================== */
/*  文本工具                                                                   */
/* ========================================================================== */

/** 汉字之间插空格，让 unicode61 分词器把中文切成单字，从而支持任意长度中文反查 */
function spaceCJK(s) {
  if (!s) return '';
  let out = '';
  let prevCJK = false;
  for (const ch of s) {
    const cjk = ch >= '㐀' && ch <= '鿿';
    if (cjk) {
      out += (out && !out.endsWith(' ') ? ' ' : '') + ch;
    } else {
      if (prevCJK && ch !== ' ') out += ' ';
      out += ch;
    }
    prevCJK = cjk;
  }
  return out;
}

/** 标准美式 Soundex，用作拼写纠错的音近候选键 */
function soundex(word) {
  const s = word.toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  const code = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2,
                 D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
  let out = s[0];
  let last = code[s[0]] || 0;
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const c = s[i];
    const d = code[c] || 0;
    if (d && d !== last) out += d;
    if (c !== 'H' && c !== 'W') last = d;
  }
  return out.padEnd(4, '0');
}

const STOP = new Set(
  ('a an the and or but if then than that this these those of in on at to for with without from by as is are was were be been being am do does did doing have has had having will would can could shall should may might must not no nor so such very too also just only own same s t don now i you he she it we they me him her them my your his its our their what which who whom whose when where why how all any both each few more most other some there here about into over under again further once out up down off above below between through during before after while because until against among'
  ).split(' '),
);

/* ========================================================================== */
/*  1. 建库与表结构                                                            */
/* ========================================================================== */

function openOut() {
  fs.rmSync(OUT, { force: true });
  fs.rmSync(`${OUT}-journal`, { force: true });
  const db = new DatabaseSync(OUT);
  db.exec(`
    PRAGMA page_size = 8192;
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -262144;   -- 256MB 页缓存，批量写入用
  `);
  db.function('space_cjk', { deterministic: true }, (s) => spaceCJK(s || ''));
  db.function('sdx', { deterministic: true }, (s) => soundex(s || ''));
  return db;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE words (
      id          INTEGER PRIMARY KEY,
      word        TEXT NOT NULL,
      wkey        TEXT NOT NULL,          -- 小写规范化键
      phonetic    TEXT,
      translation TEXT,                   -- 中文释义（按行，形如 "n. 说明"）
      definition  TEXT,                   -- 英文释义
      pos         TEXT,                   -- 词性占比，如 "n:76/v:24"
      collins     INTEGER DEFAULT 0,      -- 柯林斯星级 1-5
      oxford      INTEGER DEFAULT 0,      -- 是否牛津 3000 核心词
      tag         TEXT,                   -- zk gk ky cet4 cet6 toefl ielts gre
      bnc         INTEGER DEFAULT 0,      -- BNC 词频排名
      frq         INTEGER DEFAULT 0,      -- 当代语料库词频排名
      exchange    TEXT,                   -- 词形变化原始串
      rank        INTEGER DEFAULT 999999, -- 综合词频排名（越小越常用）
      is_single   INTEGER DEFAULT 0,      -- 是否单词（非词组）
      n_senses    INTEGER DEFAULT 0,
      n_ex        INTEGER DEFAULT 0,
      -- weak=1 表示这条没有任何权威信号（无词频、无柯林斯、无考纲标签、WordNet 也没收）。
      -- ECDICT 从网络语料聚合而来，收了大量常见错拼（recieve、wierd）和纯变形（ran、mice），
      -- 它们都会落在 weak=1 里。搜索排序、拼写纠错候选池都靠这个字段过滤。
      weak        INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE forms (
      form  TEXT NOT NULL,
      lemma TEXT NOT NULL,
      kind  TEXT NOT NULL     -- s复数 p过去式 d过去分词 i现在分词 3三单 r比较级 t最高级 0原形 1派生
    );

    CREATE TABLE senses (
      id        INTEGER PRIMARY KEY,
      word_id   INTEGER NOT NULL,
      pos       TEXT NOT NULL,   -- n / v / adj / adv
      sense_num INTEGER NOT NULL,
      gloss     TEXT NOT NULL,   -- 英文释义
      domain    TEXT,            -- 语义域，如 noun.animal
      synonyms  TEXT,            -- 同义词，逗号分隔
      antonyms  TEXT,
      hypernyms TEXT,            -- 上位词
      hyponyms  TEXT,            -- 下位词
      examples  TEXT             -- WordNet 自带例句，\\n 分隔
    );

    CREATE TABLE sentences (
      id INTEGER PRIMARY KEY,
      en TEXT NOT NULL,
      zh TEXT
    );

    CREATE TABLE word_sentences (
      word_id  INTEGER NOT NULL,
      sent_id  INTEGER NOT NULL,
      score    INTEGER NOT NULL,
      -- pos      词头在该句中的语法角色（n/v/adj/adv），判不出来就留空。
      --          覆盖率远高于 sense_id，用来把例句归到对应词性分组下。
      -- sense_id 精确匹配到的 WordNet 义项，要求证据足够强，宁缺勿错。
      pos      TEXT,
      sense_id INTEGER
    );

    -- GCIDE（韦氏 1913）只取词源与古典引文，不取它 1913 年的释义，
    -- 免得和 WordNet / ECDICT 的现代释义互相冲突制造噪声。
    CREATE TABLE etym (
      word_id INTEGER PRIMARY KEY,
      text    TEXT NOT NULL
    );

    CREATE TABLE quotes (
      id      INTEGER PRIMARY KEY,
      word_id INTEGER NOT NULL,
      text    TEXT NOT NULL,
      author  TEXT
    );

    CREATE TABLE fuzzy (
      wkey TEXT NOT NULL,
      sdx  TEXT NOT NULL,
      len  INTEGER NOT NULL,
      rank INTEGER NOT NULL
    );

    /* 中文释义切出的「完整义项片段」。
       中文反查时，查询词等于某个片段（查「高铁」命中释义里独立的一项「高铁」）
       就是相关性最高的情况，这张表让这种匹配变成索引查找。
       否则只能靠 fts_zh + bm25 排序，而单字查询命中量太大（「的」42 万条），
       排序要 460ms。 */
    CREATE TABLE zh_seg (
      seg     TEXT NOT NULL,
      word_id INTEGER NOT NULL,
      rank    INTEGER NOT NULL,
      weak    INTEGER NOT NULL
    );

    /* 考纲/词表归属。words.tag 是空格分隔的字符串，按 LIKE '%toefl%' 抽词要全表扫
       340 万行（实测 282ms）。拆成独立表加索引后，抽题是毫秒级。
       quiz=1 表示这个词够出题：有中文释义，且有例句或 WordNet 义项。 */
    CREATE TABLE word_tags (
      tag     TEXT NOT NULL,
      word_id INTEGER NOT NULL,
      rank    INTEGER NOT NULL,
      quiz    INTEGER NOT NULL
    );

    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
  `);
}

/* ========================================================================== */
/*  2. ECDICT → words                                                         */
/* ========================================================================== */

function importEcdict(db) {
  if (!fs.existsSync(EC_DB)) throw new Error(`找不到 ECDICT 数据库：${EC_DB}\n请先运行 npm run fetch`);
  db.exec(`ATTACH DATABASE '${EC_DB.replace(/'/g, "''")}' AS ec`);

  const total = db.prepare('SELECT COUNT(*) c FROM ec.stardict').get().c;
  step(`ECDICT 词条数 ${num(total)}，开始导入…`);

  // 全部在 SQL 侧完成，避免 340 万行往返 JS
  db.exec(`
    INSERT INTO words (id, word, wkey, phonetic, translation, definition, pos,
                       collins, oxford, tag, bnc, frq, exchange, rank, is_single)
    SELECT
      id,
      word,
      lower(word),
      NULLIF(TRIM(COALESCE(phonetic, '')), ''),
      NULLIF(TRIM(COALESCE(translation, '')), ''),
      NULLIF(TRIM(COALESCE(definition, '')), ''),
      NULLIF(TRIM(COALESCE(pos, '')), ''),
      COALESCE(collins, 0),
      COALESCE(oxford, 0),
      NULLIF(TRIM(COALESCE(tag, '')), ''),
      COALESCE(bnc, 0),
      COALESCE(frq, 0),
      NULLIF(TRIM(COALESCE(exchange, '')), ''),
      CASE
        WHEN COALESCE(frq,0) > 0 AND COALESCE(bnc,0) > 0 THEN MIN(frq, bnc)
        WHEN COALESCE(frq,0) > 0 THEN frq
        WHEN COALESCE(bnc,0) > 0 THEN bnc
        ELSE 999999
      END,
      CASE WHEN word NOT GLOB '* *' THEN 1 ELSE 0 END
    FROM ec.stardict
    WHERE word IS NOT NULL AND TRIM(word) <> ''
  `);

  const got = db.prepare('SELECT COUNT(*) c FROM words').get().c;
  const singles = db.prepare('SELECT COUNT(*) c FROM words WHERE is_single = 1').get().c;
  step(`words 写入 ${num(got)} 行（其中单词 ${num(singles)}，词组 ${num(got - singles)}）`);

  db.exec('DETACH DATABASE ec');
}

/* ========================================================================== */
/*  3. exchange → forms（词形还原表）                                          */
/* ========================================================================== */

function buildForms(db) {
  const ins = db.prepare('INSERT INTO forms (form, lemma, kind) VALUES (?, ?, ?)');
  const sel = db.prepare(
    'SELECT id, word, exchange FROM words WHERE exchange IS NOT NULL AND id > ? ORDER BY id LIMIT 20000',
  );

  let lastId = 0;
  let rows = 0;
  let scanned = 0;
  db.exec('BEGIN');
  for (;;) {
    const batch = sel.all(lastId);
    if (!batch.length) break;
    for (const r of batch) {
      lastId = r.id;
      scanned++;
      const seen = new Set();
      for (const part of r.exchange.split('/')) {
        const i = part.indexOf(':');
        if (i < 1) continue;
        const kind = part.slice(0, i);
        const val = part.slice(i + 1).trim();
        if (!val || val === '_') continue;
        if (kind === '0') {
          // 0 = 本词的原形 → 本词是 val 的一个变形
          const k = `${r.word} ${val}`;
          if (!seen.has(k)) { seen.add(k); ins.run(r.word.toLowerCase(), val.toLowerCase(), '0'); rows++; }
        } else if (kind === '1') {
          // 1 = 变形类型说明（如 s:p），不是词形本身
          continue;
        } else {
          // s/p/d/i/3/r/t = 由本词派生出的形态 → val 是 本词 的变形
          for (const v of val.split(',')) {
            const vv = v.trim().toLowerCase();
            if (!vv) continue;
            const k = `${vv} ${kind}`;
            if (!seen.has(k)) { seen.add(k); ins.run(vv, r.word.toLowerCase(), kind); rows++; }
          }
        }
      }
    }
    if (scanned % 200000 < 20000) step(`  forms 解析中… 已扫描 ${num(scanned)} 个带词形变化的词`);
  }
  db.exec('COMMIT');
  step(`forms 写入 ${num(rows)} 行（来自 ${num(scanned)} 个词条的 exchange 字段）`);
}

/* ========================================================================== */
/*  4. WordNet → senses                                                       */
/* ========================================================================== */

const WN_POS_FILE = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' };
const WN_POS_OUT = { n: 'n', v: 'v', a: 'adj', r: 'adv' };

/**
 * 语义域编号表。WordNet 3.1 的 dict/ 目录里不再附 lexnames 文件（3.0 才有），
 * 但这套编号是 WordNet 的固定约定，直接内置；若日后目录里有该文件则优先读文件。
 */
const LEXNAMES = [
  'adj.all', 'adj.pert', 'adv.all', 'noun.Tops', 'noun.act', 'noun.animal',
  'noun.artifact', 'noun.attribute', 'noun.body', 'noun.cognition',
  'noun.communication', 'noun.event', 'noun.feeling', 'noun.food', 'noun.group',
  'noun.location', 'noun.motive', 'noun.object', 'noun.person', 'noun.phenomenon',
  'noun.plant', 'noun.possession', 'noun.process', 'noun.quantity', 'noun.relation',
  'noun.shape', 'noun.state', 'noun.substance', 'noun.time', 'verb.body',
  'verb.change', 'verb.cognition', 'verb.communication', 'verb.competition',
  'verb.consumption', 'verb.contact', 'verb.creation', 'verb.emotion', 'verb.motion',
  'verb.perception', 'verb.possession', 'verb.social', 'verb.stative', 'verb.weather',
  'adj.ppl',
];

async function loadLexnames() {
  const file = path.join(WN_DIR, 'lexnames');
  if (fs.existsSync(file)) {
    const out = {};
    for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) {
      const [n, name] = line.trim().split(/\s+/);
      if (name) out[parseInt(n, 10)] = name;
    }
    if (Object.keys(out).length) return out;
  }
  return Object.fromEntries(LEXNAMES.map((name, i) => [i, name]));
}

/** 解析 data.<pos>，返回 Map<offset, synset> */
async function parseWnData(posChar, lexnames) {
  const file = path.join(WN_DIR, `data.${WN_POS_FILE[posChar]}`);
  const text = await fsp.readFile(file, 'latin1');
  const map = new Map();

  for (const line of text.split('\n')) {
    if (!line || line.startsWith('  ')) continue;
    const bar = line.indexOf('|');
    const head = (bar >= 0 ? line.slice(0, bar) : line).trim().split(/\s+/);
    const glossRaw = bar >= 0 ? line.slice(bar + 1).trim() : '';

    const offset = head[0];
    const lexFile = parseInt(head[1], 10);
    const wCnt = parseInt(head[3], 16);

    const wordsInSynset = [];
    let p = 4;
    for (let i = 0; i < wCnt; i++) {
      wordsInSynset.push(head[p].replace(/\(.*\)$/, '').replace(/_/g, ' '));
      p += 2; // word + lex_id
    }

    const ptrCnt = parseInt(head[p++], 10) || 0;
    const ptrs = [];
    for (let i = 0; i < ptrCnt; i++) {
      ptrs.push({ sym: head[p], off: head[p + 1], pos: head[p + 2], st: head[p + 3] });
      p += 4;
    }

    // gloss 形如：definition; "example one"; "example two"
    const examples = [];
    let definition = glossRaw;
    const qm = glossRaw.indexOf('"');
    if (qm >= 0) {
      definition = glossRaw.slice(0, qm).replace(/;\s*$/, '').trim();
      for (const m of glossRaw.slice(qm).matchAll(/"([^"]+)"/g)) {
        const ex = m[1].trim().replace(/\s*;\s*$/, '');
        if (ex.length > 3) examples.push(ex);
      }
    }
    definition = definition.replace(/;\s*$/, '').trim();

    map.set(offset, {
      words: wordsInSynset,
      ptrs,
      definition,
      examples,
      domain: lexnames[lexFile] || null,
    });
  }
  return map;
}

async function importWordNet(db) {
  if (!fs.existsSync(WN_DIR)) {
    step('! 未找到 WordNet 数据，跳过义项导入');
    return;
  }

  const lexnames = await loadLexnames();

  const data = {};
  for (const pc of Object.keys(WN_POS_FILE)) {
    data[pc] = await parseWnData(pc, lexnames);
    step(`  WordNet data.${WN_POS_FILE[pc]} 解析出 ${num(data[pc].size)} 个同义词集`);
  }

  // 词头 → id（只认单词与词组的精确小写匹配）
  const idOf = new Map();
  {
    const sel = db.prepare('SELECT id, wkey, rank FROM words WHERE id > ? ORDER BY id LIMIT 50000');
    let last = 0;
    for (;;) {
      const b = sel.all(last);
      if (!b.length) break;
      for (const r of b) {
        last = r.id;
        const prev = idOf.get(r.wkey);
        // 同一 wkey 若有多行，留词频更靠前的
        if (prev === undefined || r.rank < prev.rank) idOf.set(r.wkey, { id: r.id, rank: r.rank });
      }
    }
    step(`  建立词头索引 ${num(idOf.size)} 条`);
  }

  const resolve = (ptrs, syms, posChar) => {
    const out = [];
    for (const p of ptrs) {
      if (!syms.includes(p.sym)) continue;
      const src = data[p.pos] || data[posChar];
      const syn = src?.get(p.off);
      if (syn) for (const w of syn.words) if (!out.includes(w)) out.push(w);
      if (out.length >= 12) break;
    }
    return out.join(', ') || null;
  };

  const ins = db.prepare(`
    INSERT INTO senses (word_id, pos, sense_num, gloss, domain, synonyms, antonyms, hypernyms, hyponyms, examples)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let senseRows = 0;
  let missed = 0;
  db.exec('BEGIN');

  for (const posChar of Object.keys(WN_POS_FILE)) {
    const idxFile = path.join(WN_DIR, `index.${WN_POS_FILE[posChar]}`);
    const text = await fsp.readFile(idxFile, 'latin1');

    for (const line of text.split('\n')) {
      if (!line || line.startsWith('  ')) continue;
      const f = line.trim().split(/\s+/);
      // lemma pos synset_cnt p_cnt [ptr_symbol...] sense_cnt tagsense_cnt offset...
      const lemma = f[0].replace(/_/g, ' ');
      const synsetCnt = parseInt(f[2], 10);
      const pCnt = parseInt(f[3], 10);
      const offStart = 4 + pCnt + 2;
      const offsets = f.slice(offStart, offStart + synsetCnt);

      const hit = idOf.get(lemma.toLowerCase());
      if (!hit) { missed++; continue; }

      let n = 0;
      for (const off of offsets) {
        const syn = data[posChar].get(off);
        if (!syn || !syn.definition) continue;
        n++;
        const syns = syn.words.filter((w) => w.toLowerCase() !== lemma.toLowerCase());
        ins.run(
          hit.id,
          WN_POS_OUT[posChar],
          n,
          syn.definition,
          syn.domain,
          syns.slice(0, 12).join(', ') || null,
          resolve(syn.ptrs, ['!'], posChar),
          resolve(syn.ptrs, ['@', '@i'], posChar),
          resolve(syn.ptrs, ['~', '~i'], posChar),
          syn.examples.length ? syn.examples.join('\n') : null,
        );
        senseRows++;
      }
    }
    step(`  index.${WN_POS_FILE[posChar]} 导入完成，累计义项 ${num(senseRows)}`);
  }

  db.exec('COMMIT');
  step(`senses 写入 ${num(senseRows)} 行（${num(missed)} 个 WordNet 词头在 ECDICT 中无对应，已跳过）`);
}

/* ========================================================================== */
/*  4b. GCIDE → etym / quotes                                                  */
/* ========================================================================== */

/**
 * GCIDE 用 `<oum/` 这类自闭合空标签表示特殊字符。
 * 只映射在词源和引文里真正常见的那些，其余静默丢弃。
 */
const GCIDE_ENT = {
  amac: 'ā', emac: 'ē', imac: 'ī', omac: 'ō', umac: 'ū', ymac: 'ȳ',
  abreve: 'ă', ebreve: 'ĕ', ibreve: 'ĭ', obreve: 'ŏ', ubreve: 'ŭ',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  aum: 'ä', eum: 'ë', ium: 'ï', oum: 'ö', uum: 'ü', yum: 'ÿ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  atil: 'ã', ntil: 'ñ', otil: 'õ',
  ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', ccedil: 'ç', eth: 'ð', thorn: 'þ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', prime: '′', dprime: '″',
  deg: '°', sect: '§', para: '¶', dagger: '†', ddagger: '‡',
  frac12: '½', frac14: '¼', frac34: '¾',
  times: '×', divide: '÷', plusmn: '±', pound: '£',
};

/** 去掉 SGML 标记与元数据，还原成干净的一行文本 */
function gcideClean(s) {
  return s
    // [<source>1913 Webster</source>] 之类的出处标注是元数据，不是内容
    .replace(/\[\s*(<source>[^<]*<\/source>\s*)+\]/g, ' ')
    .replace(/<source>[^<]*<\/source>/g, ' ')
    // 自闭合空标签 → 对应字符
    .replace(/<([A-Za-z0-9]+)\/>?/g, (m, name) => GCIDE_ENT[name] ?? '')
    // 其余成对标签只保留内容
    .replace(/<\/?[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const QUOTES_PER_WORD = 4;

async function importGcide(db) {
  if (!fs.existsSync(GCIDE_DIR)) {
    step('! 未找到 GCIDE 数据，跳过词源与古典引文');
    return;
  }

  // 词头 → id（只认单词与词组的小写精确匹配，取词频靠前的那条）
  const idOf = new Map();
  {
    const sel = db.prepare('SELECT id, wkey, rank FROM words WHERE id > ? ORDER BY id LIMIT 50000');
    let last = 0;
    for (;;) {
      const b = sel.all(last);
      if (!b.length) break;
      for (const r of b) {
        last = r.id;
        const prev = idOf.get(r.wkey);
        if (prev === undefined || r.rank < prev.rank) idOf.set(r.wkey, { id: r.id, rank: r.rank });
      }
    }
  }

  const files = (await fsp.readdir(GCIDE_DIR)).filter((f) => /^CIDE\.[A-Z]$/.test(f)).sort();
  const insE = db.prepare('INSERT OR IGNORE INTO etym (word_id, text) VALUES (?, ?)');
  const insQ = db.prepare('INSERT INTO quotes (word_id, text, author) VALUES (?, ?, ?)');

  const quoteCount = new Map(); // word_id → 已收录条数
  let nEtym = 0;
  let nQuote = 0;
  let nBlocks = 0;
  let missed = 0;

  db.exec('BEGIN');
  for (const file of files) {
    const text = await fsp.readFile(path.join(GCIDE_DIR, file), 'latin1');
    // 条目以 <p> 分块；带 <ent> 的块开启新词头，不带的延续上一个词头
    const blocks = text.split(/<p>/);
    let current = [];

    for (const block of blocks) {
      nBlocks++;
      const ents = [...block.matchAll(/<ent>([^<]+)<\/ent>/g)].map((m) => gcideClean(m[1]).toLowerCase());
      if (ents.length) current = ents;
      if (!current.length) continue;

      const ids = [];
      for (const e of current) {
        const hit = idOf.get(e);
        if (hit) ids.push(hit.id);
      }
      if (!ids.length) { missed++; continue; }

      // 词源：一个词只留第一条（GCIDE 按词性分条，第一条通常最完整）
      const ety = block.match(/<ety>([\s\S]*?)<\/ety>/);
      if (ety) {
        const t = gcideClean(ety[1]).replace(/^\[|\]$/g, '').trim();
        if (t.length > 6 && t.length < 900) {
          for (const id of ids) {
            const before = db.prepare('SELECT 1 FROM etym WHERE word_id = ?').get(id);
            if (!before) { insE.run(id, t); nEtym++; }
          }
        }
      }

      // 引文两种写法：<q>…</q> 配 <qau>，以及 <ldquo/…<rdquo/ 配 <au>
      const quotes = [];
      for (const m of block.matchAll(/<q>([\s\S]*?)<\/q>/g)) quotes.push(m[1]);
      for (const m of block.matchAll(/<ldquo\/>?([\s\S]*?)<rdquo\/>?/g)) quotes.push(m[1]);

      if (quotes.length) {
        const au = block.match(/<qau>([^<]+)<\/qau>/) || block.match(/<au>([^<]+)<\/au>/);
        const author = au ? gcideClean(au[1]).replace(/\.$/, '') : null;
        for (const raw of quotes) {
          const t = gcideClean(raw);
          if (t.length < 24 || t.length > 300 || !/[a-zA-Z]{3}/.test(t)) continue;
          for (const id of ids) {
            const n = quoteCount.get(id) || 0;
            if (n >= QUOTES_PER_WORD) continue;
            quoteCount.set(id, n + 1);
            insQ.run(id, t, author);
            nQuote++;
          }
        }
      }
    }
    step(`  ${file} 处理完成，累计词源 ${num(nEtym)}、引文 ${num(nQuote)}`);
  }
  db.exec('COMMIT');

  db.exec('CREATE INDEX idx_quotes_word ON quotes(word_id)');
  step(`GCIDE 导入完成：词源 ${num(nEtym)} 条、古典引文 ${num(nQuote)} 条`);
  step(`  （扫描 ${num(nBlocks)} 个条目块，${num(missed)} 个词头在 ECDICT 中无对应）`);
}

/* ========================================================================== */
/*  4c. 维基百科跨语言标题 → terms                                             */
/* ========================================================================== */

const WIKI_LANGLINKS = path.join(RAW, 'zhwiki-langlinks.sql.gz');
const WIKI_PAGE = path.join(RAW, 'zhwiki-page.sql.gz');

/**
 * 流式解析 MediaWiki 的 SQL 转储。
 *
 * 转储是若干条巨型 `INSERT INTO x VALUES (...),(...),...;`，
 * 一条语句里可能有上万个元组，不能整文件读进内存。
 * MySQL 的字符串用反斜杠转义，得自己走一遍状态机，不能用正则硬切。
 *
 * @param onRow 每解析出一个元组调用一次，参数是字段数组
 */
async function parseSqlDump(file, onRow) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.startsWith('INSERT INTO')) continue;
    const start = line.indexOf(' VALUES ');
    if (start < 0) continue;

    let i = start + 8;
    const n = line.length;
    while (i < n) {
      if (line[i] !== '(') { i++; continue; }
      i++; // 跳过 (
      const row = [];
      let field = '';
      let quoted = false;

      while (i < n) {
        const c = line[i];
        if (quoted) {
          if (c === '\\') {
            // MySQL 转义：\' \\ \n \r \0 \Z 等
            const next = line[i + 1];
            field += next === 'n' ? '\n' : next === 'r' ? '\r' : next === '0' ? '\0' : next;
            i += 2;
            continue;
          }
          if (c === "'") { quoted = false; i++; continue; }
          field += c;
          i++;
          continue;
        }
        if (c === "'") { quoted = true; i++; continue; }
        if (c === ',') { row.push(field); field = ''; i++; continue; }
        if (c === ')') { row.push(field); i++; break; }
        field += c;
        i++;
      }
      onRow(row);
      // 元组之间的逗号
      while (i < n && (line[i] === ',' || line[i] === ' ')) i++;
      if (line[i] === ';') break;
    }
  }
  rl.close();
}

/**
 * 载入 OpenCC 的繁→简对照。中文维基约一半条目标题是繁体
 * （信賴區間 / 過適 / 量子纏結），不转换对简体用户很别扭。
 * 词组表优先于单字表：「臺灣」整体转比逐字转准。
 */
function loadT2S() {
  const parse = (file) => {
    const map = new Map();
    if (!fs.existsSync(file)) return map;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [k, v] = line.split('\t');
      if (!k || !v) continue;
      // 一个繁体可能对应多个简体候选，取第一个（最常用）
      map.set(k.trim(), v.trim().split(' ')[0]);
    }
    return map;
  };
  const chars = parse(path.join(RAW, 'TSCharacters.txt'));
  const phrases = parse(path.join(RAW, 'TSPhrases.txt'));
  if (!chars.size) return null;

  // 词组按长度降序匹配，避免短词组抢在长词组前面
  const phraseKeys = [...phrases.keys()].sort((a, b) => b.length - a.length);
  const maxPhrase = phraseKeys.length ? phraseKeys[0].length : 0;

  return (s) => {
    if (!s) return s;
    let out = '';
    let i = 0;
    while (i < s.length) {
      let matched = false;
      for (let len = Math.min(maxPhrase, s.length - i); len >= 2; len--) {
        const seg = s.slice(i, i + len);
        const hit = phrases.get(seg);
        if (hit) { out += hit; i += len; matched = true; break; }
      }
      if (matched) continue;
      const c = s[i];
      out += chars.get(c) ?? c;
      i++;
    }
    return out;
  };
}

/** 明显不适合当词典条目的维基标题 */
function isJunkWikiTitle(en, zh) {
  if (!en || !zh) return true;
  if (en.length > 60 || zh.length > 40) return true;
  if (/^(List of|Lists of|Index of|Outline of|Timeline of|Category:|Template:|Portal:|File:|Help:|Wikipedia:)/i.test(en)) return true;
  if (/\(disambiguation\)$/i.test(en) || /（消歧义）$/.test(zh)) return true;
  if (/^\d+(\s|$)/.test(en)) return true;      // 年份、纪年条目
  if (!/[a-zA-Z]/.test(en)) return true;
  if (!/[一-鿿]/.test(zh)) return true;        // 中文标题里没汉字的（多是原文照搬）
  return false;
}

async function importWikiTerms(db) {
  if (!fs.existsSync(WIKI_LANGLINKS) || !fs.existsSync(WIKI_PAGE)) {
    step('! 未找到维基转储，跳过学术术语库');
    return;
  }

  db.exec(`
    /* 维基条目标题的中英对照。
       这是学术术语最好的离线来源：标题对是人工校准的，
       而且「有没有维基条目」本身就是判断词组是否为真实术语的强信号——
       ECDICT 里 gradient descent 和 gradient gun 毫无区别，维基能区分。 */
    CREATE TABLE terms (
      en_key TEXT NOT NULL,
      en     TEXT NOT NULL,
      zh     TEXT NOT NULL
    );
  `);

  // 第一遍：zh 页面 id → en 标题（只要 en 语言的链接）
  const enOf = new Map();
  await parseSqlDump(WIKI_LANGLINKS, (row) => {
    if (row[1] !== 'en') return;
    enOf.set(row[0], row[2]);
  });
  step(`  维基跨语言链接（en）${num(enOf.size)} 条`);

  const t2s = loadT2S();
  step(t2s ? '  已载入繁简对照表' : '  ! 没有繁简表，标题将保留原样（约一半是繁体）');

  // 第二遍：页面表拿 zh 标题，只要主命名空间（ns=0）
  const ins = db.prepare('INSERT INTO terms (en_key, en, zh) VALUES (?, ?, ?)');
  let kept = 0;
  let junk = 0;
  let extraKeys = 0;
  const seen = new Set();

  db.exec('BEGIN');
  await parseSqlDump(WIKI_PAGE, (row) => {
    if (row[1] !== '0') return;
    const en = enOf.get(row[0]);
    if (!en) return;

    let zh = row[2].replace(/_/g, ' ').trim();
    const enTitle = en.replace(/_/g, ' ').trim();
    if (isJunkWikiTitle(enTitle, zh)) { junk++; return; }

    // 中文标题里的括号限定（「嵌入 (数学)」）对查词没用，去掉
    zh = zh.replace(/\s*[（(][^）)]{1,20}[）)]\s*$/, '').trim();
    if (t2s) zh = t2s(zh);
    if (!zh) { junk++; return; }

    const keys = new Set([enTitle.toLowerCase()]);
    /* 英文标题的括号限定要额外建一个键。
       维基上是 "Cross-validation (statistics)"，用户查的是 "cross-validation"，
       不去掉括号就永远命中不了。 */
    const bare = enTitle.replace(/\s*\([^)]{1,40}\)\s*$/, '').trim();
    if (bare && bare !== enTitle) keys.add(bare.toLowerCase());

    for (const k of keys) {
      const dedup = `${k} ${zh}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      ins.run(k, enTitle, zh);
      kept++;
      if (k === bare.toLowerCase() && bare !== enTitle) extraKeys++;
    }
  });
  db.exec('COMMIT');
  enOf.clear();
  seen.clear();
  step(`  其中 ${num(extraKeys)} 条是去掉括号限定后额外建的键`);

  db.exec('CREATE INDEX idx_terms_key ON terms(en_key)');
  step(`terms 写入 ${num(kept)} 条中英术语对（过滤掉 ${num(junk)} 条噪声）`);

  /* 用「有没有维基条目」给词库里的词条打标。
     这是目前唯一能区分 gradient descent 与 gradient gun 的信号。 */
  db.exec(`
    ALTER TABLE words ADD COLUMN wiki INTEGER NOT NULL DEFAULT 0;
    UPDATE words SET wiki = 1
     WHERE wkey IN (SELECT en_key FROM terms);
    CREATE INDEX idx_words_wiki ON words(wiki, rank);
  `);
  const marked = db.prepare('SELECT COUNT(*) c FROM words WHERE wiki = 1').get().c;
  const markedPhrase = db.prepare('SELECT COUNT(*) c FROM words WHERE wiki = 1 AND is_single = 0').get().c;
  step(`  标记出有维基条目的词条 ${num(marked)} 个（其中词组 ${num(markedPhrase)}）`);
}

/* ========================================================================== */
/*  5. Tatoeba → sentences / word_sentences                                    */
/* ========================================================================== */

async function* lines(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  for await (const l of rl) yield l;
}

/**
 * 返回 { words, content }：
 *   words   句子的全部单词数，用来判断句长（含停用词）
 *   content 去掉停用词后的实词，用来决定这句挂到哪些词头下
 *
 * 注意不能用实词数来判断句长：Tatoeba 里大量句子是 "I have a dog" 这种，
 * 去掉停用词只剩一个词，若按实词数过滤会把绝大多数好句子误杀。
 */
function tokenize(en) {
  let words = 0;
  const content = [];
  for (const raw of en.toLowerCase().split(/[^a-z'’-]+/)) {
    const w = raw.replace(/^['’-]+|['’-]+$/g, '');
    if (!w) continue;
    words++;
    if (w.length < 2 || STOP.has(w)) continue;
    content.push(w);
  }
  return { words, content };
}

/** 例句质量分：有中文对照 > 长度适中 > 无生僻大写词 */
function exScore(en, hasZh, nTok) {
  let s = hasZh ? 1000 : 0;
  s += 200 - Math.abs(nTok - 10) * 8;
  if (/[0-9]/.test(en)) s -= 30;
  if (/^[A-Z][a-z]+ [A-Z][a-z]+/.test(en)) s -= 20; // 多半是人名开头
  return s;
}

async function importTatoeba(db) {
  if (!fs.existsSync(T_ENG)) {
    step('! 未找到 Tatoeba 数据，跳过例句导入');
    return;
  }

  // 5.1 英汉对照映射
  const engToCmn = new Map();
  if (fs.existsSync(T_LINK)) {
    for await (const l of lines(T_LINK)) {
      const t = l.indexOf('\t');
      if (t < 0) continue;
      const a = l.slice(0, t);
      const b = l.slice(t + 1).trim();
      if (!engToCmn.has(a)) engToCmn.set(a, b);
    }
  }
  step(`  Tatoeba 英汉对照 ${num(engToCmn.size)} 组`);

  // 5.2 需要用到的中文句子
  const cmnWanted = new Set(engToCmn.values());
  const cmnText = new Map();
  if (fs.existsSync(T_CMN)) {
    for await (const l of lines(T_CMN)) {
      const p = l.split('\t');
      if (p.length < 3) continue;
      if (cmnWanted.has(p[0])) cmnText.set(p[0], p[2].trim());
    }
  }
  step(`  中文句子 ${num(cmnText.size)} 条`);

  // 5.3 词头 → id（只给单词挂例句）
  const idOf = new Map();
  {
    const sel = db.prepare('SELECT id, wkey FROM words WHERE is_single = 1 AND id > ? ORDER BY id LIMIT 50000');
    let last = 0;
    for (;;) {
      const b = sel.all(last);
      if (!b.length) break;
      for (const r of b) { last = r.id; if (!idOf.has(r.wkey)) idOf.set(r.wkey, r.id); }
    }
    step(`  可挂例句的单词 ${num(idOf.size)} 个`);
  }

  /** wordId → [{sid, score}]，只保留前 EX_PER_WORD 条 */
  const bucket = new Map();
  const sentences = new Map(); // sid → {en, zh}
  let nextSid = 1;

  const consider = (en, zh) => {
    const { words, content } = tokenize(en);
    if (words < EX_MIN_TOKENS || words > EX_MAX_TOKENS) return;
    if (en.length > 180 || !content.length) return;
    const score = exScore(en, !!zh, words);

    // 去重后挑出本句里“还缺例句、或者这句比它现有的最差一条更好”的词
    const targets = [];
    const seen = new Set();
    for (const t of content) {
      if (seen.has(t)) continue;
      seen.add(t);
      const id = idOf.get(t);
      if (id === undefined) continue;
      const list = bucket.get(id);
      if (list && list.length >= EX_PER_WORD && list[list.length - 1].score >= score) continue;
      targets.push(id);
      if (targets.length >= EX_TARGETS_PER_SENT) break;
    }
    if (!targets.length) return;

    const sid = nextSid++;
    sentences.set(sid, { en, zh: zh || null });
    for (const id of targets) {
      let list = bucket.get(id);
      if (!list) { list = []; bucket.set(id, list); }
      // 保持按分数降序，末位始终是最差的一条，上面的判断才准
      let i = list.length;
      while (i > 0 && list[i - 1].score < score) i--;
      list.splice(i, 0, { sid, score });
      if (list.length > EX_PER_WORD) list.length = EX_PER_WORD;
    }
  };

  // 5.4 第一遍：只处理有中文对照的句子，优先占位
  let scanned = 0;
  for await (const l of lines(T_ENG)) {
    const p = l.split('\t');
    if (p.length < 3) continue;
    const cid = engToCmn.get(p[0]);
    if (!cid) continue;
    const zh = cmnText.get(cid);
    if (!zh) continue;
    consider(p[2].trim(), zh);
    scanned++;
  }
  step(`  第一遍（中英对照）处理 ${num(scanned)} 句，已产生 ${num(sentences.size)} 条入库例句`);

  // 5.5 第二遍：用纯英文句子补齐仍不足的词
  scanned = 0;
  for await (const l of lines(T_ENG)) {
    const p = l.split('\t');
    if (p.length < 3) continue;
    if (engToCmn.has(p[0]) && cmnText.has(engToCmn.get(p[0]))) continue;
    consider(p[2].trim(), null);
    if (++scanned % 400000 === 0) step(`    …已扫描 ${num(scanned)} 句纯英文`);
  }
  step(`  第二遍（纯英文）处理 ${num(scanned)} 句`);

  // 5.6 落库：只写真正被引用到的句子
  const used = new Set();
  for (const list of bucket.values()) for (const e of list) used.add(e.sid);

  const insS = db.prepare('INSERT INTO sentences (id, en, zh) VALUES (?, ?, ?)');
  const insW = db.prepare('INSERT INTO word_sentences (word_id, sent_id, score) VALUES (?, ?, ?)');

  db.exec('BEGIN');
  for (const sid of used) {
    const s = sentences.get(sid);
    insS.run(sid, s.en, s.zh);
  }
  let links = 0;
  for (const [wid, list] of bucket) {
    for (const e of list) { insW.run(wid, e.sid, e.score); links++; }
  }
  db.exec('COMMIT');

  const bil = db.prepare('SELECT COUNT(*) c FROM sentences WHERE zh IS NOT NULL').get().c;
  step(`sentences 写入 ${num(used.size)} 条（其中中英对照 ${num(bil)} 条），关联 ${num(links)} 组`);
  step(`  有例句的词 ${num(bucket.size)} 个，平均每词 ${(links / bucket.size).toFixed(1)} 条`);
}

/* ========================================================================== */
/*  5b. 例句 → 词性 / 义项 归属                                                */
/* ========================================================================== */

/* 词头前一个词能相当可靠地指示它的语法角色。没有词性标注器，就用这套规则。 */
const CUE_NOUN = new Set(
  ('the a an this that these those its his her their my your our some any no each every another such ' +
   'of in on at for with without from by about into onto over under between among during through ' +
   'good bad new old big small great little long short high low same other first last next many much more most few')
    .split(' '),
);
const CUE_VERB = new Set(
  ("to will would can could should must may might shall let help make don't didn't doesn't won't can't " +
   "i you we they he she it who please never always often sometimes usually just also still already " +
   'and then ' +
   // 完成时与被动语态的助动词：has run / was run over。
   // 有意不收 is/are/am —— 它们后面接名词作表语（"this is progress"）同样常见，会误判。
   'has have had been being was were gets got getting')
    .split(' '),
);

/**
 * 判断词头在句子里当什么词性用。
 * @param words   句子的全部单词（小写、按序，含停用词）
 * @param surface 词头在句中的实际形态集合（词头本身 + 各种变形）
 * @param formPos 形态 → 词性提示（过去式/分词 ⇒ 动词）
 */
function guessUsagePos(words, surface, formPos) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!surface.has(w)) continue;

    // 形态本身就能定性：过去式 / 过去分词 / 现在分词 ⇒ 动词
    const byForm = formPos.get(w);
    if (byForm) return byForm;

    const prev = i > 0 ? words[i - 1] : null;
    if (prev) {
      if (CUE_NOUN.has(prev)) return 'n';
      if (CUE_VERB.has(prev)) return 'v';
    } else {
      // 句首多为主语或祈使句动词，判不准
      continue;
    }
  }
  return null;
}

/* ========================================================================== */
/*  例句 → 词性 / 义项 归属                                                    */
/* ========================================================================== */

/**
 * 把 Tatoeba 例句挂到具体义项上。
 *
 * 做法：给每个义项算一份「签名词集」——释义(gloss) 里的实词 + 同义词 + 上位词，
 * 再看例句的实词和哪个签名重叠最多。同义词/上位词命中算 3 分（信号强），
 * gloss 词命中算 1 分。
 *
 * 两条关键约束：
 *  1. 词头自身及其所有词形必须从签名里剔除。WordNet 的同义词集本来就包含词头
 *     （run 的一个义项同义词是 "flee; take to one's heels; cut and run"），
 *     而每条例句都含词头，不剔除的话那个义项会对所有例句都拿满分——
 *     实测就是这样把 run 的全部例句错绑到「逃跑」义项上的。
 *  2. 最优义项必须明显胜过次优才绑定，否则视为无法判断、留空。
 *
 * 这是启发式，绑不上的比绑上的多；绑定率如实打印。
 */
function bindExamplesToSenses(db) {
  const senseRows = db.prepare(
    `SELECT s.id, s.word_id, s.pos, s.gloss, s.synonyms, s.hypernyms
       FROM senses s
      WHERE s.word_id IN (SELECT DISTINCT word_id FROM word_sentences)`,
  ).all();

  if (!senseRows.length) {
    step('  没有可绑定的义项，跳过');
    return;
  }

  /* 「词头 + 全部词形」排除集。
     注意这里必须一次扫描建映射，不能按词去查 forms 表——
     forms 的索引要到 buildIndexes 才建，逐词查会退化成全表扫描
     （实测 68,000 次 × 45.7 万行 ≈ 9 分钟）。 */
  const excludeOf = new Map(); // word_id → Set（词头 + 全部词形）
  const formPosOf = new Map(); // word_id → Map(形态 → 词性提示)
  {
    const needed = new Map(); // wkey → Set，先按 wkey 聚合再挂到 word_id
    const selWords = db.prepare(
      `SELECT id, wkey, exchange FROM words
        WHERE id IN (SELECT DISTINCT word_id FROM word_sentences)`,
    ).all();

    // exchange 的形态码 → 该形态出现时词头一定在当动词/形容词用
    const FORM_POS = { p: 'v', d: 'v', i: 'v', 3: 'v', r: 'adj', t: 'adj' };

    for (const w of selWords) {
      const ex = new Set([w.wkey]);
      const fp = new Map();
      if (w.exchange) {
        for (const part of w.exchange.split('/')) {
          const code = part.slice(0, part.indexOf(':'));
          const v = part.slice(part.indexOf(':') + 1).trim().toLowerCase();
          for (const one of v.split(',')) {
            const t = one.trim();
            if (!t) continue;
            ex.add(t);
            if (FORM_POS[code] && t !== w.wkey) fp.set(t, FORM_POS[code]);
          }
        }
      }
      excludeOf.set(w.id, ex);
      formPosOf.set(w.id, fp);
      needed.set(w.wkey, ex);
    }

    // 一次顺序扫描 forms，把 lemma 命中的词形补进对应集合
    const allForms = db.prepare('SELECT form, lemma FROM forms').all();
    for (const f of allForms) {
      const ex = needed.get(f.lemma);
      if (ex) ex.add(f.form);
    }
    step(`  已建立 ${num(excludeOf.size)} 个词的词形排除集`);
  }
  const exclusionFor = (wordId) => excludeOf.get(wordId) || new Set();

  // word_id → [{ id, strong:Set, weak:Set }]
  const byWord = new Map();
  for (const s of senseRows) {
    const ex = exclusionFor(s.word_id);
    const strong = new Set();
    for (const part of [s.synonyms, s.hypernyms]) {
      if (!part) continue;
      for (const w of part.split(', ')) {
        for (const t of w.toLowerCase().split(/[^a-z']+/)) {
          if (t.length > 2 && !STOP.has(t) && !ex.has(t)) strong.add(t);
        }
      }
    }
    const weak = new Set();
    for (const t of s.gloss.toLowerCase().split(/[^a-z']+/)) {
      if (t.length > 2 && !STOP.has(t) && !ex.has(t) && !strong.has(t)) weak.add(t);
    }
    if (!byWord.has(s.word_id)) byWord.set(s.word_id, []);
    byWord.get(s.word_id).push({ id: s.id, pos: s.pos, strong, weak });
  }

  const links = db.prepare(
    `SELECT ws.rowid AS rid, ws.word_id, s.en
       FROM word_sentences ws JOIN sentences s ON s.id = ws.sent_id
      ORDER BY ws.word_id`,
  ).all();

  const updPos = db.prepare('UPDATE word_sentences SET pos = ? WHERE rowid = ?');
  const updBoth = db.prepare('UPDATE word_sentences SET pos = ?, sense_id = ? WHERE rowid = ?');

  /* 阈值定得偏保守：要求两个独立信号（两个同义词，或一个同义词加一个释义词），
     单个词重叠不足以定案——之前 MIN_SCORE=3 时，"limit the consumption of white
     sugar" 因为命中「肺结核」义项同义词 white plague 里的 white 就被错绑了。 */
  const MIN_SCORE = 4;
  const MIN_MARGIN = 3;

  let bound = 0;
  let posOnly = 0;
  let ambiguous = 0;

  db.exec('BEGIN');
  for (const link of links) {
    const surface = exclusionFor(link.word_id);
    const formPos = formPosOf.get(link.word_id) || new Map();
    const allWords = link.en.toLowerCase().split(/[^a-z']+/).filter(Boolean);
    const usagePos = guessUsagePos(allWords, surface, formPos);

    const senses = byWord.get(link.word_id) || [];
    // 只保留与句中用法词性一致的义项；判不出词性就不设限
    const pool = usagePos ? senses.filter((s) => s.pos === usagePos) : senses;

    let best = null;
    let bestScore = 0;
    let secondScore = 0;
    if (pool.length) {
      const toks = new Set(tokenize(link.en).content);
      for (const s of pool) {
        let score = 0;
        for (const t of toks) {
          if (s.strong.has(t)) score += 3;
          else if (s.weak.has(t)) score += 1;
        }
        if (score > bestScore) { secondScore = bestScore; bestScore = score; best = s; }
        else if (score > secondScore) secondScore = score;
      }
    }

    const ok = best && bestScore >= MIN_SCORE && (pool.length === 1 || bestScore - secondScore >= MIN_MARGIN);
    if (best && bestScore >= MIN_SCORE && !ok) ambiguous++;

    if (ok) { updBoth.run(usagePos, best.id, link.rid); bound++; }
    else if (usagePos) { updPos.run(usagePos, link.rid); posOnly++; }
  }
  db.exec('COMMIT');

  db.exec('CREATE INDEX idx_ws_sense ON word_sentences(sense_id) WHERE sense_id IS NOT NULL');
  db.exec('CREATE INDEX idx_ws_pos ON word_sentences(word_id, pos)');

  const total = links.length;
  step(`例句归属：精确绑到义项 ${num(bound)} 条（${((bound / total) * 100).toFixed(1)}%）`);
  step(`  另有 ${num(posOnly)} 条只定到词性（${(((bound + posOnly) / total) * 100).toFixed(1)}% 至少有词性归属）`);
  step(`  ${num(ambiguous)} 条证据不足以区分义项，仅保留词性`);
}

/* ========================================================================== */
/*  6. 索引 / 全文检索 / 纠错候选                                              */
/* ========================================================================== */

function buildIndexes(db) {
  step('建立主索引…');
  db.exec(`
    CREATE INDEX idx_words_wkey  ON words(wkey);
    CREATE INDEX idx_words_rank  ON words(rank, id);
    CREATE INDEX idx_words_pref  ON words(wkey, rank);
    CREATE INDEX idx_forms_form  ON forms(form);
    CREATE INDEX idx_forms_lemma ON forms(lemma);
    CREATE INDEX idx_senses_word ON senses(word_id, pos, sense_num);
    CREATE INDEX idx_ws_word     ON word_sentences(word_id, score DESC);
  `);

  step('回填统计字段…');
  db.exec(`
    UPDATE words SET n_senses = (SELECT COUNT(*) FROM senses s WHERE s.word_id = words.id)
      WHERE id IN (SELECT DISTINCT word_id FROM senses);
    UPDATE words SET n_ex = (SELECT COUNT(*) FROM word_sentences w WHERE w.word_id = words.id)
      WHERE id IN (SELECT DISTINCT word_id FROM word_sentences);
  `);

  step('标注权威性（weak 字段）…');
  db.exec(`
    UPDATE words SET weak = 0
     WHERE collins > 0 OR oxford > 0 OR tag IS NOT NULL OR rank < 999999 OR n_senses > 0;
    CREATE INDEX idx_words_strong ON words(wkey, weak, rank);
  `);
  const strong = db.prepare('SELECT COUNT(*) c FROM words WHERE weak = 0 AND is_single = 1').get().c;
  step(`  权威单词 ${num(strong)} 个`);

  step('建立考纲词表索引…');
  buildWordTags(db);

  step('切分中文义项片段…');
  buildZhSegments(db);

  step('生成易混词对…');
  buildConfusables(db);

  /* 全文索引必须覆盖短语。
     之前条件写的是 (is_single = 1 OR rank < 300000)，但短语几乎都没有词频记录
     （rank 一律 999999），结果 204 万条带中文释义的短语一条都没进索引——
     中文反查「高铁」查不到 high-speed rail 就是这个原因。 */
  step('建立英文全文索引（porter 词干）…');
  db.exec(`
    CREATE VIRTUAL TABLE fts_en USING fts5(
      word, definition,
      tokenize = 'porter unicode61 remove_diacritics 2',
      content = ''
    );
    INSERT INTO fts_en (rowid, word, definition)
      SELECT id, word, COALESCE(definition, '')
      FROM words WHERE definition IS NOT NULL;
  `);
  step(`  英文索引 ${num(db.prepare('SELECT COUNT(*) c FROM fts_en').get().c)} 条`);

  // ---- 中文反查：汉字之间插空格后按 unicode61 索引，任意长度中文都能命中
  step('建立中文反查索引…');
  db.exec(`
    CREATE VIRTUAL TABLE fts_zh USING fts5(
      zh,
      tokenize = 'unicode61 remove_diacritics 0',
      content = ''
    );
    INSERT INTO fts_zh (rowid, zh)
      SELECT id, space_cjk(translation)
      FROM words WHERE translation IS NOT NULL;
  `);
  {
    const total = db.prepare('SELECT COUNT(*) c FROM fts_zh').get().c;
    const phrases = db
      .prepare('SELECT COUNT(*) c FROM words WHERE translation IS NOT NULL AND is_single = 0')
      .get().c;
    step(`  中文索引 ${num(total)} 条（其中短语 ${num(phrases)}）`);
  }

  /* 纠错候选池：只收权威词条，否则会把 recieve 之类的错拼当成“正确答案”推荐出去。 */
  const FUZZY_POOL = `is_single = 1 AND weak = 0 AND wkey GLOB '[a-z]*'`;

  // ---- 拼写纠错通道一：trigram 子串索引
  step('建立 trigram 纠错索引…');
  db.exec(`
    CREATE VIRTUAL TABLE fts_tri USING fts5(w, tokenize = 'trigram', content = '');
    INSERT INTO fts_tri (rowid, w)
      SELECT id, wkey FROM words
      WHERE ${FUZZY_POOL} AND length(wkey) BETWEEN 3 AND 24;
  `);

  // ---- 拼写纠错通道二：soundex 音近候选
  step('建立 soundex 纠错索引…');
  db.exec(`
    INSERT INTO fuzzy (wkey, sdx, len, rank)
      SELECT wkey, sdx(wkey), length(wkey), rank FROM words
      WHERE ${FUZZY_POOL} AND length(wkey) BETWEEN 2 AND 24;
    CREATE INDEX idx_fuzzy_sdx ON fuzzy(sdx, rank);
    CREATE INDEX idx_fuzzy_len ON fuzzy(len, rank);
  `);
  step(`  纠错候选池 ${num(db.prepare('SELECT COUNT(*) c FROM fuzzy').get().c)} 个词`);
}

/** 考纲标签之外再加几个实用词表范围，练习功能可以直接选 */
const EXTRA_SCOPES = [
  ['oxford', 'oxford > 0'],
  ['collins5', 'collins >= 5'],
  ['collins4', 'collins >= 4'],
  ['top1000', 'rank > 0 AND rank <= 1000'],
  ['top3000', 'rank > 0 AND rank <= 3000'],
  ['top5000', 'rank > 0 AND rank <= 5000'],
];

const EXAM_TAGS = ['zk', 'gk', 'cet4', 'cet6', 'ky', 'ielts', 'toefl', 'gre'];

function buildWordTags(db) {
  // 够出题的判据：有中文释义，且至少有一条例句或一个 WordNet 义项
  const QUIZ = '(translation IS NOT NULL AND (n_ex > 0 OR n_senses > 0))';

  db.exec('BEGIN');
  for (const tag of EXAM_TAGS) {
    db.prepare(
      `INSERT INTO word_tags (tag, word_id, rank, quiz)
         SELECT ?, id, rank, CASE WHEN ${QUIZ} THEN 1 ELSE 0 END
           FROM words
          WHERE is_single = 1 AND tag LIKE '%' || ? || '%'`,
    ).run(tag, tag);
  }
  for (const [name, cond] of EXTRA_SCOPES) {
    db.prepare(
      `INSERT INTO word_tags (tag, word_id, rank, quiz)
         SELECT ?, id, rank, CASE WHEN ${QUIZ} THEN 1 ELSE 0 END
           FROM words
          WHERE is_single = 1 AND weak = 0 AND ${cond}`,
    ).run(name);
  }
  db.exec('COMMIT');

  db.exec(`
    CREATE INDEX idx_wt_pick ON word_tags(tag, quiz, rank);
    CREATE INDEX idx_wt_word ON word_tags(word_id);
  `);

  const rows = db
    .prepare('SELECT tag, COUNT(*) n, SUM(quiz) q FROM word_tags GROUP BY tag ORDER BY n DESC')
    .all();
  for (const r of rows) step(`  ${r.tag.padEnd(9)} ${num(r.n).padStart(6)} 词，可出题 ${num(r.q)}`);
}

/* 释义行开头的词性缩写与域标记，切片段前要剥掉。
   必须与 src/main/dict-db.js 里的 ZH_NOISE 保持一致。 */
const ZH_NOISE = /^(?:[a-z]{1,5}\.\s*)+|^\[[^\]]{1,6}\]\s*|^(?:un|abbr|pl)\.\s*/i;

/** 把一条中文释义切成独立义项片段 */
function zhSegments(translation) {
  const out = [];
  for (const line of String(translation || '').split(/\r?\n/)) {
    for (const raw of line.split(/[；;，,、]/)) {
      let s = raw.trim().replace(ZH_NOISE, '').replace(ZH_NOISE, '').trim();
      s = s.replace(/^\[[^\]]{1,6}\]\s*/, '').trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function buildZhSegments(db) {
  const ins = db.prepare('INSERT INTO zh_seg (seg, word_id, rank, weak) VALUES (?, ?, ?, ?)');
  const sel = db.prepare(
    `SELECT id, translation, rank, weak FROM words
      WHERE translation IS NOT NULL AND id > ? ORDER BY id LIMIT 50000`,
  );

  let last = 0;
  let rows = 0;
  let scanned = 0;
  db.exec('BEGIN');
  for (;;) {
    const batch = sel.all(last);
    if (!batch.length) break;
    for (const r of batch) {
      last = r.id;
      scanned++;
      const seen = new Set();
      for (const s of zhSegments(r.translation)) {
        // 只留含中文、不超过 10 字的片段：更长的片段做精确匹配没有意义
        if (s.length > 10 || !/[一-鿿]/.test(s)) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        ins.run(s, r.id, r.rank, r.weak);
        rows++;
      }
    }
    if (scanned % 500000 < 50000) step(`  已切分 ${num(scanned)} 条释义，片段 ${num(rows)}`);
  }
  db.exec('COMMIT');

  // seg 在前，权威性与词频紧跟，等值查找直接沿索引顺序拿到最相关的
  db.exec('CREATE INDEX idx_zhseg ON zh_seg(seg, weak, rank)');
  step(`zh_seg 写入 ${num(rows)} 个片段（来自 ${num(scanned)} 条释义）`);
}

/**
 * 生成易混词对：拼写相近、但不是同义词也不是词形变化的词。
 * affect/effect、adapt/adopt、principal/principle 这类，是考试里最容易丢分的地方。
 *
 * 全量两两比较是 O(n²)，10 万词要一百亿次，不可行。
 * 这里按「长度 ± 1 且首字母相同」分桶，桶内才算编辑距离——
 * 编辑距离 ≤2 的词几乎不可能长度差超过 2，首字母不同的情况留给 soundex 桶兜底。
 */
function buildConfusables(db) {
  db.exec(`
    CREATE TABLE confusables (
      word_id  INTEGER NOT NULL,
      other_id INTEGER NOT NULL,
      distance INTEGER NOT NULL,
      PRIMARY KEY (word_id, other_id)
    ) WITHOUT ROWID;
  `);

  // 只在「能出题的考纲词」里找，范围小、价值高
  const rows = db.prepare(
    `SELECT DISTINCT w.id, w.wkey, w.rank
       FROM word_tags t JOIN words w ON w.id = t.word_id
      WHERE t.quiz = 1 AND w.is_single = 1 AND length(w.wkey) >= 4
      ORDER BY w.wkey`,
  ).all();
  step(`  候选词 ${num(rows.length)} 个`);

  // 同义词集：同义词不是易混词，要排除
  const synOf = new Map();
  for (const s of db.prepare('SELECT word_id, synonyms FROM senses WHERE synonyms IS NOT NULL').all()) {
    let set = synOf.get(s.word_id);
    if (!set) { set = new Set(); synOf.set(s.word_id, set); }
    for (const w of s.synonyms.split(', ')) if (w) set.add(w.trim().toLowerCase());
  }

  // 词形变化：run/running 不算易混
  const formsOf = new Map();
  for (const f of db.prepare('SELECT form, lemma FROM forms').all()) {
    let set = formsOf.get(f.lemma);
    if (!set) { set = new Set(); formsOf.set(f.lemma, set); }
    set.add(f.form);
  }

  const dist = (a, b, limit) => {
    const m = a.length;
    const n = b.length;
    if (Math.abs(m - n) > limit) return limit + 1;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    let cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      let best = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > limit) return limit + 1;
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  };

  // 分桶：首字母 + 长度。同时把长度 ±1 的桶也纳入比较
  const buckets = new Map();
  for (const r of rows) {
    const key = `${r.wkey[0]}:${r.wkey.length}`;
    let b = buckets.get(key);
    if (!b) { b = []; buckets.set(key, b); }
    b.push(r);
  }

  const ins = db.prepare('INSERT OR IGNORE INTO confusables (word_id, other_id, distance) VALUES (?, ?, ?)');
  let pairs = 0;
  let compared = 0;

  db.exec('BEGIN');
  for (const r of rows) {
    const syn = synOf.get(r.id);
    const forms = formsOf.get(r.wkey);
    const found = [];

    for (const dl of [-1, 0, 1]) {
      const b = buckets.get(`${r.wkey[0]}:${r.wkey.length + dl}`);
      if (!b) continue;
      for (const o of b) {
        if (o.id === r.id) continue;
        compared++;
        // 同义词、词形变化都不算易混
        if (syn?.has(o.wkey)) continue;
        if (forms?.has(o.wkey)) continue;
        if (formsOf.get(o.wkey)?.has(r.wkey)) continue;
        const d = dist(r.wkey, o.wkey, 2);
        if (d > 2 || d === 0) continue;
        found.push({ id: o.id, d, rank: o.rank });
      }
    }

    // 每个词最多留 6 个，优先距离近、词频高的
    found.sort((a, b) => a.d - b.d || a.rank - b.rank);
    for (const f of found.slice(0, 6)) {
      ins.run(r.id, f.id, f.d);
      pairs++;
    }
  }
  db.exec('COMMIT');

  step(`confusables 写入 ${num(pairs)} 对（比较 ${num(compared)} 次）`);
}

function writeMeta(db) {
  const one = (sql) => db.prepare(sql).get().c;
  const stats = {
    built_at: new Date().toISOString(),
    schema: '1',
    words: one('SELECT COUNT(*) c FROM words'),
    words_single: one('SELECT COUNT(*) c FROM words WHERE is_single = 1'),
    forms: one('SELECT COUNT(*) c FROM forms'),
    senses: one('SELECT COUNT(*) c FROM senses'),
    sentences: one('SELECT COUNT(*) c FROM sentences'),
    sentences_bilingual: one('SELECT COUNT(*) c FROM sentences WHERE zh IS NOT NULL'),
    sentences_bound: one('SELECT COUNT(*) c FROM word_sentences WHERE sense_id IS NOT NULL'),
    sentences_pos: one('SELECT COUNT(*) c FROM word_sentences WHERE pos IS NOT NULL'),
    confusables: one('SELECT COUNT(*) c FROM confusables'),
    terms: (() => { try { return one('SELECT COUNT(*) c FROM terms'); } catch { return 0; } })(),
    wiki_marked: (() => { try { return one('SELECT COUNT(*) c FROM words WHERE wiki = 1'); } catch { return 0; } })(),
    etym: one('SELECT COUNT(*) c FROM etym'),
    quotes: one('SELECT COUNT(*) c FROM quotes'),
    with_collins: one('SELECT COUNT(*) c FROM words WHERE collins > 0'),
    with_tag: one('SELECT COUNT(*) c FROM words WHERE tag IS NOT NULL'),
    cet4: one("SELECT COUNT(*) c FROM words WHERE tag LIKE '%cet4%'"),
    cet6: one("SELECT COUNT(*) c FROM words WHERE tag LIKE '%cet6%'"),
    toefl: one("SELECT COUNT(*) c FROM words WHERE tag LIKE '%toefl%'"),
    ielts: one("SELECT COUNT(*) c FROM words WHERE tag LIKE '%ielts%'"),
    gre: one("SELECT COUNT(*) c FROM words WHERE tag LIKE '%gre%'"),
    oxford: one('SELECT COUNT(*) c FROM words WHERE oxford > 0'),
  };
  const ins = db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');
  db.exec('BEGIN');
  for (const [k, v] of Object.entries(stats)) ins.run(k, String(v));
  db.exec('COMMIT');
  return stats;
}

/* ========================================================================== */

async function main() {
  console.log('Lexica 词典库构建\n');
  const db = openOut();
  createSchema(db);

  importEcdict(db);
  buildForms(db);
  await importWordNet(db);
  await importGcide(db);
  await importWikiTerms(db);
  await importTatoeba(db);
  bindExamplesToSenses(db);
  buildIndexes(db);
  const stats = writeMeta(db);

  step('优化与收尾…');
  db.exec('ANALYZE');
  db.exec('PRAGMA optimize');
  db.close();

  const size = (await fsp.stat(OUT)).size;
  console.log('\n构建完成：', OUT);
  console.log(`  体积            ${(size / 1024 / 1024).toFixed(0)} MB`);
  console.log(`  词条            ${num(stats.words)}（单词 ${num(stats.words_single)}）`);
  console.log(`  词形映射        ${num(stats.forms)}`);
  console.log(`  WordNet 义项    ${num(stats.senses)}`);
  console.log(`  例句            ${num(stats.sentences)}（中英对照 ${num(stats.sentences_bilingual)}）`);
  console.log(`  例句定到义项    ${num(stats.sentences_bound)} 条关联`);
  console.log(`  例句定到词性    ${num(stats.sentences_pos)} 条关联`);
  console.log(`  GCIDE 词源      ${num(stats.etym)}`);
  console.log(`  GCIDE 古典引文  ${num(stats.quotes)}`);
  console.log(`  柯林斯星级词    ${num(stats.with_collins)}`);
  console.log(`  牛津 3000       ${num(stats.oxford)}`);
  console.log(`  四级/六级       ${num(stats.cet4)} / ${num(stats.cet6)}`);
  console.log(`  托福/雅思/GRE   ${num(stats.toefl)} / ${num(stats.ielts)} / ${num(stats.gre)}`);
  console.log(`\n耗时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟。启动应用：npm start`);
}

main().catch((err) => {
  console.error('\n构建失败：', err.message);
  console.error(err.stack);
  process.exit(1);
});
