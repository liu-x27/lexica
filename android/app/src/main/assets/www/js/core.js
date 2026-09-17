/* 由 scripts/build-android-www.mjs 生成，请勿直接编辑。
   内容来自 src/main/，桌面版与安卓版共用同一份实现。 */

/* ---- dict-db (来自 src/main/dict-db.js，未经修改) ---- */
__cjs.define("dict-db", function (module, exports, require) {
'use strict';
/**
 * 词典查询层（主进程内运行，只读打开 dict.db）。
 *
 * 查词的解析顺序：
 *   1. 精确匹配 wkey
 *   2. 词形还原：forms 表 running → run，再查原形
 *   3. 去掉连字符/空格再试一次
 *   4. 拼写纠错：soundex + 等长邻域 + trigram 三路取候选，用 Damerau-Levenshtein 重排
 */
/*
 * 数据库的打开方式是可注入的：
 * 桌面版走 Node 内置的 node:sqlite，安卓版在 WebView 里跑，
 * 由 Kotlin 侧通过 JavascriptInterface 提供一个同样形状的同步实现。
 * 除此之外整个查询层两端共用，不做分叉。
 */
let nodeFs = null;
let openDatabase = null;

try {
  // eslint-disable-next-line global-require
  nodeFs = require('node:fs');
  const { DatabaseSync } = require('node:sqlite');
  openDatabase = (file) => {
    const d = new DatabaseSync(file, { readOnly: true });
    d.exec('PRAGMA cache_size = -65536');
    d.exec('PRAGMA mmap_size = 268435456');
    return d;
  };
} catch {
  // 非 Node 环境（安卓 WebView），等待 setDatabaseOpener 注入
}

/** 供非 Node 环境注入数据库实现 */
function setDatabaseOpener(fn) {
  openDatabase = fn;
}

/* --------------------------------------------------------------- 常量表 */

// ECDICT exchange 字段的形态代码 → 中文名（顺序即展示顺序）
const FORM_LABELS = [
  ['s', '复数'],
  ['p', '过去式'],
  ['d', '过去分词'],
  ['i', '现在分词'],
  ['3', '第三人称单数'],
  ['r', '比较级'],
  ['t', '最高级'],
  ['0', '原形'],
];

// ECDICT 难度标签 → 展示名
const TAG_LABELS = {
  zk: '中考',
  gk: '高考',
  cet4: '四级',
  cet6: '六级',
  ky: '考研',
  toefl: '托福',
  ielts: '雅思',
  gre: 'GRE',
};

// 词性缩写 → 中文名
const POS_NAMES = {
  n: '名词',
  v: '动词',
  vt: '及物动词',
  vi: '不及物动词',
  adj: '形容词',
  a: '形容词',
  adv: '副词',
  r: '副词',
  prep: '介词',
  conj: '连词',
  pron: '代词',
  art: '冠词',
  num: '数词',
  int: '感叹词',
  interj: '感叹词',
  aux: '助动词',
  abbr: '缩写',
  u: '不可数名词',
  c: '可数名词',
  det: '限定词',
  pl: '复数',
  x: '其他',
};

const POS_ORDER = ['n', 'v', 'vt', 'vi', 'adj', 'adv', 'prep', 'conj', 'pron', 'num', 'art', 'int', 'aux', 'abbr'];

/**
 * ECDICT 的 pos 字段（词性占比）用的是另一套单字母码，
 * 源自 Google Ngram 的词性标注，和释义行里的 "n./adj." 缩写不是一套，必须分开映射。
 * 实测出现过：n j v r m u i p c d a t
 */
const POS_RATIO_NAMES = {
  n: '名词',
  v: '动词',
  j: '形容词',
  a: '形容词',
  r: '副词',
  m: '数词',
  i: '介词',
  p: '代词',
  c: '连词',
  d: '限定词',
  t: '助词',
  u: '其他',
  x: '其他',
};

/** 归一到展示分组用的词性键，供词性占比条着色 */
const POS_RATIO_GROUP = { n: 'n', v: 'v', j: 'adj', a: 'adj', r: 'adv', m: 'num', i: 'prep', p: 'pron', c: 'conj' };

/* --------------------------------------------------------------- 工具 */

const isCJK = (s) => /[㐀-鿿　-〿＀-￯]/.test(s);

/** 抽术语时跳过的功能词。命中它们只会得到「用…构成」这类噪音 */
const TERM_STOP = new Set((
  'a an the of to in on for and or with by at as is are am be been being was were '
  + 'that which who whom whose this these those it its from into onto than then thus so such '
  + 'can could may might shall should will would must has have had having do does did done '
  + 'not no nor any all both each every we our us you your they them their he him his she her '
  + 'one two more most much many few less least other others same own very too also only just '
  + 'out up down over under above below about through between within without across along '
  + 'while when where why how what if but because although though however therefore hence '
  + 'there here now new used using use show shows shown given give given based'
).split(' '));

/** 拆成词，去掉标点，同时保留原始大小写（术语展示要用） */
function wordsOf(text) {
  return String(text || '')
    .split(/\s+/)
    .map((t) => t.replace(/^[^A-Za-z'-]+|[^A-Za-z'-]+$/g, ''))
    .filter(Boolean);
}

/**
 * 判断输入该按「句子」还是「词条 / 词组」处理。
 *
 * 分界不需要很精确：判成句子时仍然会附上拆词结果，判成词组时该有的
 * 全文检索也照走，两边都不丢信息。这里只求把明显是句子的挡在拆词逻辑之外——
 * decompose() 本来在超过 8 个词时就直接返回 null，那类输入以前会落到
 * 「没找到」页面，模型明明在本地却根本用不上。
 */
function isSentence(text) {
  const raw = String(text || '').trim();
  if (!raw || isCJK(raw)) return false;
  const n = wordsOf(raw).length;
  if (n >= 6) return true;
  // 四五个词但带句读，多半是短句（"Cite the paper, please."）
  return n >= 4 && /[.!?;:,]/.test(raw.slice(0, -1));
}

/** 汉字之间插空格（必须与 build-db.mjs 中的 spaceCJK 行为一致） */
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

/** Damerau-Levenshtein，带上限提前退出 */
function editDistance(a, b, limit = 4) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > limit) return limit + 1;
  let prev2 = null;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      // 相邻字符调换（recieve ↔ receive）只算一次编辑
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > limit) return limit + 1;
    prev2 = prev;
    prev = cur;
    cur = new Array(n + 1);
  }
  return prev[n];
}

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

/** FTS5 里字符串字面量要用双引号包裹并转义内部双引号 */
const ftsPhrase = (s) => `"${String(s).replace(/"/g, '""')}"`;

/* ------------------------------------------------- 中文反查相关性打分 */

/** 释义行里的词性缩写与域标记，算覆盖率时要先去掉 */
const ZH_NOISE = /^(?:[a-z]{1,5}\.\s*)+|^\[[^\]]{1,6}\]\s*|^(?:un|abbr|pl)\.\s*/i;

/**
 * 把一条中文释义拆成若干「语义片段」。
 * 释义形如 "[网络] 高速铁路；高铁；高铁宝山段"，按标点切开后每段是一个独立义项。
 */
function zhSegments(translation) {
  const out = [];
  for (const line of String(translation || '').split(/\r?\n/)) {
    const isWeb = /^\[网络\]/.test(line);
    for (const raw of line.split(/[；;，,、]/)) {
      let s = raw.trim().replace(ZH_NOISE, '').replace(ZH_NOISE, '').trim();
      s = s.replace(/^\[[^\]]{1,6}\]\s*/, '').trim();
      if (s) out.push({ text: s, web: isWeb });
    }
  }
  return out;
}

/**
 * 中文反查的相关性分。
 *
 * 关键是「查询词占命中片段的比例」：查「高铁」时
 *   hi-rail        释义片段就是「高铁」        → 覆盖率 100%，最相关
 *   siderocyte     片段是「高铁红细胞」        → 覆盖率 2/5，是别的意思
 * 只按词频排序会让有词频记录的化学词（ferric、hematin）把真正的答案压下去，
 * 所以相关性必须是主排序键，词频只作次级加权。
 */
function zhRelevance(query, translation) {
  const q = String(query || '').trim();
  if (!q) return 0;
  let best = 0;
  for (const seg of zhSegments(translation)) {
    const idx = seg.text.indexOf(q);
    if (idx < 0) continue;
    const coverage = q.length / seg.text.length;
    let s = coverage * 1000;
    if (seg.text === q) s += 600; // 片段就等于查询词
    if (idx === 0) s += 160; // 出现在片段开头
    if (seg.web) s -= 90; // [网络] 是机器采集的，质量略低但不能一票否决
    if (s > best) best = s;
  }
  return best;
}

/* ------------------------------------------------------- 字段解析 */

/** "n. 跑\nvi. 奔跑" → [{ pos:'n', posName:'名词', text:'跑' }] */
function parseTranslation(raw) {
  if (!raw) return [];
  const good = [];
  const web = []; // [网络] 开头的是机器采集的网络释义，质量差，仅在没有别的释义时才用
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    // 只剩一个空的域标记（如 "[计]"）时丢掉
    if (/^\[[^\]]*\]$/.test(s)) continue;

    const isWeb = /^\[网络\]/.test(s);
    const body = isWeb ? s.replace(/^\[网络\]\s*/, '') : s;
    if (!body) continue;

    const m = body.match(/^([a-z]{1,5}\.(?:\s*[&,]\s*[a-z]{1,5}\.)*)\s*(.*)$/i);
    const item = m
      ? (() => {
          const abbr = m[1].replace(/\./g, '').split(/\s*[&,]\s*/)[0].toLowerCase();
          return { pos: abbr, posName: POS_NAMES[abbr] || null, text: m[2].trim() || m[1] };
        })()
      : { pos: null, posName: null, text: body };

    (isWeb ? web : good).push(item);
  }
  return good.length ? good : web;
}

