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

/** 每个词最多记几条语境。再多就是噪音，而且复习卡上只放得下一条 */
const MAX_CONTEXTS = 5;

/**
 * 生词本行的 contexts 列是 JSON 字符串，出库前统一解开。
 * 坏数据不能让整行读不出来，解不开就当没有。
 */
function hydrate(row) {
  if (!row) return row;
  let contexts = [];
  if (row.contexts) {
    try {
      const v = JSON.parse(row.contexts);
      if (Array.isArray(v)) contexts = v.filter((c) => c && typeof c.en === 'string');
    } catch { /* 忽略 */ }
  }
  return { ...row, contexts };
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
      // v5：生词本记下「在哪句话里遇到的」
      () => this._migrateV5(),
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

  /**
   * v5：语境。在字幕或翻译页里点词收进生词本时，把那句话一起记下来。
   *
   * 单独一列，**不塞进 note**：note 是用户自己写的，机器往里追加文字，
   * 用户删掉一次、下次又被追加回来，越积越乱。语境是程序管的，
   * 最多留 5 条、按句子去重，用户也能在编辑框里逐条删。
   *
   * JSON 数组：[{ en, zh, src, at }]。src 是出处（课名 / 「整段翻译」/ 「视频字幕」）。
   */
  _migrateV5() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(wordbook)').all().map((c) => c.name));
    if (!cols.has('contexts')) this.db.exec('ALTER TABLE wordbook ADD COLUMN contexts TEXT');
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
      wbContexts: d.prepare('UPDATE wordbook SET contexts = ? WHERE word = ?'),
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

  /** 单个生词本条目（含注释与语境）。不在生词本里返回 null */
  entry(word) {
    return hydrate(this.q.get.get(String(word || '').trim()) || null);
  }

  /**
   * 记一条语境（在哪句话里遇到这个词）。词不在生词本里就先加进来——
   * 这个入口就是「点了字幕里的词、按下收进生词本」。
   *
   * 按英文句子去重，最多留 MAX_CONTEXTS 条，新的在前。
   * 同一句话重复点收藏不该堆出好几条一模一样的。
   *
   * @returns {{ok, word, added:boolean, contexts}}  added=这次是新加进生词本的
   */
  addContext(word, { en, zh = null, src = null } = {}) {
    const w = String(word || '').trim();
    const sentence = String(en || '').trim();
    if (!w) return { ok: false, reason: '单词不能为空' };

    let added = false;
    if (!this.q.has.get(w)) {
      const now = Date.now();
      this.q.add.run(w, now, now);
      added = true;
    }
    const row = hydrate(this.q.get.get(w));
    let list = row.contexts;
    if (sentence) {
      const item = {
        en: sentence.slice(0, 400),
        zh: zh ? String(zh).trim().slice(0, 400) || null : null,
        src: src ? String(src).trim().slice(0, 60) || null : null,
        at: Date.now(),
      };
      list = [item, ...list.filter((c) => c.en !== item.en)].slice(0, MAX_CONTEXTS);
      this.q.wbContexts.run(JSON.stringify(list), w);
    }
    return { ok: true, word: w, added, contexts: list };
  }

  /** 删一条语境（编辑框里的 ×）。按下标删，删完剩空数组就存 NULL */
  removeContext(word, index) {
    const w = String(word || '').trim();
    const row = hydrate(this.q.get.get(w) || null);
    if (!row) return { ok: false, reason: '不在生词本里' };
    const list = row.contexts.filter((_, i) => i !== Number(index));
    this.q.wbContexts.run(list.length ? JSON.stringify(list) : null, w);
    return { ok: true, contexts: list };
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
    return this.q.list.all(limit, offset).map(hydrate);
  }

  allWords() {
    return this.q.allWords.all().map(hydrate);
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
    return this.q.listDue.all(Date.now(), limit).map(hydrate);
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
  /**
   * @param opts.replace       先清空再导入（「覆盖导入」）
   * @param opts.keepExisting  已有的术语不动（起步包用）。
   *        起步包里的 policy = 策略 绝不能覆盖你自己写的 policy = 方针：
   *        你写的是你的课上的说法，起步包只是通行译法。
   */
  importGlossary(text, { replace = false, keepExisting = false } = {}) {
    const { terms, skipped } = parseGlossary(text);
    if (!terms.length) return { ok: false, reason: '没有解析出任何术语', skipped };

    const have = keepExisting && !replace ? new Set(this.glossary().map((r) => r.term)) : null;
    const fresh = have ? terms.filter((t) => !have.has(t.term)) : terms;
    const kept = terms.length - fresh.length;
    if (!fresh.length) return { ok: true, count: 0, skipped, kept, dropped: 0 };

    const room = MAX_TERMS - (replace ? 0 : this.glossaryCount());
    if (room <= 0) return { ok: false, reason: `术语表已满（上限 ${MAX_TERMS} 条）` };
    const use = fresh.slice(0, room);

    this.db.exec('BEGIN');
    try {
      if (replace) this.q.gClear.run();
      const now = Date.now();
      for (const t of use) this.q.gPut.run(t.term, t.surface, t.zh, null, null, now);
      this.db.exec('COMMIT');
      return { ok: true, count: use.length, skipped, kept, dropped: fresh.length - use.length };
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
const SCHEMA_VERSION = 5;

module.exports = { UserDB, DAY, SCHEMA_VERSION, MAX_CONTEXTS };
