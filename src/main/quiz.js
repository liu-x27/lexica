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