function parseDefinition(raw) {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "n:15/v:85"、"j:100" → [{ pos:'adj', posName:'形容词', pct:100 }] */
function parsePosRatio(raw) {
  if (!raw) return [];
  const out = [];
  for (const part of raw.split('/')) {
    const [p, v] = part.split(':');
    const pct = parseInt(v, 10);
    if (!p || Number.isNaN(pct)) continue;
    const code = p.trim().toLowerCase();
    out.push({
      pos: POS_RATIO_GROUP[code] || code,
      posName: POS_RATIO_NAMES[code] || code,
      pct,
    });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

/** exchange 串 → [{ code, label, words:[] }] */
function parseExchange(raw) {
  if (!raw) return [];
  const map = new Map();
  for (const part of raw.split('/')) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const code = part.slice(0, i);
    const val = part.slice(i + 1).trim();
    if (!val || val === '_' || code === '1') continue;
    map.set(code, val.split(',').map((s) => s.trim()).filter(Boolean));
  }
  const out = [];
  for (const [code, label] of FORM_LABELS) {
    if (map.has(code)) out.push({ code, label, words: map.get(code) });
  }
  return out;
}

function parseTags(raw) {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => TAG_LABELS[t])
    .map((t) => ({ code: t, label: TAG_LABELS[t] }));
}

const splitList = (s) => (s ? s.split(', ').map((x) => x.trim()).filter(Boolean) : []);

/**
 * 解析音标字段。
 *
 * ECDICT 并没有英/美双音标：`(?@)`（美式标记）全库只有 41 条，
 * 而逗号绝大多数是次重音记号（`,pælis'tiniәn` 里的逗号 = IPA 的 ˌ），
 * 少数「逗号+空格」是同口音的又读（`di'rektli, dai'rektli`），不是英美对。
 * 所以这里只做三件事：拆出主音标、拆出 (?@) 标注的美式音标、拆出又读变体。
 *
 * 以 `-` 结尾或开头的缩略形式（`'lɔ:ŋ-`、`-dræft`）是「其余同上」的省略写法，
 * 单独展示没有意义，直接丢弃。
 */
function parsePhonetic(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const clean = (x) =>
    x
      .replace(/\(\?@\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const usable = (x) => x && !/^-|-$/.test(x) && /[a-zɑɒæɔəɜɪʊʌθðʃʒŋˈˌ:']/i.test(x);

  let main = null;
  let us = null;
  const alts = [];

  // 分号分段；带 (?@) 的那段是美式
  for (const seg of s.split(';')) {
    const isUS = /\(\?@\)/.test(seg);
    const body = clean(seg);
    if (!body) continue;

    // 段内「逗号 + 空格」才算又读；紧跟字母的逗号是次重音标记，不能拆
    const parts = body.split(/,\s+/).map((p) => p.trim()).filter(Boolean);
    for (const [i, p] of parts.entries()) {
      if (!usable(p)) continue;
      if (isUS && !us) us = p;
      else if (!main) main = p;
      else if (i > 0 || isUS) alts.push(p);
      else alts.push(p);
    }
  }

  if (!main && us) { main = us; us = null; }
  if (!main) return null;

  return {
    main,
    us,
    alts: [...new Set(alts)].filter((a) => a !== main && a !== us).slice(0, 2),
  };
}

/* ========================================================================== */
/*  DictDB                                                                     */
/* ========================================================================== */

class DictDB {
  constructor(file) {
    this.file = file;
    this.db = null;
    this.meta = {};
    this.error = null;
  }

  get ready() {
    return !!this.db;
  }

  open() {
    if (!openDatabase) {
      this.error = '没有可用的数据库实现（需要 Node 的 node:sqlite 或注入的实现）';
      return false;
    }
    // 只有 Node 环境能查文件是否存在；安卓侧由注入实现自己判断
    if (nodeFs && !nodeFs.existsSync(this.file)) {
      this.error = `词典库不存在：${this.file}`;
      return false;
    }
    try {
      this.db = openDatabase(this.file);
      for (const r of this.db.prepare('SELECT k, v FROM meta').all()) this.meta[r.k] = r.v;
      this._prepare();
      return true;
    } catch (e) {
      this.error = e.message;
      this.db = null;
      return false;
    }
  }

  close() {
    try { this.db?.close(); } catch { /* 忽略 */ }
    this.db = null;
  }

  _prepare() {
    const d = this.db;
    this.q = {
      exact: d.prepare(
        `SELECT * FROM words WHERE wkey = ? ORDER BY rank ASC, length(word) ASC LIMIT 1`,
      ),
      byId: d.prepare('SELECT * FROM words WHERE id = ?'),
      lemmaOf: d.prepare('SELECT lemma, kind FROM forms WHERE form = ? LIMIT 8'),
      variantIds: d.prepare(
        `SELECT id FROM words
          WHERE wkey = ?
             OR wkey IN (SELECT form FROM forms WHERE lemma = ?)
          LIMIT 24`,
      ),
      senses: d.prepare(
        `SELECT pos, sense_num, gloss, domain, synonyms, antonyms, hypernyms, hyponyms, examples
           FROM senses WHERE word_id = ? ORDER BY pos, sense_num`,
      ),
      examples: d.prepare(
        `SELECT s.id, s.en, s.zh, ws.score, ws.pos, ws.sense_id
           FROM word_sentences ws JOIN sentences s ON s.id = ws.sent_id
          WHERE ws.word_id = ?
          ORDER BY ws.score DESC LIMIT ?`,
      ),
      etym: d.prepare('SELECT text FROM etym WHERE word_id = ?'),
      confusables: d.prepare(
        `SELECT w.word, w.translation, c.distance
           FROM confusables c JOIN words w ON w.id = c.other_id
          WHERE c.word_id = ? ORDER BY c.distance, w.rank LIMIT 6`,
      ),
      quotes: d.prepare('SELECT text, author FROM quotes WHERE word_id = ? LIMIT 4'),
      // 权威词条优先，其次按词频；否则 ECDICT 里的错拼与生僻缩写会挤在前面
      prefix: d.prepare(
        `SELECT id, word, wkey, phonetic, translation, tag, collins, oxford, rank, weak
           FROM words
          WHERE wkey >= ? AND wkey < ? AND is_single = 1
          ORDER BY weak ASC, rank ASC, length(word) ASC LIMIT ?`,
      ),
      /* 词组按「有没有维基条目」排序。
         词组结构上不可能有词频/柯林斯记录，之前只能退到按词长排，
         结果 gradient gun 把 gradient descent 挤掉了。
         维基条目的有无是目前唯一能区分真实术语与生僻组合的信号。 */
      prefixPhrase: d.prepare(
        `SELECT id, word, wkey, phonetic, translation, tag, collins, oxford, rank, weak, wiki
           FROM words
          WHERE wkey >= ? AND wkey < ? AND is_single = 0
          ORDER BY wiki DESC, weak ASC, rank ASC, length(word) ASC LIMIT ?`,
      ),
      // 含某个词的其它词组。有维基条目的排前面，否则全是 a study、zero G 这类碎片
      phrasesWith: d.prepare(
        `SELECT word, translation, wiki FROM words
          WHERE is_single = 0 AND translation IS NOT NULL
            AND (wkey = ? OR wkey LIKE ? OR wkey LIKE ? OR wkey LIKE ?)
          ORDER BY wiki DESC, length(word) LIMIT ?`,
      ),
      // 维基术语：词库查不到时的第二道来源，也用于给已有词条补术语译名
      term: d.prepare('SELECT en, zh FROM terms WHERE en_key = ? LIMIT 6'),
      termPrefix: d.prepare(
        `SELECT en, zh FROM terms WHERE en_key >= ? AND en_key < ?
          ORDER BY length(en_key) LIMIT ?`,
      ),
      lemmaFromExchange: d.prepare(
        `SELECT id, word, wkey, n_senses, collins, weak FROM words WHERE wkey = ? LIMIT 1`,
      ),
      fuzzySdx: d.prepare('SELECT wkey, rank FROM fuzzy WHERE sdx = ? ORDER BY rank LIMIT 80'),
      fuzzyLen: d.prepare(
        `SELECT wkey, rank FROM fuzzy
          WHERE len BETWEEN ? AND ? AND wkey GLOB ?
          ORDER BY rank LIMIT 400`,
      ),
      fuzzyTri: d.prepare(
        `SELECT w.rowid AS id, wd.wkey, wd.rank
           FROM fts_tri w JOIN words wd ON wd.id = w.rowid
          WHERE fts_tri MATCH ?
          ORDER BY bm25(fts_tri) LIMIT 150`,
      ),
      /* 中文反查先用 bm25 取一批候选，再在 JS 里按「查询词占命中片段的比例」重排
         （见 zhRelevance）。不能直接用 SQL 排序：只按词频排会让有词频记录的
         生僻化学词把真正相关的结果压下去。 */
      searchZh: d.prepare(
        `SELECT w.id, w.word, w.phonetic, w.translation, w.tag, w.collins, w.oxford,
                w.rank, w.weak, w.is_single, w.n_ex
           FROM fts_zh f JOIN words w ON w.id = f.rowid
          WHERE fts_zh MATCH ?
          ORDER BY bm25(fts_zh) LIMIT ?`,
      ),
      /* 精确片段匹配：查询词恰好是某个独立义项。索引 (seg, weak, rank) 让它
         直接按相关性顺序返回，单字查询也是毫秒级。 */
      segExact: d.prepare(
        `SELECT w.id, w.word, w.phonetic, w.translation, w.tag, w.collins, w.oxford,
                w.rank, w.weak, w.is_single, w.n_ex
           FROM zh_seg s JOIN words w ON w.id = s.word_id
          WHERE s.seg = ?
          ORDER BY s.weak ASC, s.rank ASC LIMIT ?`,
      ),
      // 以查询词开头的片段（查「高铁」也能带出「高铁列车」这类）
      segPrefix: d.prepare(
        `SELECT w.id, w.word, w.phonetic, w.translation, w.tag, w.collins, w.oxford,
                w.rank, w.weak, w.is_single, w.n_ex
           FROM zh_seg s JOIN words w ON w.id = s.word_id
          WHERE s.seg > ? AND s.seg < ?
          ORDER BY s.weak ASC, s.rank ASC LIMIT ?`,
      ),
      searchEn: d.prepare(
        `SELECT w.id, w.word, w.phonetic, w.translation, w.tag, w.collins, w.oxford,
                w.rank, w.weak, w.is_single, w.n_ex
           FROM fts_en f JOIN words w ON w.id = f.rowid
          WHERE fts_en MATCH ?
          ORDER BY w.weak ASC, w.rank ASC,
                   (w.phonetic IS NULL) ASC, w.n_ex DESC, length(w.word) ASC
          LIMIT ?`,
      ),
      randomWord: d.prepare(
        `SELECT word FROM words
          WHERE is_single = 1 AND collins >= 4 AND translation IS NOT NULL
            AND rank < 20000 AND id >= ?
          ORDER BY id LIMIT 1`,
      ),
      maxId: d.prepare('SELECT MAX(id) m FROM words'),
    };
  }

  /* ------------------------------------------------------------- 查词 */

  /**
   * @returns {{status:'ok'|'miss', entry?:object, via?:object, suggestions?:array}}
   */
  lookup(input) {
    if (!this.ready) return { status: 'miss', suggestions: [] };
    const raw = String(input || '').trim();
    if (!raw) return { status: 'miss', suggestions: [] };

    // 中文输入没有“词条”可言，直接给反查结果列表
    if (isCJK(raw)) {
      const res = this.search(raw, 60);
      return { status: 'list', kind: 'zh', query: raw, items: res.items };
    }

    const key = raw.toLowerCase();

    // 1. 精确
    let row = this.q.exact.get(key);
    let via = null;

    // 2. 词形还原
    if (!row) {
      for (const f of this.q.lemmaOf.all(key)) {
        const cand = this.q.exact.get(f.lemma);
        if (cand) {
          row = cand;
          const label = FORM_LABELS.find(([c]) => c === f.kind)?.[1] || '变形';
          via = { from: raw, kind: f.kind, label, lemma: cand.word };
          break;
        }
      }
    }

    // 3. 归一化（去连字符/空格、复数 -s 的朴素回退）
    if (!row) {
      const alts = new Set([
        key.replace(/[-\s]/g, ''),
        key.replace(/[-\s]+/g, ' '),
        key.replace(/[-\s]+/g, '-'),
      ]);
      for (const a of alts) {
        if (a === key) continue;
        const cand = this.q.exact.get(a);
        if (cand) { row = cand; via = { from: raw, kind: 'norm', label: '规范化', lemma: cand.word }; break; }
      }
    }

    /* 词库里没有，但维基有对应条目——学术术语大量属于这种情况
       （cross-validation、zero-shot learning 在 ECDICT 里都没有）。
       用术语对拼一个词条出来。 */
    if (!row) {
      const terms = this._terms(key);
      if (terms.length) {
        return { status: 'ok', via: null, corrections: [], weak: false, entry: this._termEntry(raw, terms) };
      }
    }

    /* 长句：交给翻译 + 术语对照，而不是当词组去拆。
       decompose() 超过 8 个词就返回 null，以前这类输入会一路落到「没找到」，
       本地的翻译模型压根没机会被用上。

       拆词与全文检索的结果照样一并返回：句子和长词组的界限本来就模糊
       （"natural language processing toolkit for python" 六个词，算哪种都说得通），
       两边的信息都给出来，判偏了也不损失什么。 */
    if (!row && isSentence(raw)) {
      return {
        status: 'sentence',
        query: raw,
        terms: this.termsIn(raw),
        decomposed: this.decompose(raw),
        items: this.search(raw, 20).items,
      };
    }

    if (!row) {
      // 多词输入：先当释义全文检索，同时给出拆词结果——
      // 读论文划到的词组多半查不到整体，拆开往往就够用了
      if (/[\s-]/.test(raw)) {
        const decomposed = this.decompose(raw);
        const res = this.search(raw, 40);
        if (res.items.length || decomposed) {
          return {
            status: 'list',
            kind: 'en',
            query: raw,
            items: res.items,
            decomposed,
          };
        }
      }
      return { status: 'miss', query: raw, suggestions: this.correct(key, 8) };
    }

    // 4. 纯变形词条转向原形。
    //    ECDICT 给 ran / mice / happiest / children 都单独立了条目，但内容只是
    //    “run的过去式”这类提示，远不如原形词条完整。判据：本条没有 WordNet 义项，
    //    且 exchange 里指明了原形，且原形本身是个内容完整的词条。
    if (!via) {
      const lemma = this._inflectionLemma(row);
      if (lemma) {
        via = { from: row.word, kind: lemma.kind, label: lemma.label, lemma: lemma.row.word };
        row = this.q.exact.get(lemma.row.wkey) || row;
      }
    }

    const entry = this.buildEntry(row);

    // 5. 低可信条目（无词频/无柯林斯/无考纲/WordNet 未收）额外给出拼写纠正建议。
    //    ECDICT 收录了 recieve、wierd 这类常见错拼，直接展示会让人以为拼对了。
    let corrections = [];
    if (row.weak) {
      corrections = this.correct(row.wkey, 4)
        .filter((c) => c.row.wkey !== row.wkey)
        .map((c) => ({ word: c.row.word, brief: this._brief(c.row.translation), distance: c.distance }));
    }

    return { status: 'ok', via, entry, corrections, weak: !!row.weak };
  }

  /**
   * 若本条只是某个词的变形，返回该原形；否则返回 null。
   * @param row words 表的一行
   */
  _inflectionLemma(row) {
    if (!row.exchange || row.n_senses > 0) return null;
    const m = row.exchange.split('/').find((p) => p.startsWith('0:'));
    if (!m) return null;
    const lemmaKey = m.slice(2).trim().toLowerCase();
    if (!lemmaKey || lemmaKey === row.wkey) return null;

    const cand = this.q.lemmaFromExchange.get(lemmaKey);
    // 原形自己也得是个像样的词条，否则转向没有意义
    if (!cand || (cand.n_senses === 0 && cand.collins === 0 && cand.weak)) return null;

    // exchange 里的 "1:x" 说明本条是哪种变形
    const kindPart = row.exchange.split('/').find((p) => p.startsWith('1:'));
    const kind = kindPart ? kindPart.slice(2).trim() : '';
    const label = FORM_LABELS.find(([c]) => c === kind)?.[1] || '变形';
    return { row: cand, kind, label };
  }

  /** 拼装完整词条 */
  buildEntry(row) {
    const wkey = row.wkey;

    // 该词的所有形态对应的词条 id（例句要跨形态汇总：run/ran/running）
    const ids = this.q.variantIds.all(wkey, wkey).map((r) => r.id);
    if (!ids.includes(row.id)) ids.push(row.id);

    /* Tatoeba 例句先取出来，按「绑定到义项 / 只定到词性 / 无归属」三层分开，
       这样渲染时能把例句放到对应的义项或词性分组下面。 */
    const seen = new Set();
    const bySense = new Map(); // sense_id → []
    const byExPos = new Map(); // pos → []
    const examples = []; // 无归属，落到词条末尾的通用例句区
    for (const id of ids) {
      for (const e of this.q.examples.all(id, 10)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const item = { en: e.en, zh: e.zh, source: 'Tatoeba', score: e.score };
        if (e.sense_id) {
          if (!bySense.has(e.sense_id)) bySense.set(e.sense_id, []);
          bySense.get(e.sense_id).push(item);
        } else if (e.pos) {
          if (!byExPos.has(e.pos)) byExPos.set(e.pos, []);
          byExPos.get(e.pos).push(item);
        } else {
          examples.push(item);
        }
      }
    }
    const byScore = (a, b) => b.score - a.score;
    examples.sort(byScore);
    for (const list of byExPos.values()) list.sort(byScore);

    // WordNet 义项按词性分组
    const senseRows = this.q.senses.all(row.id);
    const byPos = new Map();
    for (const s of senseRows) {
      if (!byPos.has(s.pos)) byPos.set(s.pos, []);
      byPos.get(s.pos).push({
        id: s.id,
        num: s.sense_num,
        gloss: s.gloss,
        domain: s.domain,
        synonyms: splitList(s.synonyms),
        antonyms: splitList(s.antonyms),
        hypernyms: splitList(s.hypernyms),
        hyponyms: splitList(s.hyponyms),
        examples: s.examples ? s.examples.split('\n').filter(Boolean) : [],
        tatoeba: (bySense.get(s.id) || []).sort(byScore).slice(0, 3),
      });
    }
    const senses = [...byPos.entries()]
      .map(([pos, list]) => ({ pos, posName: POS_NAMES[pos] || pos, senses: list }))
      .sort((a, b) => {
        const ia = POS_ORDER.indexOf(a.pos);
        const ib = POS_ORDER.indexOf(b.pos);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });

    /* 按词性归好的例句原样交给渲染层分发。
       不在这里直接挂到 senses 上，因为词性分组是「中文释义 + WordNet 义项」
       合并出来的，只有渲染层知道最终有哪些组——纯形容词的词（candid）
       没有 WordNet 名词组，但有中文的 a. 组，例句应该能落进去。 */
    const examplesByPos = {};
    for (const [pos, list] of byExPos) examplesByPos[pos] = list.slice(0, 6);

    // 关系词去重汇总（用于右栏词网）
    const rel = { synonyms: [], antonyms: [], hypernyms: [], hyponyms: [] };
    for (const g of senses) {
      for (const s of g.senses) {
        for (const k of Object.keys(rel)) {
          for (const w of s[k]) if (!rel[k].includes(w) && rel[k].length < 18) rel[k].push(w);
        }
      }
    }

    // 本条自身是变形、但内容足够丰富（如 running / better）时不转向，
    // 只在词头旁边挂一个通往原形的链接。
    let lemmaOf = null;
    if (row.exchange) {
      const p = row.exchange.split('/').find((x) => x.startsWith('0:'));
      const lk = p ? p.slice(2).trim().toLowerCase() : '';
      if (lk && lk !== wkey) {
        const cand = this.q.lemmaFromExchange.get(lk);
        if (cand) {
          const kp = row.exchange.split('/').find((x) => x.startsWith('1:'));
          const kind = kp ? kp.slice(2).trim() : '';
          lemmaOf = { word: cand.word, label: FORM_LABELS.find(([c]) => c === kind)?.[1] || '变形' };
        }
      }
    }

    return {
      id: row.id,
      word: row.word,
      wkey,
      lemmaOf,
      weak: !!row.weak,
      phonetic: row.phonetic,
      phon: parsePhonetic(row.phonetic),
      translation: parseTranslation(row.translation),
      translationRaw: row.translation,
      definition: parseDefinition(row.definition),
      posRatio: parsePosRatio(row.pos),
      forms: parseExchange(row.exchange),
      tags: parseTags(row.tag),
      collins: row.collins || 0,
      oxford: !!row.oxford,
      bnc: row.bnc || 0,
      frq: row.frq || 0,
      rank: row.rank,
      isSingle: !!row.is_single,
      senses,
      examples: examples.slice(0, 10),
      examplesByPos,
      relations: rel,
      // GCIDE（韦氏 1913，公版）提供的词源与古典引文
      etym: this.q.etym.get(row.id)?.text || null,
      // 维基条目给出的术语译名，与 ECDICT 释义互补（学术语境下往往更准）
      terms: this._terms(wkey).map((t) => ({ en: t.en, zh: t.zh })),
      // 拼写相近但意思不同的词，考试最容易在这里丢分
      confusables: this._safe(() =>
        this.q.confusables.all(row.id).map((c) => ({
          word: c.word,
          brief: this._brief(c.translation),
          distance: c.distance,
        })), []),
      quotes: this.q.quotes.all(row.id).map((q) => ({ text: q.text, author: q.author })),
    };
  }

  /* --------------------------------------------------------- 搜索建议 */

  /** 顶部搜索框的下拉建议：英文前缀 / 中文反查 / 纠错 */
  suggest(input, limit = 12) {
    if (!this.ready) return { groups: [] };
    const raw = String(input || '').trim();
    if (!raw) return { groups: [] };

    const groups = [];
    const shape = (r) => ({
      word: r.word,
      phonetic: r.phonetic,
      brief: this._brief(r.translation),
      tags: parseTags(r.tag).map((t) => t.code),
      collins: r.collins || 0,
      oxford: !!r.oxford,
    });

    if (isCJK(raw)) {
      const rows = this._searchZh(raw, limit);
      if (rows.length) groups.push({ kind: 'zh', title: '中文反查', items: rows.map(shape) });
      return { groups };
    }

    const key = raw.toLowerCase();
    const upper = key.slice(0, -1) + String.fromCharCode(key.charCodeAt(key.length - 1) + 1);

    // 精确命中置顶——但弱条目不置顶，否则输入 meti 时垃圾缩写会压在 meticulous 上面
    const hit = this.q.exact.get(key);
    const strongHit = hit && !hit.weak;
    if (strongHit) groups.push({ kind: 'exact', title: '精确匹配', items: [shape(hit)] });

    // 单词前缀
    const pre = this.q.prefix.all(key, upper, limit).filter((r) => !(strongHit && r.wkey === key));
    if (pre.length) groups.push({ kind: 'prefix', title: '以此开头', items: pre.map(shape) });

    // 词组前缀
    const phr = this.q.prefixPhrase.all(key, upper, 5);
    if (phr.length) groups.push({ kind: 'phrase', title: '短语与搭配', items: phr.map(shape) });

    // 没有权威命中时给纠错
    if (!strongHit && pre.filter((r) => !r.weak).length === 0 && key.length >= 3) {
      const corr = this.correct(key, 6);
      if (corr.length) {
        groups.push({
          kind: 'fuzzy',
          title: '拼写建议',
          items: corr.map((c) => ({ ...shape(c.row), distance: c.distance })),
        });
      }
    }

    return { groups };
  }

  /**
   * 抽出句子里词库收录的术语与生词。
   *
   * 机器翻译在句子结构上够用，但专业术语基本靠不住（实测 ablation study
   * 会译成「通膨研究」、large language models 译成「大型语文模式」）。
   * 词典这边虽然覆盖不全，给出的译名却是准的，两者正好互补：
   * 译文看结构，这份列表看术语。
   *
   * 三条降噪规则，都是照着实测结果定的：
   *   - 多词术语必须 wiki=1。不加这条的话 "a form of"、"form of" 这类
   *     ECDICT 收录的功能词组合会把列表淹掉。
   *   - 单词先做词形还原再判罕见度。improving / stored 自己有独立词条，
   *     不还原的话会冒出「有启发的」「储存的」这种既噪音又误导的结果。
   *   - 只留罕见词（bnc/frq 在 4000 名以后）。常用词不需要在这里重复解释。
   *
   * @param {string} text
   * @param {number} limit 最多返回多少条
   * @returns {Array<{surface, word, lemma, phonetic, brief, tags, collins, oxford, wiki, at}>}
   */
  termsIn(text, limit = 16) {
    if (!this.ready) return [];
    const toks = wordsOf(text);
    if (!toks.length) return [];
    const lower = toks.map((t) => t.toLowerCase());

    // 已被更长的术语占用的位置不再参与，避免 "chemical energy" 又拆出 "energy"
    const claimed = new Array(toks.length).fill(false);
    const out = [];

    // 从长到短：长术语优先，命中后就把这几个位置占掉
    for (let n = 4; n >= 1; n--) {
      for (let i = 0; i + n <= toks.length; i++) {
        if (claimed.slice(i, i + n).some(Boolean)) continue;
        const gram = lower.slice(i, i + n).join(' ');

        let row = null;
        let lemma = null;

        if (n > 1) {
          const r = this.q.exact.get(gram);
          if (r && r.wiki) row = r;
        } else {
          if (TERM_STOP.has(gram) || gram.length < 3) continue;
          const hit = this._resolveTerm(gram);
          if (hit && hit.row.weak === 0 && this._isRareWord(hit.row)) {
            row = hit.row;
            lemma = hit.lemma;
          }
        }

        if (!row) continue;
        for (let k = i; k < i + n; k++) claimed[k] = true;
        out.push({
          at: i,
          surface: toks.slice(i, i + n).join(' '),
          word: row.word,
          lemma,
          phonetic: parsePhonetic(row.phonetic)?.main || null,
          brief: this._brief(row.translation),
          tags: parseTags(row.tag),
          collins: row.collins || 0,
          oxford: !!row.oxford,
          wiki: !!row.wiki,
        });
      }
    }

    // 按在句中出现的顺序给，读的时候能对着原文走
    return out.sort((a, b) => a.at - b.at).slice(0, limit);
  }

  /** 单词还原到原形。自己有词条也要看是不是某个词的变形（improving → improve） */
  _resolveTerm(word) {
    for (const f of this.q.lemmaOf.all(word)) {
      const cand = this.q.exact.get(f.lemma);
      if (cand) return { row: cand, lemma: cand.word };
    }
    const own = this.q.exact.get(word);
    return own ? { row: own, lemma: null } : null;
  }

  /**
   * 是不是「值得单独列出来」的罕见词。
   *
   * bnc 与 frq 是词频排名，数字越大越罕见；0 表示两个语料里都没出现，
   * 专业术语大量属于这种情况，所以 0 也算罕见。
   */
  _isRareWord(row) {
    const RARE_AFTER = 4000;
    const bncRare = !row.bnc || row.bnc >= RARE_AFTER;
    const frqRare = !row.frq || row.frq >= RARE_AFTER;
    return bncRare && frqRare;
  }

  /**
   * 词组查不到时，拆成成分词。
   *
   * 读论文时遇到查不到的词组，往往只有其中一个词是障碍——
   * 与其给一句「没找到」，不如把每个词的释义摆出来，再列出库里相关的搭配。
   */
  decompose(phrase) {
    const raw = String(phrase || '').trim();
    if (!raw || !/\s|-/.test(raw)) return null;

    const tokens = raw
      .toLowerCase()
      .split(/[\s\-–—/]+/)
      .map((t) => t.replace(/^[^a-z']+|[^a-z']+$/g, ''))
      .filter(Boolean);
    if (tokens.length < 2 || tokens.length > 8) return null;

    const STOPISH = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'by', 'at', 'as', 'is', 'are', 'be']);

    const parts = [];
    const content = [];
    for (const t of tokens) {
      const res = this.lookup(t);
      const entry = res.status === 'ok' ? res.entry : null;
      const isStop = STOPISH.has(t);
      if (!isStop) content.push(t);
      parts.push({
        word: entry?.word || t,
        query: t,
        stop: isStop,
        found: !!entry,
        phonetic: entry?.phon?.main || null,
        brief: entry ? this._brief(entry.translationRaw) : '',
        // 变形词已经在 lookup 里转向了原形，这里标一下便于展示
        via: res.via ? res.via.lemma : null,
      });
    }

    /* 库里含这些实词的其它词组。
       必须过滤：ECDICT 里有海量 "a study"、"zero G"、"k space" 这种碎片，
       按词长排序会把它们全顶到前面（实测就是这样），对读论文毫无帮助。 */
    const seen = new Set([raw.toLowerCase()]);
    const scored = new Map();
    for (const t of content.slice(0, 4)) {
      let rows = [];
      try {
        rows = this.q.phrasesWith.all(t, `${t} %`, `% ${t}`, `% ${t} %`, 120);
      } catch { /* 忽略 */ }
      for (const r of rows) {
        const k = r.word.toLowerCase();
        if (seen.has(k)) continue;

        const ws = k.split(/[\s-]+/).filter(Boolean);
        // 单字母词（k space、G space）和纯虚词组合（a study、on study）都不是术语
        if (ws.some((w) => w.length < 2)) continue;
        const meaningful = ws.filter((w) => !STOPISH.has(w));
        if (meaningful.length < 2) continue;

        const cur = scored.get(k) || {
          word: r.word,
          brief: this._brief(r.translation),
          hits: 0,
          size: meaningful.length,
        };
        cur.hits++;
        scored.set(k, cur);
      }
    }
    const related = [...scored.values()]
      .sort((a, b) => b.hits - a.hits || b.size - a.size || a.word.length - b.word.length)
      .slice(0, 12);

    return { phrase: raw, parts, related };
  }

  /**
   * 中文反查，三级候选：
   *   1. 精确片段  —— 查询词就是某个独立义项，最相关，走 zh_seg 索引
   *   2. 前缀片段  —— 以查询词开头的义项
   *   3. FTS 子串  —— 出现在义项中间的（「高铁红细胞」这类），相关性最低
   *
   * 第 3 步的 bm25 排序在单字查询上很贵（「的」命中 42 万条要 460ms），
   * 所以只在查询至少两个字、且前两级凑不够结果时才走。
   * 最后统一用 zhRelevance 重排，保证三路来源混在一起顺序也是一致的。
   */
  _searchZh(query, limit = 60) {
    const q = String(query || '').trim();
    if (!q) return [];

    const seen = new Set();
    const rows = [];
    const take = (list) => {
      for (const r of list) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        rows.push(r);
      }
    };

    const want = Math.max(limit * 4, 120);

    try { take(this.q.segExact.all(q, want)); } catch { /* 忽略 */ }

    if (rows.length < want) {
      // 前缀区间：[q, q+￿)
      try { take(this.q.segPrefix.all(q, `${q}￿`, want - rows.length)); } catch { /* 忽略 */ }
    }

    if (rows.length < limit && q.length >= 2) {
      try { take(this.q.searchZh.all(ftsPhrase(spaceCJK(q)), want)); } catch { /* 忽略 */ }
    }

    const scored = rows.map((r) => {
      let s = zhRelevance(q, r.translation);
      if (!r.weak) s += 70; // 有词频/考纲/柯林斯记录的略加分
      if (r.rank < 20000) s += 40;
      if (r.n_ex > 0) s += 15;
      return { r, s };
    });

    scored.sort((a, b) => b.s - a.s || a.r.rank - b.r.rank || a.r.word.length - b.r.word.length);
    return scored.slice(0, limit).map((x) => x.r);
  }

  /** 维基术语译名。旧词库没有 terms 表时安静返回空 */
  _terms(key) {
    return this._safe(() => this.q.term.all(key), []);
  }

  /**
   * 只有维基术语、词库里没有词条时，拼一个最小可用的词条出来。
   * 结构与正常词条一致，渲染层不用写第二套逻辑。
   */
  _termEntry(raw, terms) {
    const zhList = [...new Set(terms.map((t) => t.zh))];
    return {
      id: -2,
      word: terms[0].en || raw,
      wkey: raw.toLowerCase(),
      isTerm: true, // 渲染层据此标注「维基百科术语」
      termSources: terms.map((t) => ({ en: t.en, zh: t.zh })),
      lemmaOf: null,
      weak: false,
      phon: null,
      phonetic: null,
      translation: zhList.map((zh) => ({ pos: null, posName: null, text: zh })),
      translationRaw: zhList.join('；'),
      definition: [],
      posRatio: [],
      forms: [],
      tags: [],
      collins: 0,
      oxford: false,
      bnc: 0,
      frq: 0,
      rank: 999999,
      senses: [],
      examples: [],
      examplesByPos: {},
      relations: { synonyms: [], antonyms: [], hypernyms: [], hyponyms: [] },
      etym: null,
      quotes: [],
      confusables: [],
      terms: [],
    };
  }

  /** 旧版词库可能没有新加的表，取不到就退回默认值而不是整条查词失败 */
  _safe(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  _brief(translation) {
    if (!translation) return '';
    const parts = parseTranslation(translation);
    return parts
      .slice(0, 2)
      .map((p) => (p.pos ? `${p.pos}. ${p.text}` : p.text))
      .join('；')
      .slice(0, 60);
  }

  /* ----------------------------------------------------------- 纠错 */

  /** soundex + 等长邻域 + trigram 三路候选，用编辑距离重排 */
  correct(key, limit = 8) {
    if (!this.ready || !key || isCJK(key)) return [];
    const cands = new Map(); // wkey → rank

    const add = (wkey, rank) => {
      if (!cands.has(wkey)) cands.set(wkey, rank ?? 999999);
    };

    try { for (const r of this.q.fuzzySdx.all(soundex(key))) add(r.wkey, r.rank); } catch { /* ignore */ }

    const lo = Math.max(1, key.length - 2);
    const hi = key.length + 2;
    const head = key[0].replace(/[[\]*?]/g, '');
    try { for (const r of this.q.fuzzyLen.all(lo, hi, `${head}*`)) add(r.wkey, r.rank); } catch { /* ignore */ }

    if (key.length >= 3) {
      const tris = [];
      for (let i = 0; i + 3 <= key.length; i++) tris.push(ftsPhrase(key.slice(i, i + 3)));
      if (tris.length) {
        try { for (const r of this.q.fuzzyTri.all(tris.join(' OR '))) add(r.wkey, r.rank); } catch { /* ignore */ }
      }
    }

    const maxDist = key.length <= 4 ? 1 : key.length <= 8 ? 2 : 3;
    const scored = [];
    for (const [wkey, rank] of cands) {
      if (wkey === key) continue;
      const d = editDistance(key, wkey, maxDist);
      if (d > maxDist) continue;
      scored.push({ wkey, rank, distance: d });
    }
    scored.sort((a, b) => a.distance - b.distance || a.rank - b.rank);

    const out = [];
    for (const s of scored.slice(0, limit * 4)) {
      const row = this.q.exact.get(s.wkey);
      // fuzzy 表本身已只收权威词条，这里再挡一道，确保不会把错拼推荐给用户
      if (!row || !row.translation || row.weak) continue;
      out.push({ row, distance: s.distance });
      if (out.length >= limit) break;
    }
    return out;
  }

  /* ------------------------------------------------------- 全文搜索 */

  /** 释义全文检索：中文走 fts_zh，英文走 fts_en */
  search(input, limit = 60) {
    if (!this.ready) return { kind: 'none', items: [] };
    const raw = String(input || '').trim();
    if (!raw) return { kind: 'none', items: [] };

    const shape = (r) => ({
      word: r.word,
      phonetic: r.phonetic,
      brief: this._brief(r.translation),
      tags: parseTags(r.tag).map((t) => t.code),
      collins: r.collins || 0,
      oxford: !!r.oxford,
    });

    if (isCJK(raw)) {
      return { kind: 'zh', items: this._searchZh(raw, limit).map(shape) };
    }
    const terms = raw
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => /[a-z]/.test(t))
      .map(ftsPhrase);
    if (!terms.length) return { kind: 'none', items: [] };
    try {
      return { kind: 'en', items: this.q.searchEn.all(terms.join(' AND '), limit).map(shape) };
    } catch {
      return { kind: 'en', items: [] };
    }
  }

  /* --------------------------------------------------------- 每日一词 */

  randomWord() {
    if (!this.ready) return null;
    const max = this.q.maxId.get().m || 1;
    for (let i = 0; i < 12; i++) {
      const r = this.q.randomWord.get(Math.floor(Math.random() * max));
      if (r) return r.word;
    }
    return 'serendipity';
  }

  /**
   * 批量取「音标 + 释义摘要 + 难度标签」。
   *
   * 生词本和错题列表要给每个词补上释义，逐个走 lookup() 的话，每个词都会把义项、
   * 例句、词源、关系词全查一遍——几百个词就是几千次查询。这里一条 SQL 取回主行，
   * 只解析展示用得到的字段。安卓端每次查询都要过一趟 JSON 桥，差距尤其明显。
   *
   * @param {string[]} words
   * @returns {Map<string, {word,phonetic,brief,tags,collins,oxford}>} 键是小写形式
   */
  briefMany(words) {
    const out = new Map();
    if (!this.ready || !words?.length) return out;

    const keys = [...new Set(words.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean))];
    // 一次绑太多参数会撞上 SQLITE_MAX_VARIABLE_NUMBER（安卓侧默认才 999）
    const CHUNK = 400;

    for (let i = 0; i < keys.length; i += CHUNK) {
      const part = keys.slice(i, i + CHUNK);
      /* 同一个 wkey 可能有多行（大小写、变体），要挑 rank 最小的那条，和 q.exact 一致。
         SQLite 保证：聚合里用了 MIN 时，同一行的其它裸列取自那个最小值所在的行。 */
      const rows = this.db.prepare(
        `SELECT wkey, word, phonetic, translation, tag, collins, oxford, MIN(rank) AS _rank
           FROM words WHERE wkey IN (${part.map(() => '?').join(',')})
          GROUP BY wkey`,
      ).all(...part);

      for (const r of rows) {
        out.set(r.wkey, {
          word: r.word,
          phonetic: parsePhonetic(r.phonetic)?.main || null,
          brief: this._brief(r.translation),
          tags: parseTags(r.tag),
          collins: r.collins || 0,
          oxford: !!r.oxford,
        });
      }
    }
    return out;
  }

  stats() {
    return {
      ready: this.ready,
      error: this.error,
      file: this.file,
      meta: this.meta,
    };
  }
}

