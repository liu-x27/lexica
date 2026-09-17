'use strict';
/**
 * 把 Kotlin 的 AndroidSql 桥包装成 node:sqlite 的 DatabaseSync 形状。
 *
 * 桌面版的 dict-db.js / user-db.js / quiz.js 是照着 node:sqlite 的同步 API 写的
 * （prepare().get()/all()/run()）。JavascriptInterface 的调用在 JS 侧恰好也是同步的，
 * 所以只要把形状对齐，那三个文件就能一个字不改地在 WebView 里跑——
 * 安卓端和桌面端共用同一份查询逻辑，不会各自漂移。
 */
(function (g) {
  const bridge = g.AndroidSql;

  /** 桥的返回值统一是 JSON 字符串，失败时抛出，让调用方的 try/catch 正常工作 */
  function call(fn, ...args) {
    const raw = fn.apply(bridge, args);
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      throw new Error(`SQL 桥返回了非 JSON：${String(raw).slice(0, 120)}`);
    }
    if (!r.ok) throw new Error(r.error || 'SQL 执行失败');
    return r;
  }

  /** 事务语句要走 exec 通道，那边映射到了 beginTransaction()，不能当普通 DDL 发 */
  const TX = /^\s*(BEGIN|COMMIT|END|ROLLBACK)\b/i;

  /* 日志模式由 Kotlin 侧决定，这里必须忽略。
     user-db.js 构造时会设 WAL（桌面上是对的），但安卓侧刻意不开：
     开了 WAL 连接池会用多条连接，而 BEGIN/COMMIT 映射到 beginTransaction()
     的前提是写操作都落在同一条连接上。 */
  const JOURNAL = /^\s*PRAGMA\s+journal_mode\b/i;

  class Statement {
    constructor(which, sql) {
      this.which = which;
      this.sql = sql;
      // node:sqlite 默认把 INTEGER 读成 number，这里也保持 number（桥已经按类型返回）
    }

    all(...params) {
      return call(bridge.query, this.which, this.sql, JSON.stringify(params)).rows;
    }

    /** 没有行时返回 undefined —— 调用方普遍写的是 `if (!row)`，返回 null 也行但保持一致 */
    get(...params) {
      const rows = this.all(...params);
      return rows.length ? rows[0] : undefined;
    }

    run(...params) {
      const r = call(bridge.exec, this.which, this.sql, JSON.stringify(params));
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    }
  }

  class DatabaseSync {
    /**
     * @param {string} file 数据库路径。只用来判断是哪一个库——真正的打开在 Kotlin 侧，
     *                      两个连接在 Activity 启动时就建好了。
     */
    constructor(file) {
      this.which = /user\.db$/i.test(String(file || '')) ? 'user' : 'dict';
      this.file = file;
    }

    exec(sql) {
      if (JOURNAL.test(sql)) return;
      if (TX.test(sql)) return void call(bridge.exec, this.which, sql.trim(), '[]');
      call(bridge.execScript, this.which, sql);
    }

    prepare(sql) {
      return new Statement(this.which, sql);
    }

    /** 连接由 Activity 管生命周期，页面这边关掉没有意义 */
    close() {}
  }

  g.AndroidSQLite = { DatabaseSync, sqliteVersion: () => bridge.sqliteVersion() };
})(globalThis);
