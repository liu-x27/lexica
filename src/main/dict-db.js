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