const exported = {
  DictDB, POS_NAMES, TAG_LABELS,
  parseTranslation, parsePhonetic, setDatabaseOpener,
  isSentence, wordsOf,
};

/* 同一份文件要在两个环境里用：
   桌面版由 Electron 主进程 require，安卓版在 WebView 里当普通脚本加载。 */
if (typeof module !== 'undefined' && module.exports) module.exports = exported;
else if (typeof globalThis !== 'undefined') globalThis.LexicaDict = exported;

});

/* ---- user-db (来自 src/main/user-db.js，未经修改) ---- */
__cjs.define("user-db", function (module, exports, require) {
'use strict';
/**
 * 用户数据库（可写，存放在 userData 目录，与只读的 dict.db 分开）。
 * 负责生词本、查询历史、设置，以及 SM-2 间隔重复调度。
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { parseGlossary, MAX_TERMS } = require('./glossary');

const DAY = 86_400_000;

/** 与 glossary.js 的 norm 保持一致：小写、空格压成一个 */
const normTerm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** wrong 列是 JSON，老库里可能是 NULL，坏数据不能让整张表读不出来 */
function parseWrong(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

/** SM-2：把四档按钮映射成 0-5 的质量分 */
const GRADE_Q = { again: 0, hard: 3, good: 4, easy: 5 };

class UserDB {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'user.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this._migrate();
    this._prepare();
  }

  /**
   * 按版本号顺序执行迁移。
   *
   * 光靠 CREATE TABLE IF NOT EXISTS 只能应付「加表 / 加索引」，
   * 一旦要改字段类型、加带约束的列、或者回填数据就没辙了，而且会静默不生效。
   * 这里用 PRAGMA user_version 记录已应用到第几步，每步只跑一次。
   *
   * 加新迁移的规矩：往数组末尾追加，永远不要改动或删除已有项——
   * 用户库里已经记录了版本号，改动历史迁移会让老库走进不一致的状态。
   */
  _migrate() {
    const MIGRATIONS = [
      // v1：初始结构（生词本、历史、复习、设置、考纲练习）
      () => this._migrateV1(),
      // v2：自定义词表与自定义词条
      () => this._migrateV2(),
      // v3：术语表（用户自己维护的译名，用来修正机器翻译）
      () => this._migrateV3(),
      // v4：生词本的自有释义（笔记列 v1 就有，但一直没接上）
      () => this._migrateV4(),
    ];

    const current = this.db.prepare('PRAGMA user_version').get().user_version || 0;
    if (current >= MIGRATIONS.length) return;

    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        MIGRATIONS[v]();
        // PRAGMA 不接受占位符，版本号来自循环变量，不存在注入面
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw new Error(`user.db 迁移到 v${v + 1} 失败：${e.message}`);
      }
    }
  }

  _migrateV1() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wordbook (
        word     TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL,
        note     TEXT,
        ease     REAL    NOT NULL DEFAULT 2.5,
        ivl      INTEGER NOT NULL DEFAULT 0,   -- 当前间隔（天）
        reps     INTEGER NOT NULL DEFAULT 0,
        lapses   INTEGER NOT NULL DEFAULT 0,
        due      INTEGER NOT NULL,             -- 下次复习时间（ms）
        last_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_wb_due ON wordbook(due);

      CREATE TABLE IF NOT EXISTS history (
        word TEXT NOT NULL,
        at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hist_at ON history(at DESC);

      CREATE TABLE IF NOT EXISTS reviews (
        word  TEXT NOT NULL,
        at    INTEGER NOT NULL,
        grade TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);

      /* ---------------- 考纲练习 ---------------- */

      -- 每个词在每个范围下的答题统计，用来算掌握度与优先复习哪些词
      CREATE TABLE IF NOT EXISTS quiz_stats (
        word    TEXT NOT NULL,
        scope   TEXT NOT NULL,
        seen    INTEGER NOT NULL DEFAULT 0,
        hit     INTEGER NOT NULL DEFAULT 0,
        miss    INTEGER NOT NULL DEFAULT 0,
        last_at INTEGER,
        PRIMARY KEY (word, scope)
      );

      -- 逐题流水，热力图与正确率曲线都从这里聚合
      CREATE TABLE IF NOT EXISTS quiz_log (
        at      INTEGER NOT NULL,
        scope   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        word    TEXT NOT NULL,
        correct INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_qlog_at ON quiz_log(at);

      CREATE TABLE IF NOT EXISTS quiz_sessions (
        id         INTEGER PRIMARY KEY,
        scope      TEXT NOT NULL,
        mode       TEXT NOT NULL,   -- quiz | assess
        total      INTEGER NOT NULL,
        hit        INTEGER NOT NULL,
        detail     TEXT,            -- 检测模式存分层结果 JSON
        created_at INTEGER NOT NULL
      );

      -- 学习模式里手动标记的「认识 / 不认识」
      CREATE TABLE IF NOT EXISTS scope_marks (
        word  TEXT NOT NULL,
        scope TEXT NOT NULL,
        known INTEGER NOT NULL,
        at    INTEGER NOT NULL,
        PRIMARY KEY (word, scope)
      );
      CREATE INDEX IF NOT EXISTS idx_marks_scope ON scope_marks(scope, known);
    `);
  }

  /** v2：自定义词表（可当练习范围）与自定义词条（补词库缺的新词） */
  _migrateV2() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS custom_lists (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        note       TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_list_words (
        list_id INTEGER NOT NULL,
        word    TEXT NOT NULL,
        ord     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (list_id, word)
      );
      CREATE INDEX IF NOT EXISTS idx_clw_list ON custom_list_words(list_id, ord);

      -- 用户自建词条。ECDICT 停在 2019 年前后，充电宝、扫码这类词查不到，
      -- 与其换数据源不如让用户自己补；查词时与内置词库合并。
      CREATE TABLE IF NOT EXISTS custom_entries (
        word        TEXT PRIMARY KEY,
        phonetic    TEXT,
        translation TEXT NOT NULL,
        note        TEXT,
        updated_at  INTEGER NOT NULL
      );
    `);
  }

  /**
   * v3：术语表。
   *
   * wrong 存的是「模型对这个术语的固定错译写法」，JSON 数组。
   * 为什么要存：替换的前提是知道该把译文里的哪几个字换掉，而这个只能
   * 靠问一次模型拿到（模型是确定性的，问一次能一直用）。探测很慢，
   * 所以结果必须落库，不能每次翻译都重新问。
   */
  _migrateV3() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS glossary (
        term       TEXT PRIMARY KEY,   -- 归一化后的英文（小写、单空格）
        surface    TEXT NOT NULL,      -- 用户原始写法，显示用
        zh         TEXT NOT NULL,      -- 用户指定的译名
        wrong      TEXT,               -- JSON 数组：模型的错译写法
        note       TEXT,
        hits       INTEGER NOT NULL DEFAULT 0,   -- 实际改了多少次，用来看这条有没有用
        created_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * v4：生词本能写自己的释义。
   *
   * `note` 那一列 v1 就建好了，但从来没有代码写过它——功能等于不存在。
   * 这里补上 `my_def`，两列一起构成「生词本注释」：
   *
   * 它是**叠加**在词库释义之上，不是替换。词库里有这个词时，词条页照常
   * 显示词库释义，我的释义单独一块排在前面；词库里没有（自己加的词组）时，
   * 我的释义就是它唯一的释义。
   *
   * 为什么不复用 custom_entries：那张表的语义是「整条替换词库条目」，
   * 而且和生词本完全脱节。注释挂在生词本行上，删词时一起走，语义干净。
   *
   * ALTER 只能一列一列加，SQLite 不支持一条语句加多列。
   */
  _migrateV4() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(wordbook)').all().map((c) => c.name));
    if (!cols.has('my_def')) this.db.exec('ALTER TABLE wordbook ADD COLUMN my_def TEXT');
    // 注释改动时间。和 last_at（复习时间）不是一回事，排序要分开
    if (!cols.has('noted_at')) this.db.exec('ALTER TABLE wordbook ADD COLUMN noted_at INTEGER');
  }

  _prepare() {
    const d = this.db;
    this.q = {
      add: d.prepare(
        `INSERT INTO wordbook (word, added_at, due) VALUES (?, ?, ?)
         ON CONFLICT(word) DO NOTHING`,
      ),
      remove: d.prepare('DELETE FROM wordbook WHERE word = ?'),
      has: d.prepare('SELECT 1 FROM wordbook WHERE word = ?'),
      get: d.prepare('SELECT * FROM wordbook WHERE word = ?'),
      list: d.prepare('SELECT * FROM wordbook ORDER BY added_at DESC LIMIT ? OFFSET ?'),
      listDue: d.prepare('SELECT * FROM wordbook WHERE due <= ? ORDER BY due ASC LIMIT ?'),
      countAll: d.prepare('SELECT COUNT(*) c FROM wordbook'),
      countDue: d.prepare('SELECT COUNT(*) c FROM wordbook WHERE due <= ?'),
      countNew: d.prepare('SELECT COUNT(*) c FROM wordbook WHERE reps = 0'),
      countMature: d.prepare('SELECT COUNT(*) c FROM wordbook WHERE ivl >= 21'),
      sched: d.prepare(
        'UPDATE wordbook SET ease = ?, ivl = ?, reps = ?, lapses = ?, due = ?, last_at = ? WHERE word = ?',
      ),
      logReview: d.prepare('INSERT INTO reviews (word, at, grade) VALUES (?, ?, ?)'),
      pushHist: d.prepare('INSERT INTO history (word, at) VALUES (?, ?)'),
      trimHist: d.prepare('DELETE FROM history WHERE at < ?'),
      recent: d.prepare(
        `SELECT word, MAX(at) at FROM history GROUP BY word ORDER BY at DESC LIMIT ?`,
      ),
      clearHist: d.prepare('DELETE FROM history'),
      setGet: d.prepare('SELECT v FROM settings WHERE k = ?'),
      setPut: d.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      allWords: d.prepare('SELECT * FROM wordbook ORDER BY added_at DESC'),
      wbNote: d.prepare(
        'UPDATE wordbook SET note = ?, my_def = ?, noted_at = ? WHERE word = ?',
      ),
      wbCountNoted: d.prepare(
        "SELECT COUNT(*) c FROM wordbook WHERE COALESCE(note,'') <> '' OR COALESCE(my_def,'') <> ''",
      ),
      reviewsSince: d.prepare('SELECT COUNT(*) c FROM reviews WHERE at >= ?'),

      /* ---- 练习 ---- */
      qStatBump: d.prepare(
        `INSERT INTO quiz_stats (word, scope, seen, hit, miss, last_at)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(word, scope) DO UPDATE SET
           seen = seen + 1,
           hit = hit + excluded.hit,
           miss = miss + excluded.miss,
           last_at = excluded.last_at`,
      ),
      qLog: d.prepare('INSERT INTO quiz_log (at, scope, kind, word, correct) VALUES (?, ?, ?, ?, ?)'),
      qSession: d.prepare(
        'INSERT INTO quiz_sessions (scope, mode, total, hit, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      qScopeStat: d.prepare(
        `SELECT COUNT(*) touched,
                SUM(CASE WHEN hit > miss THEN 1 ELSE 0 END) mastered,
                SUM(CASE WHEN miss >= hit AND miss > 0 THEN 1 ELSE 0 END) shaky,
                SUM(seen) answered,
                SUM(hit) hits
           FROM quiz_stats WHERE scope = ?`,
      ),
      qWeak: d.prepare(
        `SELECT word, seen, hit, miss FROM quiz_stats
          WHERE scope = ? AND miss > 0 ORDER BY miss DESC, last_at ASC LIMIT ?`,
      ),
      qSessions: d.prepare(
        'SELECT * FROM quiz_sessions WHERE scope = ? ORDER BY created_at DESC LIMIT ?',
      ),
      qLastSession: d.prepare(
        "SELECT * FROM quiz_sessions WHERE scope = ? AND mode = 'assess' ORDER BY created_at DESC LIMIT 1",
      ),
      markPut: d.prepare(
        `INSERT INTO scope_marks (word, scope, known, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(word, scope) DO UPDATE SET known = excluded.known, at = excluded.at`,
      ),
      markStat: d.prepare(
        `SELECT SUM(known) known, SUM(1 - known) unknown, COUNT(*) total
           FROM scope_marks WHERE scope = ?`,
      ),

      /* ---- 自定义词表 ---- */
      clCreate: d.prepare('INSERT INTO custom_lists (name, note, created_at) VALUES (?, ?, ?)'),
      clRename: d.prepare('UPDATE custom_lists SET name = ?, note = ? WHERE id = ?'),
      clDelete: d.prepare('DELETE FROM custom_lists WHERE id = ?'),
      clDeleteWords: d.prepare('DELETE FROM custom_list_words WHERE list_id = ?'),
      clAll: d.prepare(
        `SELECT l.id, l.name, l.note, l.created_at,
                (SELECT COUNT(*) FROM custom_list_words w WHERE w.list_id = l.id) n
           FROM custom_lists l ORDER BY l.created_at DESC`,
      ),
      clOne: d.prepare('SELECT * FROM custom_lists WHERE id = ?'),
      clAddWord: d.prepare(
        'INSERT INTO custom_list_words (list_id, word, ord) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      ),
      clWords: d.prepare('SELECT word FROM custom_list_words WHERE list_id = ? ORDER BY ord LIMIT ?'),
      clCount: d.prepare('SELECT COUNT(*) c FROM custom_list_words WHERE list_id = ?'),

      /* ---- 自定义词条 ---- */
      ceGet: d.prepare('SELECT * FROM custom_entries WHERE word = ?'),
      cePut: d.prepare(
        `INSERT INTO custom_entries (word, phonetic, translation, note, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(word) DO UPDATE SET
           phonetic = excluded.phonetic, translation = excluded.translation,
           note = excluded.note, updated_at = excluded.updated_at`,
      ),
      ceDelete: d.prepare('DELETE FROM custom_entries WHERE word = ?'),
      ceAll: d.prepare('SELECT * FROM custom_entries ORDER BY updated_at DESC LIMIT ?'),
      ceCount: d.prepare('SELECT COUNT(*) c FROM custom_entries'),
      cePrefix: d.prepare(
        'SELECT * FROM custom_entries WHERE word >= ? AND word < ? ORDER BY word LIMIT ?',
      ),

      /* ---- 术语表 ---- */
      gAll: d.prepare('SELECT * FROM glossary ORDER BY created_at DESC'),
      gPut: d.prepare(
        `INSERT INTO glossary (term, surface, zh, wrong, note, hits, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(term) DO UPDATE SET
           surface = excluded.surface, zh = excluded.zh, note = excluded.note,
           -- 译名改了，之前探测到的错法就未必还对得上，清空重新探
           wrong = CASE WHEN glossary.zh = excluded.zh THEN glossary.wrong ELSE NULL END`,
      ),
      gDelete: d.prepare('DELETE FROM glossary WHERE term = ?'),
      gClear: d.prepare('DELETE FROM glossary'),
      gCount: d.prepare('SELECT COUNT(*) c FROM glossary'),
      gWrong: d.prepare('UPDATE glossary SET wrong = ? WHERE term = ?'),
      gBumpHit: d.prepare('UPDATE glossary SET hits = hits + ? WHERE term = ?'),

      /* ---- 每日目标：当天完成量 ---- */
      goalToday: d.prepare(
        `SELECT
           (SELECT COUNT(*) FROM reviews WHERE at >= ?) reviews,
           (SELECT COUNT(*) FROM quiz_log WHERE at >= ?) quiz,
           (SELECT COUNT(*) FROM wordbook WHERE added_at >= ?) added`,
      ),

      /* ---- 热力图：把复习与练习按天合并 ---- */
      heatReviews: d.prepare(
        `SELECT CAST(at / 86400000 AS INTEGER) day, COUNT(*) n
           FROM reviews WHERE at >= ? GROUP BY day`,
      ),
      heatQuiz: d.prepare(
        `SELECT CAST(at / 86400000 AS INTEGER) day, COUNT(*) n, SUM(correct) hit
           FROM quiz_log WHERE at >= ? GROUP BY day`,
      ),
    };
  }

  /* --------------------------------------------------------- 生词本 */

  toggle(word) {
    const w = String(word).trim();
    if (!w) return { saved: false };
    if (this.q.has.get(w)) {
      this.q.remove.run(w);
      return { saved: false };
    }
    const now = Date.now();
    this.q.add.run(w, now, now);
    return { saved: true };
  }

  isSaved(word) {
    return !!this.q.has.get(String(word).trim());
  }

  /**
   * 明确删除，不是 toggle。
   *
   * 编辑框里的「移出生词本」必须走这个：toggle 对不存在的词是**添加**，
   * 重复点一下会把刚删的词又加回来。
   */
  remove(word) {
    const w = String(word || '').trim();
    if (!w) return { ok: false, reason: '单词不能为空' };
    this.q.remove.run(w);
    return { ok: true, word: w };
  }

  /** 单个生词本条目（含注释）。不在生词本里返回 null */
  entry(word) {
    return this.q.get.get(String(word || '').trim()) || null;
  }

  /**
   * 直接加词，不是 toggle。
   *
   * 手动添加必须和 toggle 分开：toggle 对已存在的词是**删除**，
   * 而用户在编辑框里点保存时绝不该把词删掉。
   */
  addWord(word, { note = null, myDef = null } = {}) {
    const w = String(word || '').trim();
    if (!w) return { ok: false, reason: '单词或词组不能为空' };
    if (w.length > 120) return { ok: false, reason: '太长了，看着不像一个词条' };
    const now = Date.now();
    this.q.add.run(w, now, now);          // 已存在时 DO NOTHING
    if (note !== null || myDef !== null) this.annotate(w, { note, myDef });
    return { ok: true, word: w, added: true };
  }

  /**
   * 写注释。词不在生词本里就先加进来——用户在词条页写笔记时
   * 未必已经点过收藏，这时要的是「记下来」，不是报错。
   */
  annotate(word, { note = null, myDef = null } = {}) {
    const w = String(word || '').trim();
    if (!w) return { ok: false, reason: '单词不能为空' };
    if (!this.q.has.get(w)) {
      const now = Date.now();
      this.q.add.run(w, now, now);
    }
    const n = note === null ? null : String(note).trim() || null;
    const d = myDef === null ? null : String(myDef).trim() || null;
    this.q.wbNote.run(n, d, Date.now(), w);
    return { ok: true, word: w, note: n, myDef: d };
  }

  list({ limit = 500, offset = 0 } = {}) {
    return this.q.list.all(limit, offset);
  }

  allWords() {
    return this.q.allWords.all();
  }

  counts() {
    const now = Date.now();
    return {
      total: this.q.countAll.get().c,
      due: this.q.countDue.get(now).c,
      fresh: this.q.countNew.get().c,
      mature: this.q.countMature.get().c,
      noted: this.q.wbCountNoted.get().c,
      reviewedToday: this.q.reviewsSince.get(new Date().setHours(0, 0, 0, 0)).c,
    };
  }

  /* --------------------------------------------------------- 复习 */

  dueQueue(limit = 40) {
    return this.q.listDue.all(Date.now(), limit);
  }

  /**
   * SM-2 调度。grade ∈ again|hard|good|easy
   * @returns 新的间隔与到期时间
   */
  grade(word, grade) {
    const row = this.q.get.get(String(word).trim());
    if (!row) return null;
    const q = GRADE_Q[grade] ?? 4;
    const now = Date.now();

    let { ease, ivl, reps, lapses } = row;

    if (q < 3) {
      // 忘记：重新开始，10 分钟后再看
      reps = 0;
      lapses += 1;
      ivl = 0;
      ease = Math.max(1.3, ease - 0.2);
      this.q.sched.run(ease, ivl, reps, lapses, now + 10 * 60_000, now, row.word);
    } else {
      if (reps === 0) ivl = 1;
      else if (reps === 1) ivl = 6;
      else ivl = Math.max(1, Math.round(ivl * ease));
      if (grade === 'hard') ivl = Math.max(1, Math.round(ivl * 0.6));
      if (grade === 'easy') ivl = Math.round(ivl * 1.3);
      reps += 1;
      ease = Math.max(1.3, Math.min(3.0, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))));
      this.q.sched.run(ease, ivl, reps, lapses, now + ivl * DAY, now, row.word);
    }

    this.q.logReview.run(row.word, now, grade);
    return { word: row.word, ivl, ease: Number(ease.toFixed(2)), reps, lapses };
  }

  /* --------------------------------------------------------- 历史 */

  pushHistory(word) {
    const w = String(word).trim();
    if (!w) return;
    this.q.pushHist.run(w, Date.now());
    // 只留最近 90 天
    if (Math.random() < 0.02) this.q.trimHist.run(Date.now() - 90 * DAY);
  }

  recent(limit = 40) {
    return this.q.recent.all(limit);
  }

  clearHistory() {
    this.q.clearHist.run();
  }

  /* --------------------------------------------------------- 练习 */

  /** 记一道题的结果 */
  recordAnswer({ scope, kind, word, correct }) {
    const now = Date.now();
    this.q.qStatBump.run(word, scope, correct ? 1 : 0, correct ? 0 : 1, now);
    this.q.qLog.run(now, scope, kind, word, correct ? 1 : 0);
  }

  /** 一轮练习结束，落一条会话记录 */
  saveSession({ scope, mode, total, hit, detail = null }) {
    this.q.qSession.run(scope, mode, total, hit, detail ? JSON.stringify(detail) : null, Date.now());
  }

  /** 某个范围的练习进度概览 */
  scopeProgress(scope) {
    const s = this.q.qScopeStat.get(scope) || {};
    const m = this.q.markStat.get(scope) || {};
    const last = this.q.qLastSession.get(scope);
    return {
      touched: s.touched || 0,
      mastered: s.mastered || 0,
      shaky: s.shaky || 0,
      answered: s.answered || 0,
      accuracy: s.answered ? (s.hits || 0) / s.answered : null,
      markedKnown: m.known || 0,
      markedUnknown: m.unknown || 0,
      lastAssessment: last
        ? {
            at: last.created_at,
            rate: last.total ? last.hit / last.total : 0,
            total: last.total,
            detail: last.detail ? JSON.parse(last.detail) : null,
          }
        : null,
    };
  }

  /** 错得最多的词，用于「强化错题」 */
  weakWords(scope, limit = 40) {
    return this.q.qWeak.all(scope, limit);
  }

  markWord(word, scope, known) {
    this.q.markPut.run(word, scope, known ? 1 : 0, Date.now());
  }

  /**
   * 学习热力图。把复习和练习按天合并，返回最近 days 天的每日活动量。
   * day 用「毫秒时间戳 / 86400000」取整，即 UTC 天序号。
   */
  heatmap(days = 365) {
    const since = Date.now() - days * DAY;
    const map = new Map();
    const touch = (d) => {
      if (!map.has(d)) map.set(d, { day: d, reviews: 0, quiz: 0, hit: 0 });
      return map.get(d);
    };
    for (const r of this.q.heatReviews.all(since)) touch(r.day).reviews = r.n;
    for (const r of this.q.heatQuiz.all(since)) {
      const e = touch(r.day);
      e.quiz = r.n;
      e.hit = r.hit || 0;
    }
    return [...map.values()].sort((a, b) => a.day - b.day);
  }

  /* --------------------------------------------------------- 设置 */

  getSetting(k, fallback = null) {
    const r = this.q.setGet.get(k);
    if (!r) return fallback;
    try { return JSON.parse(r.v); } catch { return r.v; }
  }

  setSetting(k, v) {
    this.q.setPut.run(k, JSON.stringify(v));
  }

  allSettings(defaults) {
    const out = { ...defaults };
    for (const k of Object.keys(defaults)) {
      const v = this.getSetting(k, undefined);
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  }

  /* --------------------------------------------------- 自定义词表 */

  /** 从一段文本建词表。每行一个词，忽略空行与注释行，自动去重 */
  createList(name, text, note = null) {
    const words = [];
    const seen = new Set();
    for (const line of String(text || '').split(/\r?\n/)) {
      // 允许 "word  释义" 或 "word,释义" 这类格式，只取第一列
      const w = line.split(/[\t,，;；]/)[0].trim().replace(/^[-*•\d.、)\s]+/, '').trim();
      if (!w || w.startsWith('#') || w.length > 64) continue;
      const key = w.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      words.push(key);
    }
    if (!words.length) return { ok: false, reason: '没有解析出任何单词' };

    this.db.exec('BEGIN');
    try {
      const info = this.q.clCreate.run(String(name || '未命名词表').slice(0, 60), note, Date.now());
      const id = Number(info.lastInsertRowid);
      words.forEach((w, i) => this.q.clAddWord.run(id, w, i));
      this.db.exec('COMMIT');
      return { ok: true, id, count: words.length };
    } catch (e) {
      this.db.exec('ROLLBACK');
      return { ok: false, reason: e.message };
    }
  }

  lists() {
    return this.q.clAll.all();
  }

  listWords(id, limit = 100000) {
    return this.q.clWords.all(id, limit).map((r) => r.word);
  }

  listInfo(id) {
    return this.q.clOne.get(id) || null;
  }

  deleteList(id) {
    this.db.exec('BEGIN');
    try {
      this.q.clDeleteWords.run(id);
      this.q.clDelete.run(id);
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (e) {
      this.db.exec('ROLLBACK');
      return { ok: false, reason: e.message };
    }
  }

  /* --------------------------------------------------- 自定义词条 */

  customEntry(word) {
    return this.q.ceGet.get(String(word || '').trim().toLowerCase()) || null;
  }

  putCustomEntry({ word, phonetic, translation, note }) {
    const w = String(word || '').trim().toLowerCase();
    const tr = String(translation || '').trim();
    if (!w) return { ok: false, reason: '单词不能为空' };
    if (!tr) return { ok: false, reason: '释义不能为空' };
    this.q.cePut.run(w, phonetic?.trim() || null, tr, note?.trim() || null, Date.now());
    return { ok: true, word: w };
  }

  deleteCustomEntry(word) {
    this.q.ceDelete.run(String(word || '').trim().toLowerCase());
    return { ok: true };
  }

  customEntries(limit = 500) {
    return this.q.ceAll.all(limit);
  }

  customCount() {
    return this.q.ceCount.get().c;
  }

  /** 自定义词条参与搜索建议的前缀匹配 */
  customPrefix(prefix, limit = 5) {
    const p = String(prefix || '').toLowerCase();
    if (!p) return [];
    return this.q.cePrefix.all(p, `${p}￿`, limit);
  }

  /* --------------------------------------------------- 术语表 */

  /**
   * 读全部术语，wrong 解析成数组。
   *
   * 不分页也不加 LIMIT：条目上限 2000（MAX_TERMS），全读出来几百 KB，
   * 而翻译每一句都要拿整张表来匹配，分页反而麻烦。上层自己缓存。
   */
  glossary() {
    return this.q.gAll.all().map((r) => ({
      ...r,
      wrong: parseWrong(r.wrong),
    }));
  }

  glossaryCount() {
    return this.q.gCount.get().c;
  }

  /** 加/改一条。term 为空或译名为空都不收 */
  putTerm({ term, zh, note }) {
    const surface = String(term || '').trim();
    const key = normTerm(surface);
    const dst = String(zh || '').trim();
    if (!key) return { ok: false, reason: '英文术语不能为空' };
    if (!dst) return { ok: false, reason: '译名不能为空' };
    if (key.length > 64) return { ok: false, reason: '术语太长' };
    this.q.gPut.run(key, surface, dst, null, note?.trim() || null, Date.now());
    return { ok: true, term: key };
  }

  deleteTerm(term) {
    this.q.gDelete.run(normTerm(term));
    return { ok: true };
  }

  /** 批量导入一段文本。解析规则在 glossary.js 里 */
  importGlossary(text, { replace = false } = {}) {
    const { terms, skipped } = parseGlossary(text);
    if (!terms.length) return { ok: false, reason: '没有解析出任何术语', skipped };

    const room = MAX_TERMS - (replace ? 0 : this.glossaryCount());
    if (room <= 0) return { ok: false, reason: `术语表已满（上限 ${MAX_TERMS} 条）` };
    const use = terms.slice(0, room);

    this.db.exec('BEGIN');
    try {
      if (replace) this.q.gClear.run();
      const now = Date.now();
      for (const t of use) this.q.gPut.run(t.term, t.surface, t.zh, null, null, now);
      this.db.exec('COMMIT');
      return { ok: true, count: use.length, skipped, dropped: terms.length - use.length };
    } catch (e) {
      this.db.exec('ROLLBACK');
      return { ok: false, reason: e.message };
    }
  }

  /** 缓存探测到的错译写法。空数组也要写（写成 []），否则会被反复探测 */
  setTermWrong(term, forms) {
    const list = [...new Set((forms || []).map((f) => String(f || '').trim()).filter(Boolean))];
    this.q.gWrong.run(JSON.stringify(list), normTerm(term));
    return { ok: true, wrong: list };
  }

  /** 记一次实际替换，用来让用户看出哪条术语真的在起作用 */
  bumpTermHits(counts) {
    for (const [term, n] of Object.entries(counts || {})) {
      if (n > 0) this.q.gBumpHit.run(n, normTerm(term));
    }
  }

  /* --------------------------------------------------- 每日目标 */

  goalProgress(goals) {
    const start = new Date().setHours(0, 0, 0, 0);
    const r = this.q.goalToday.get(start, start, start);
    return {
      reviews: { done: r.reviews, target: goals.dailyReviews || 0 },
      quiz: { done: r.quiz, target: goals.dailyQuiz || 0 },
      added: { done: r.added, target: goals.dailyNew || 0 },
    };
  }

  /** 备份/恢复前要先关掉连接，WAL 才会落盘 */
  checkpoint() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
  }

  close() {
    try { this.db.close(); } catch { /* 忽略 */ }
  }
}

/* 当前 schema 版本 = 迁移条数。测试拿它断言，加迁移时不用改测试 */
const SCHEMA_VERSION = 4;

module.exports = { UserDB, DAY, SCHEMA_VERSION };

});

/* ---- quiz (来自 src/main/quiz.js，未经修改) ---- */
__cjs.define("quiz", function (module, exports, require) {
'use strict';
/**
 * 考纲练习的出题引擎。
 *
 * 全部题目都从本地词库现算，不需要预置题库：
 *   en2zh  给单词选中文释义
 *   zh2en  给中文释义选单词
 *   cloze  例句挖空选词（素材来自 Tatoeba / WordNet 例句）
 *   syn    给单词选同义词（素材来自 WordNet 同义词集）
 *   audio  听发音选词（渲染层用系统 TTS 朗读，题面不显示拼写）
 *
 * 干扰项从同一考纲范围内、词频相近的词里挑，保证难度可比；
 * 并排除与正确答案互为同义词的候选，否则题目会出现两个都对的选项。
 */
const { parseTranslation } = require('./dict-db');

/** 各范围的展示名。前 8 个是 ECDICT 的考纲标签，后面是按词频/权威度切出来的词表。 */
const SCOPE_LABELS = {
  zk: '中考', gk: '高考', cet4: '四级', cet6: '六级', ky: '考研',
  ielts: '雅思', toefl: '托福', gre: 'GRE',
  oxford: '牛津 3000', collins5: '柯林斯 5 星', collins4: '柯林斯 4 星以上',
  top1000: '最常用 1000 词', top3000: '最常用 3000 词', top5000: '最常用 5000 词',
};

const SCOPE_ORDER = [
  'zk', 'gk', 'cet4', 'cet6', 'ky', 'ielts', 'toefl', 'gre',
  'top1000', 'top3000', 'top5000', 'oxford', 'collins5', 'collins4',
];

const KIND_LABELS = {
  en2zh: '选释义',
  zh2en: '选单词',
  cloze: '例句填空',
  syn: '选同义词',
  audio: '听音选词',
  confuse: '易混词辨析',
  spell: '看中文拼写',
  spellAudio: '听音拼写',
};

/** 需要手动输入答案的题型（渲染层要给输入框而不是选项） */
const INPUT_KINDS = new Set(['spell', 'spellAudio']);

/** 自定义词表的范围标识形如 list:12 */
const CUSTOM_PREFIX = 'list:';
const isCustomScope = (s) => String(s || '').startsWith(CUSTOM_PREFIX);
const customId = (s) => Number(String(s).slice(CUSTOM_PREFIX.length));

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** 取中文释义的简短形式，作为选项文本 */
function briefZh(translation, maxLen = 34) {
  const parts = parseTranslation(translation);
  if (!parts.length) return '';
  const out = [];
  for (const p of parts) {
    const t = p.pos ? `${p.pos}. ${p.text}` : p.text;
    out.push(t);
    if (out.join('；').length >= maxLen) break;
  }
  let s = out.join('；');
  if (s.length > maxLen + 12) s = `${s.slice(0, maxLen + 12)}…`;
  return s;
}

/** 归一化拼写答案：忽略大小写、首尾空格、连字符与撇号的写法差异 */
const normSpelling = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[-\s]+/g, ' ');

/** Levenshtein 距离，带上限提前退出 */
function editDistance(a, b, limit = 3) {
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
}

/**
 * 判定拼写题。
 * 大小写、首尾空格、连字符写法不算错；差一个字母算错但要告诉用户「只差一点」，
 * 直接判红而不说明差在哪，学习价值会低很多。
 */
function checkSpelling(input, answer) {
  const a = normSpelling(input);
  const b = normSpelling(answer);
  if (!a) return { correct: false, near: false, distance: b.length };
  if (a === b) return { correct: true, near: false, distance: 0 };
  const d = editDistance(a, b, 3);
  return { correct: false, near: d <= (b.length >= 7 ? 2 : 1), distance: d };
}

class Quiz {
  /** @param dict {import('./dict-db').DictDB} */
  constructor(dict) {
    this.dict = dict;
    this.q = null;
    /** 自定义词表的数据源，由主进程注入（词表存在 user.db，跨库拿不到） */
    this.customSource = null;
    this._customCache = new Map();
  }

  /** @param src {{ lists: () => any[], words: (id:number) => string[] }} */
  setCustomSource(src) {
    this.customSource = src;
    this._customCache.clear();
  }

  invalidateCustom() {
    this._customCache.clear();
  }

  /**
   * 把自定义词表里的单词解析成词库里的行，结果缓存。
   * 查不到的词直接丢掉——出不了题。
   */
  _customRows(scope) {
    const id = customId(scope);
    if (this._customCache.has(id)) return this._customCache.get(id);
    if (!this.customSource) return [];

    const sel = this.dict.db.prepare(
      `SELECT id, word, wkey, phonetic, translation, tag, collins, oxford, rank, n_ex, n_senses
         FROM words WHERE wkey = ? ORDER BY rank LIMIT 1`,
    );
    const rows = [];
    for (const w of this.customSource.words(id)) {
      const r = sel.get(w);
      if (r && r.translation) rows.push(r);
    }
    this._customCache.set(id, rows);
    return rows;
  }

  /** 统一的抽词入口：内置考纲走 word_tags，自定义词表走缓存数组 */
  _sample(scope, count) {
    if (isCustomScope(scope)) return shuffle(this._customRows(scope).slice()).slice(0, count);
    return this.q.sample.all(scope, count);
  }

  get ready() {
    return this.dict?.ready;
  }

  _prep() {
    if (this.q || !this.ready) return;
    const d = this.dict.db;
    this.q = {
      scopeCounts: d.prepare(
        `SELECT tag, COUNT(*) total, SUM(quiz) quizzable FROM word_tags GROUP BY tag`,
      ),
      // 随机抽词。tag+quiz 有索引，范围本身最多七千余行，random() 排序足够快
      sample: d.prepare(
        `SELECT w.id, w.word, w.wkey, w.phonetic, w.translation, w.tag,
                w.collins, w.oxford, w.rank, w.n_ex, w.n_senses
           FROM word_tags t JOIN words w ON w.id = t.word_id
          WHERE t.tag = ? AND t.quiz = 1
          ORDER BY random() LIMIT ?`,
      ),
      sampleBand: d.prepare(
        `SELECT w.id, w.word, w.wkey, w.phonetic, w.translation, w.rank
           FROM word_tags t JOIN words w ON w.id = t.word_id
          WHERE t.tag = ? AND t.quiz = 1 AND t.rank BETWEEN ? AND ?
          ORDER BY random() LIMIT ?`,
      ),
      // 词频相近的同范围词，用作干扰项
      near: d.prepare(
        `SELECT w.id, w.word, w.translation
           FROM word_tags t JOIN words w ON w.id = t.word_id
          WHERE t.tag = ? AND t.quiz = 1 AND w.id <> ? AND w.translation IS NOT NULL
          ORDER BY abs(t.rank - ?) LIMIT 40`,
      ),
      // 例句（优先中英对照、优先短句）
      example: d.prepare(
        `SELECT s.en, s.zh FROM word_sentences ws JOIN sentences s ON s.id = ws.sent_id
          WHERE ws.word_id = ? ORDER BY (s.zh IS NULL), ws.score DESC LIMIT 6`,
      ),
      wnExamples: d.prepare(
        `SELECT examples FROM senses WHERE word_id = ? AND examples IS NOT NULL LIMIT 4`,
      ),
      synonyms: d.prepare(
        `SELECT synonyms FROM senses
          WHERE word_id = ? AND synonyms IS NOT NULL ORDER BY sense_num LIMIT 4`,
      ),
      formsOf: d.prepare('SELECT form FROM forms WHERE lemma = ? LIMIT 12'),
      rankRange: d.prepare(
        `SELECT MIN(rank) lo, MAX(rank) hi, COUNT(*) n FROM word_tags WHERE tag = ? AND quiz = 1`,
      ),
      // 易混词：拼写相近但意思不同，专门用来做辨析题的干扰项
      confusables: d.prepare(
        `SELECT w.id, w.word, w.translation, c.distance
           FROM confusables c JOIN words w ON w.id = c.other_id
          WHERE c.word_id = ? AND w.translation IS NOT NULL
          ORDER BY c.distance, w.rank LIMIT 8`,
      ),
    };
  }

  /** 词库里有没有易混词表（旧库可能还没有，要能优雅降级） */
  get hasConfusables() {
    if (this._hasConf === undefined) {
      try {
        this.dict.db.prepare('SELECT 1 FROM confusables LIMIT 1').get();
        this._hasConf = true;
      } catch {
        this._hasConf = false;
      }
    }
    return this._hasConf;
  }

  /* ------------------------------------------------------------ 范围列表 */

  scopes() {
    if (!this.ready) return [];
    this._prep();
    const counts = new Map();
    for (const r of this.q.scopeCounts.all()) counts.set(r.tag, r);
    const builtin = SCOPE_ORDER.filter((s) => counts.has(s)).map((s) => ({
      scope: s,
      label: SCOPE_LABELS[s] || s,
      total: counts.get(s).total,
      quizzable: counts.get(s).quizzable,
      custom: false,
    }));

    const custom = (this.customSource?.lists() || []).map((l) => {
      const rows = this._customRows(`${CUSTOM_PREFIX}${l.id}`);
      return {
        scope: `${CUSTOM_PREFIX}${l.id}`,
        label: l.name,
        total: l.n,
        quizzable: rows.length, // 只有词库里查得到的才能出题
        custom: true,
        createdAt: l.created_at,
      };
    });

    return [...builtin, ...custom];
  }

  scopeLabel(scope) {
    if (!isCustomScope(scope)) return SCOPE_LABELS[scope] || scope;
    const info = this.customSource?.lists().find((l) => `${CUSTOM_PREFIX}${l.id}` === scope);
    return info?.name || '自定义词表';
  }

  /* ------------------------------------------------------------ 学习模式 */

  /** 抽一批词用于卡片浏览 */
  studyBatch(scope, count = 20) {
    if (!this.ready) return [];
    this._prep();
    return this._sample(scope, count).map((row) => this.dict.buildEntry(row));
  }

  /* ------------------------------------------------------------ 出题 */

  /** 该词能出哪些题型 */
  _availableKinds(row) {
    const kinds = ['en2zh', 'zh2en', 'audio'];
    if (row.n_ex > 0 || row.n_senses > 0) kinds.push('cloze');
    if (row.n_senses > 0) kinds.push('syn');
    // 拼写题只对纯字母单词出：带空格的词组让人逐字敲不合理
    if (/^[a-z][a-z'-]{2,}$/.test(row.wkey)) {
      kinds.push('spell', 'spellAudio');
    }
    if (this.hasConfusables && this.q.confusables.all(row.id).length >= 2) kinds.push('confuse');
    return kinds;
  }

  /** 干扰项换成拼写相近的易混词 */
  _confuseDistractors(row, n) {
    const banned = new Set([row.word.toLowerCase()]);
    for (const s of this.q.synonyms.all(row.id)) {
      for (const w of (s.synonyms || '').split(', ')) if (w) banned.add(w.trim().toLowerCase());
    }
    // 词形变化不算易混词（run/running 不是一组该辨析的词）
    for (const f of this.q.formsOf.all(row.wkey)) banned.add(f.form);
    return shuffle(
      this.q.confusables.all(row.id).filter((c) => !banned.has(c.word.toLowerCase()) && briefZh(c.translation)),
    ).slice(0, n);
  }

  /** 把句子里的目标词及其词形替换成空格 */
  _blank(sentence, wkey) {
    const forms = new Set([wkey, ...this.q.formsOf.all(wkey).map((r) => r.form)]);
    const alts = [...forms]
      .filter((f) => /^[a-z'-]+$/.test(f))
      .sort((a, b) => b.length - a.length)
      .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!alts.length) return null;
    let hit = false;
    const out = sentence.replace(new RegExp(`\\b(${alts.join('|')})\\b`, 'gi'), () => {
      hit = true;
      return '______';
    });
    return hit ? out : null;
  }

  /** 干扰项：同范围、词频相近、且不是正确答案的同义词 */
  _distractors(scope, row, n, excludeWords = []) {
    const banned = new Set([row.word.toLowerCase(), ...excludeWords.map((w) => w.toLowerCase())]);
    // 正确答案的同义词不能当干扰项，否则会有两个正确选项
    for (const s of this.q.synonyms.all(row.id)) {
      for (const w of (s.synonyms || '').split(', ')) if (w) banned.add(w.trim().toLowerCase());
    }

    let pool;
    if (isCustomScope(scope)) {
      // 自定义词表：从表内按词频接近程度找干扰项
      pool = this._customRows(scope)
        .filter((r) => r.id !== row.id && !banned.has(r.word.toLowerCase()))
        .sort((a, b) => Math.abs(a.rank - row.rank) - Math.abs(b.rank - row.rank))
        .slice(0, 40);
    } else {
      pool = this.q.near.all(scope, row.id, row.rank);
    }
    return shuffle(pool.filter((r) => !banned.has(r.word.toLowerCase()) && briefZh(r.translation))).slice(0, n);
  }

  /**
   * 生成一道题。
   * @returns null 表示这个词出不了这种题（素材不足），调用方应换词或换题型
   */
  makeQuestion(scope, row, kind) {
    this._prep();
    const zh = briefZh(row.translation);
    if (!zh) return null;

    const base = {
      kind,
      kindLabel: KIND_LABELS[kind],
      word: row.word,
      wordId: row.id,
      phonetic: row.phonetic,
      scope,
    };

    /* ---- 给单词选中文释义 ---- */
    if (kind === 'en2zh') {
      const ds = this._distractors(scope, row, 3);
      if (ds.length < 3) return null;
      const options = shuffle([
        { text: zh, correct: true },
        ...ds.map((d) => ({ text: briefZh(d.translation), correct: false })),
      ]);
      return { ...base, prompt: row.word, options, answer: options.findIndex((o) => o.correct) };
    }

    /* ---- 给中文释义选单词 ---- */
    if (kind === 'zh2en') {
      const ds = this._distractors(scope, row, 3);
      if (ds.length < 3) return null;
      const options = shuffle([
        { text: row.word, correct: true },
        ...ds.map((d) => ({ text: d.word, correct: false })),
      ]);
      return { ...base, prompt: zh, options, answer: options.findIndex((o) => o.correct) };
    }

    /* ---- 听发音选单词（题面不给拼写，由渲染层朗读） ---- */
    if (kind === 'audio') {
      const ds = this._distractors(scope, row, 3);
      if (ds.length < 3) return null;
      const options = shuffle([
        { text: row.word, correct: true },
        ...ds.map((d) => ({ text: d.word, correct: false })),
      ]);
      return {
        ...base,
        prompt: '',
        speak: row.word,
        options,
        answer: options.findIndex((o) => o.correct),
      };
    }

    /* ---- 例句填空 ---- */
    if (kind === 'cloze') {
      const cands = [];
      for (const e of this.q.example.all(row.id)) cands.push({ en: e.en, zh: e.zh });
      for (const s of this.q.wnExamples.all(row.id)) {
        for (const line of (s.examples || '').split('\n')) if (line) cands.push({ en: line, zh: null });
      }
      for (const c of cands) {
        const blanked = this._blank(c.en, row.wkey);
        // 太短的句子给不了上下文线索，填空题就没意义
        if (!blanked || blanked.split(/\s+/).length < 5) continue;
        const ds = this._distractors(scope, row, 3);
        if (ds.length < 3) continue;
        const options = shuffle([
          { text: row.word, correct: true },
          ...ds.map((d) => ({ text: d.word, correct: false })),
        ]);
        return {
          ...base,
          prompt: blanked,
          promptZh: c.zh,
          options,
          answer: options.findIndex((o) => o.correct),
        };
      }
      return null;
    }

    /* ---- 易混词辨析：干扰项是拼写相近但意思不同的词 ---- */
    if (kind === 'confuse') {
      const ds = this._confuseDistractors(row, 3);
      if (ds.length < 2) return null;
      const options = shuffle([
        { text: row.word, correct: true },
        ...ds.map((d) => ({ text: d.word, correct: false })),
      ]);
      return {
        ...base,
        prompt: zh,
        // 答完把每个选项的释义摊开，辨析题的价值就在对比上
        reveal: options.map((o) => ({
          word: o.text,
          zh: o.correct ? zh : briefZh(ds.find((d) => d.word === o.text)?.translation || ''),
        })),
        options,
        answer: options.findIndex((o) => o.correct),
      };
    }

    /* ---- 看中文拼写 / 听音拼写：输入型，没有选项 ---- */
    if (kind === 'spell' || kind === 'spellAudio') {
      const audio = kind === 'spellAudio';
      return {
        ...base,
        input: true,
        prompt: audio ? '' : zh,
        promptZh: audio ? zh : null, // 听音拼写答完再显示中文
        speak: audio ? row.word : null,
        // 给出首字母与长度作为脚手架，否则纯回忆对多数人过难
        hint: { first: row.word[0], length: row.word.length },
        solution: row.word,
      };
    }

    /* ---- 选同义词 ---- */
    if (kind === 'syn') {
      const syns = [];
      for (const s of this.q.synonyms.all(row.id)) {
        for (const w of (s.synonyms || '').split(', ')) {
          const t = w.trim();
          // 词组当选项太容易猜，只要单词
          if (t && /^[A-Za-z][A-Za-z'-]*$/.test(t) && t.toLowerCase() !== row.wkey) syns.push(t);
        }
      }
      if (!syns.length) return null;
      const answerWord = syns[Math.floor(Math.random() * syns.length)];
      const ds = this._distractors(scope, row, 3, syns);
      if (ds.length < 3) return null;
      const options = shuffle([
        { text: answerWord, correct: true },
        ...ds.map((d) => ({ text: d.word, correct: false })),
      ]);
      return {
        ...base,
        prompt: row.word,
        promptZh: zh,
        options,
        answer: options.findIndex((o) => o.correct),
      };
    }

    return null;
  }

  /**
   * 出一整套题。
   * @param opts.kinds 允许的题型；不传则用全部
   */
  batch(scope, count = 10, opts = {}) {
    if (!this.ready) return [];
    this._prep();
    const allow = opts.kinds?.length ? opts.kinds : Object.keys(KIND_LABELS);

    // 多抽一些备用，因为有些词出不了指定题型
    const rows = this._sample(scope, count * 4);
    const out = [];
    const used = new Set();

    for (const row of rows) {
      if (out.length >= count) break;
      if (used.has(row.id)) continue;
      const kinds = shuffle(this._availableKinds(row).filter((k) => allow.includes(k)));
      for (const k of kinds) {
        const q = this.makeQuestion(scope, row, k);
        if (q) {
          out.push(q);
          used.add(row.id);
          break;
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------- 水平检测 */

  /**
   * 分层抽样估算掌握率。
   *
   * 按词频把范围切成三段（高频/中频/低频），每段等量抽题。这样估计比纯随机稳，
   * 也能看出「常用词都会、生僻词不会」这类分布。返回的 margin 是 95% 置信区间半宽。
   */
  assessmentBatch(scope, count = 30) {
    if (!this.ready) return { questions: [], bands: [] };
    this._prep();

    // 自定义词表没有 word_tags 记录，直接按表内词频分层
    if (isCustomScope(scope)) return this._assessCustom(scope, count);

    const rr = this.q.rankRange.get(scope);
    if (!rr || !rr.n) return { questions: [], bands: [] };

    // 用 rank 的三分位切段；rank=999999 的低频词会自然落到最后一段
    const per = Math.max(1, Math.round(count / 3));
    const cuts = [
      [0, 3000, '高频'],
      [3001, 12000, '中频'],
      [12001, 999999, '低频'],
    ];

    const questions = [];
    const bands = [];
    for (const [lo, hi, name] of cuts) {
      const rows = this.q.sampleBand.all(scope, lo, hi, per * 3);
      let added = 0;
      for (const row of rows) {
        if (added >= per) break;
        const q = this.makeQuestion(scope, row, 'en2zh');
        if (q) {
          questions.push({ ...q, band: name });
          added++;
        }
      }
      bands.push({ name, lo, hi, asked: added });
    }
    return { questions: shuffle(questions), bands };
  }

  /** 自定义词表的水平检测：同样按词频三段分层 */
  _assessCustom(scope, count) {
    const all = this._customRows(scope);
    if (!all.length) return { questions: [], bands: [] };
    const per = Math.max(1, Math.round(count / 3));
    const cuts = [
      [0, 3000, '高频'],
      [3001, 12000, '中频'],
      [12001, 999999, '低频'],
    ];
    const questions = [];
    const bands = [];
    for (const [lo, hi, name] of cuts) {
      const pool = shuffle(all.filter((r) => r.rank >= lo && r.rank <= hi));
      let added = 0;
      for (const row of pool) {
        if (added >= per) break;
        const q = this.makeQuestion(scope, row, 'en2zh');
        if (q) {
          questions.push({ ...q, band: name });
          added++;
        }
      }
      bands.push({ name, lo, hi, asked: added });
    }
    return { questions: shuffle(questions), bands };
  }

  /** 把答题结果换算成掌握率估计 */
  static summarize(results, bands) {
    const byBand = new Map();
    for (const b of bands) byBand.set(b.name, { name: b.name, asked: 0, right: 0 });
    let right = 0;
    for (const r of results) {
      const b = byBand.get(r.band);
      if (b) {
        b.asked++;
        if (r.correct) b.right++;
      }
      if (r.correct) right++;
    }
    const n = results.length || 1;
    const p = right / n;
    // 95% 置信区间半宽（正态近似）
    const margin = 1.96 * Math.sqrt((p * (1 - p)) / n);
    return {
      total: results.length,
      right,
      rate: p,
      margin: Math.min(0.5, margin),
      bands: [...byBand.values()].map((b) => ({
        ...b,
        rate: b.asked ? b.right / b.asked : 0,
      })),
    };
  }
}

module.exports = {
  Quiz, SCOPE_LABELS, SCOPE_ORDER, KIND_LABELS, INPUT_KINDS,
  checkSpelling, isCustomScope,
};

});

/* ---- glossary (来自 src/main/glossary.js，未经修改) ---- */
__cjs.define("glossary", function (module, exports, require) {
'use strict';
/**
 * 术语表：用用户自己维护的译名去修正机器翻译的输出。
 *
 * 为什么需要它：本地翻译模型在专业术语上稳定地错，而且每次错得一样——
 *   policy            → 政策      （应为 策略）
 *   value function    → 价值功能  （应为 价值函数）
 *   replay buffer     → 重弹缓冲  （应为 经验回放缓冲）
 * 这类错误对读论文、上课是致命的，但它是**可预测**的，所以能修。
 *
 * 为什么不用词库自动修：实测过，不行。词库对课堂词汇命中 8/15，
 * 而错的那些会主动引入错义（value function → 明度函数 是光学义，
 * scalar → 数量/纯量 不是标量），且 replay buffer、ablation study 压根没收录；
 * 从整句里抽取时 replay buffer 抽不到、只抽到 replay → 重新比赛。
 * 自动替换会让译文更差。所以只认用户自己加的条目。
 *
 * ── 替换的门槛（这是这个模块的核心设计）──
 *
 * 只在**两个条件同时成立**时才动译文：
 *   1. 英文原文里确实出现了这个术语；
 *   2. 译文里确实出现了这个术语的某个「错译写法」。
 *
 * 缺一不可。只看条件 2 的话，「政策」这个词在任何谈政策的句子里都会被改成
 * 「策略」；只看条件 1 的话，我们并不知道该把译文里的哪几个字换掉。
 *
 * 「错译写法」从哪来：把术语单独喂给模型翻一次，拿到它的固定错法并缓存下来
 * （模型是确定性的，同一个词每次都译成同样的东西）。用户也可以手填补充，
 * 因为同一个词在不同上下文里模型可能给出不同的错法。
 */

/** 术语表条目上限。再多就该怀疑是不是误把词表粘进来了 */
const MAX_TERMS = 2000;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * 解析用户粘贴的术语表文本。
 *
 * 接受这些写法，因为人不会按格式来：
 *   policy = 策略
 *   policy    策略
 *   policy: 策略
 *   policy,策略
 *   policy = 策略   # 备注
 * `#` 或 `//` 开头的整行跳过。
 *
 * @returns {{ terms: Array<{surface,term,zh}>, skipped: number }}
 */
function parseGlossary(text) {
  const terms = [];
  const seen = new Set();
  let skipped = 0;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    /* 先按显式分隔符切；都没有才退到「两个以上空格」或「制表符」。
       不能用单个空格切——多词术语本身就带空格（replay buffer）。 */
    let left = null;
    let right = null;
    const m = line.match(/^(.+?)\s*(?:=|:|：|\||,|，|\t)\s*(.+)$/);
    if (m) {
      [, left, right] = m;
    } else {
      const m2 = line.match(/^(.+?)\s{2,}(.+)$/);
      if (m2) [, left, right] = m2;
    }

    if (!left || !right) { skipped += 1; continue; }

    // 行尾备注去掉
    right = right.replace(/\s*(?:#|\/\/).*$/, '').trim();
    const surface = left.trim();
    const term = norm(surface);

    // 英文侧必须是英文；中文侧必须含中文，否则多半是把别的东西粘进来了
    if (!term || !/[a-z]/.test(term) || !/^[a-z0-9\s'’.-]+$/.test(term)) { skipped += 1; continue; }
    if (!right || !/[一-鿿]/.test(right)) { skipped += 1; continue; }
    if (term.length > 64 || right.length > 80) { skipped += 1; continue; }
    if (seen.has(term)) { skipped += 1; continue; }

    seen.add(term);
    terms.push({ surface, term, zh: right });
    if (terms.length >= MAX_TERMS) break;
  }

  return { terms, skipped };
}

/**
 * 术语 → 匹配用正则。
 *
 * 缓存是必要的：一节课几百句，每句都要拿整张表（最多 2000 条）来匹配，
 * 不缓存就是每句现场构造两千个 RegExp。词表内容变了也不用清——
 * key 就是术语本身，同一个术语的正则永远一样。
 */
const RE_CACHE = new Map();
function termRe(term) {
  let re = RE_CACHE.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 术语后面跟标点或复数的情况也要认
    re = new RegExp(`(^|\\s)${esc}(s|es|'s)?([\\s.,;:!?)\\]]|$)`);
    RE_CACHE.set(term, re);
  }
  return re;
}

/**
 * 找出这段英文里命中的术语，按长的优先（replay buffer 要盖过 buffer）。
 *
 * @param text  英文原文
 * @param rows  术语表条目 [{ term, surface, zh, wrong: string[] }]
 */
function matchTerms(text, rows) {
  if (!text || !rows?.length) return [];
  const hay = ` ${norm(text)} `;
  const hits = [];
  for (const r of rows) {
    /* 用空格包边做整词匹配：不加的话 `policy` 会命中 `policymaker`，
       `ai` 会命中句子里几乎每个含这两个字母的词。 */
    if (hay.includes(` ${r.term} `) || termRe(r.term).test(hay)) hits.push(r);
  }
  // 长术语优先：替换时先处理它，避免被短术语切开
  return hits.sort((a, b) => b.term.length - a.term.length);
}

/**
 * 错译写法的候选：原形，以及去掉最后一个字的形式。
 *
 * 为什么要去掉一个字：探测拿到的写法常常比译文里实际出现的多一个尾字。
 * 实测 `replay buffer` 探到「反弹缓冲器」，而句子里出现的是「反弹缓冲」——
 * 差一个「器」，整条术语就白配置了。中文译名的尾部量词/后缀
 * （器、区、性、的）本来就是可有可无的。
 *
 * 只削一个字，且削完必须还有三个字。放宽会出事：
 * 「反弹缓冲器」一路削成「反弹」，那两个字在别的句子里也会出现。
 */
function withTrimmed(w) {
  return w.length >= 4 ? [w, w.slice(0, -1)] : [w];
}

/**
 * 把译文里的错译写法换成用户指定的译名。
 *
 * @param zh    机器译文
 * @param hits  matchTerms 的结果
 * @returns {{ text, applied: Array<{term,from,to}> }}
 */
function applyGlossary(zh, hits) {
  let out = String(zh || '');
  const applied = [];
  if (!out || !hits?.length) return { text: out, applied };

  for (const h of hits) {
    if (out.includes(h.zh)) continue;   // 模型已经译对了，别动

    /* 候选错译写法按长度倒序：同一个术语可能有「价值功能」和「功能」两种错法，
       先换长的，否则短的会把长的切碎。 */
    const forms = [...new Set((h.wrong || []).filter(Boolean))]
      .sort((a, b) => b.length - a.length);

    let done = false;
    for (const w of forms) {
      if (done) break;
      if (w === h.zh) continue;
      /* 只挡单字错法。中文术语绝大多数是两个字（政策、策略、缓冲），
         门槛设到三个字会把最常见的情况全堵死——这是写测试时发现的。
         单字（「能」「量」「数」）在中文里到处都是，拿来替换会把整句改烂，
         而两字以上配合「英文原文里必须出现这个术语」那道门槛已经足够安全。 */
      if (w.length < 2) continue;

      for (const cand of withTrimmed(w)) {
        if (!out.includes(cand)) continue;
        out = out.split(cand).join(h.zh);
        applied.push({ term: h.surface, from: cand, to: h.zh });
        done = true;   // 一个术语只改一次，改完就走
        break;
      }
    }
  }

  return { text: out, applied };
}

/**
 * 折叠紧邻的整体重复。
 *
 * 模型拿到一个孤零零的词时经常原地打转，实测输出：
 *   policy   → 政策政策
 *   scalar   → 标标
 *   baseline → 基准基准基准基准
 * 不折叠的话这些写法在真实译文里永远匹配不上，等于白探一次。
 */
function collapseRepeat(t) {
  const n = t.length;
  for (let len = 1; len <= n / 2; len++) {
    if (n % len) continue;
    const unit = t.slice(0, len);
    if (unit.repeat(n / len) === t) return unit;
  }
  return t;
}

/**
 * 清洗探测结果：把模型的原始输出变成可用的错译写法。
 *
 * 模型不会老老实实只回一个词。实际见到的：
 *   "政策。"          → 带句末标点
 *   "政策 (policy)"   → 把原词也带出来
 *   "政策政策"        → 孤零零一个词时原地打转
 *   "这项政策是指…"   → NLLB 有时会补成一句话
 * 最后一种没法用——拿一整句去做子串替换会把译文改烂，直接丢掉。
 *
 * @returns {string|null} 可用的写法，或 null 表示这次探测没拿到东西
 */
function cleanProbe(raw) {
  let t = String(raw || '').trim();
  if (!t) return null;
  // 括注、书名号里的补充说明去掉
  t = t.replace(/[（(【[].*?[)）\]】]/g, '').trim();
  // 首尾标点去掉（中英文都要）
  t = t.replace(/^[\s"'“”‘’、，。；：!?！？.,;:-]+/, '')
    .replace(/[\s"'“”‘’、，。；：!?！？.,;:-]+$/, '').trim();
  if (!t) return null;
  // 必须是中文；混着拉丁字母的多半是模型没译或者把原词抄回来了
  if (!/[一-鿿]/.test(t) || /[a-zA-Z]/.test(t)) return null;
  /* 超过 12 个字基本就是一句话而不是一个词。拿句子做子串替换会毁掉译文，
     而术语再长也就「经验回放缓冲区」这个量级。 */
  if (t.length > 12) return null;
  return collapseRepeat(t);
}

/**
 * 掐掉两串的共同头尾，返回 a 中间不一样的那段。
 *
 * 用来从「框架句」里抠出术语的译法：把 `We use the replay buffer.` 和
 * `We use the thing.` 的译文一减，中间剩下的就是模型给 replay buffer 的写法。
 *
 * 为什么需要这一手：模型对同一个术语的错译**不是固定的**，取决于上下文。
 * 单独问 replay buffer 给的是「复制缓冲器」，而句子里出现的是「反弹缓冲」，
 * 拿前者去替换什么也换不动。框架句更接近真实语境。
 */
function diffMiddle(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y) return '';
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i
    && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return x.slice(i, x.length - j);
}

/** 框架句：问模型「它在句子里怎么译这个术语」。X 位置换成控制词就是对照 */
const PROBE_FRAME = (x) => `We use the ${x}.`;
/** 控制词：挑一个模型一定会稳定翻译、且不会和任何术语混起来的普通名词 */
const PROBE_CONTROL = 'thing';

/**
 * 框架做差的结果可不可信。
 *
 * 做差假定两句译文只在术语那一段不同，但模型会改写框架本身。实测
 * `We use the value function.` 得到的差是「使用价值函数」——把框架里的
 * 动词吸进来了。这种写法一旦命中，替换会连「使用」一起删掉，是真能改坏译文的。
 *
 * 判据：差异段不该含有对照译文里的任何字。含了就说明框架没对齐，这次不算。
 */
function frameDiffOk(form, ctrlZh) {
  if (!form) return false;
  if (!ctrlZh) return true;
  const ctrl = new Set(String(ctrlZh));
  for (const ch of form) if (ctrl.has(ch)) return false;
  return true;
}

/**
 * 需要向模型问「它把这些术语译成什么」的条目。
 * 已经问过的（wrong 非空）就不用再问——模型是确定性的，问一次就够。
 */
function needProbe(hits) {
  return hits.filter((h) => !h.wrong || !h.wrong.length);
}

module.exports = {
  parseGlossary, matchTerms, applyGlossary, needProbe, cleanProbe, diffMiddle,
  frameDiffOk, PROBE_FRAME, PROBE_CONTROL, norm, MAX_TERMS,
};

});
