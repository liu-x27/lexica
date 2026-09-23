/**
 * 安卓 Web 层的回归测试。
 *
 * 真机跑不了（本机没有 AVD 也没有设备），但**能出问题的绝大部分在 JS 侧**：
 * CommonJS 的包装、DatabaseSync 形状的模拟、SQL 参数与返回值的往返。
 * 这里用 node:sqlite 搭一个与 Kotlin 的 SqlBridge 同构的桩，把 assets/www 里
 * 真正会被加载的那几个文件按同样的顺序跑一遍。
 *
 * 桩必须与 SqlBridge.kt 的分发逻辑保持一致——它就是那份契约的可执行版本。
 * 改了 Kotlin 那边，这里也要跟着改，否则测试通过而真机崩。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const WWW = path.join(ROOT, 'android/app/src/main/assets/www');
const DICT = path.join(ROOT, 'data/dict-mobile-slim.db');

const hasAssets = fs.existsSync(path.join(WWW, 'js/core.js'));
const hasDict = fs.existsSync(DICT);

/* ====================================================================== */
/*  AndroidSql 的 Node 版桩：逐条对应 SqlBridge.kt                        */
/* ====================================================================== */

function makeSqlBridge(dictFile, userFile) {
  const dict = new DatabaseSync(dictFile, { readOnly: true });
  const user = new DatabaseSync(userFile);
  const dbOf = (which) => (which === 'user' ? user : dict);

  const ok = (o) => JSON.stringify({ ok: true, ...o });
  const err = (e) => JSON.stringify({ ok: false, error: String(e.message || e) });

  /** 与 Kotlin 的 verbOf 一致：跳过前导空白与注释后的第一个关键字 */
  const verbOf = (sql) => {
    const s = String(sql).replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '');
    return (s.match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
  };

  /** 与 Kotlin 的 splitStatements 对应：按分号切，跳过字符串与注释里的分号 */
  const splitStatements = (sql) => {
    const out = [];
    let buf = '';
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      if (c === "'") {
        buf += c;
        while (++i < sql.length) {
          buf += sql[i];
          if (sql[i] === "'") {
            if (sql[i + 1] === "'") buf += sql[++i];
            else break;
          }
        }
      } else if (c === '-' && sql[i + 1] === '-') {
        while (i < sql.length && sql[i] !== '\n') i++;
      } else if (c === '/' && sql[i + 1] === '*') {
        i += 2;
        while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i++;
      } else if (c === ';') {
        out.push(buf);
        buf = '';
      } else buf += c;
    }
    out.push(buf);
    return out;
  };

  let depth = 0; // 模拟 beginTransaction / endTransaction

  return {
    sqliteVersion: () => dict.prepare('SELECT sqlite_version() v').get().v,

    query(which, sql, args) {
      try {
        return ok({ rows: dbOf(which).prepare(sql).all(...JSON.parse(args || '[]')) });
      } catch (e) {
        return err(e);
      }
    },

    exec(which, sql, args) {
      const db = dbOf(which);
      try {
        switch (verbOf(sql)) {
          case 'BEGIN':
            db.exec('BEGIN');
            depth++;
            return ok({ changes: 0, lastInsertRowid: -1 });
          case 'COMMIT': case 'END':
            db.exec('COMMIT');
            depth--;
            return ok({ changes: 0, lastInsertRowid: -1 });
          case 'ROLLBACK':
            db.exec('ROLLBACK');
            depth--;
            return ok({ changes: 0, lastInsertRowid: -1 });
          default: {
            const r = db.prepare(sql).run(...JSON.parse(args || '[]'));
            return ok({ changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) });
          }
        }
      } catch (e) {
        return err(e);
      }
    },

    /**
     * 逐条执行，并复刻 Android 的一条硬性限制：execSQL 拒绝会返回数据的语句，
     * 报的是「Queries can be performed using SQLiteDatabase query or rawQuery
     * methods only」——真机上踩过。PRAGMA 的赋值形式也会回一行，所以要单独走查询路径。
     * node:sqlite 本身不管这些，这里主动模拟出来，好让这类错误在测试里就暴露。
     */
    execScript(which, sql) {
      const db = dbOf(which);
      try {
        for (const stmt of splitStatements(sql)) {
          if (!stmt.trim()) continue;
          if (verbOf(stmt) === 'PRAGMA') db.prepare(stmt).all();
          else if (/^\s*(SELECT|WITH|VALUES|EXPLAIN)\b/i.test(stmt)) {
            throw new Error('Queries can be performed using SQLiteDatabase query or rawQuery methods only.');
          } else db.exec(stmt);
        }
        return ok({});
      } catch (e) {
        return err(e);
      }
    },

    _close() { dict.close(); user.close(); },
    get _depth() { return depth; },
  };
}

/** 按 index.html 的顺序在一个隔离上下文里加载数据层 */
function bootDataLayer(userFile) {
  const sandbox = { console, JSON, Math, Date, RegExp, Error, Object, Array, String, Number, Set, Map };
  sandbox.globalThis = sandbox;
  sandbox.AndroidSql = makeSqlBridge(DICT, userFile);
  vm.createContext(sandbox);

  for (const f of ['js/android-sqlite.js', 'js/cjs-runtime.js', 'js/core.js']) {
    vm.runInContext(fs.readFileSync(path.join(WWW, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

const tmpUser = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lexica-')), 'user.db');

/* ====================================================================== */

test('assets/www 已生成', () => {
  assert.ok(hasAssets, '先运行 node scripts/build-android-www.mjs');
});

test('core.js 能加载出三个共用模块', { skip: !hasAssets || !hasDict }, () => {
  const s = bootDataLayer(tmpUser());
  const dictMod = s.__cjs.require('dict-db');
  assert.ok(typeof dictMod.DictDB === 'function');
  assert.ok(typeof dictMod.parseTranslation === 'function');
  assert.ok(typeof s.__cjs.require('user-db').UserDB === 'function');
  assert.ok(typeof s.__cjs.require('quiz').Quiz === 'function');
  s.AndroidSql._close();
});

test('查词走通桥：词条内容与桌面版一致', { skip: !hasAssets || !hasDict }, () => {
  const s = bootDataLayer(tmpUser());
  const { DictDB, setDatabaseOpener } = s.__cjs.require('dict-db');
  setDatabaseOpener((f) => new s.AndroidSQLite.DatabaseSync(f));

  const dict = new DictDB('dict.db');
  assert.ok(dict.open(), `打开失败：${dict.error}`);

  const r = dict.lookup('run');
  assert.equal(r.status, 'ok');
  assert.equal(r.entry.word, 'run');
  assert.ok(r.entry.senses.length > 0, '应该有 WordNet 义项');
  assert.ok(r.entry.translation.length > 0, '应该有中文释义');
  assert.ok(r.entry.tags.some((t) => t.code === 'zk'), '应该带考纲标签');

  // 变形还原
  assert.equal(dict.lookup('ran').entry.word, 'run');
  // 中文反查
  assert.equal(dict.lookup('梯度下降').status, 'list');

  s.AndroidSql._close();
});

test('briefMany 批量取释义', { skip: !hasAssets || !hasDict }, () => {
  const s = bootDataLayer(tmpUser());
  const { DictDB, setDatabaseOpener } = s.__cjs.require('dict-db');
  setDatabaseOpener((f) => new s.AndroidSQLite.DatabaseSync(f));
  const dict = new DictDB('dict.db');
  dict.open();

  const m = dict.briefMany(['run', 'Book', 'apple', '__nope__']);
  assert.equal(m.size, 3, '查不到的词不应出现在结果里');
  assert.ok(m.get('book').brief.length > 0);
  assert.equal(m.has('__nope__'), false);
  // 大小写不敏感，键是小写
  assert.ok(m.has('book'));

  s.AndroidSql._close();
});

test('user.db 迁移 + 生词本 + SM-2 调度', { skip: !hasAssets || !hasDict }, () => {
  const s = bootDataLayer(tmpUser());
  const { UserDB } = s.__cjs.require('user-db');
  const user = new UserDB('');

  assert.equal(user.toggle('ephemeral').saved, true);
  assert.equal(user.isSaved('ephemeral'), true);
  assert.equal(user.counts().total, 1);

  const g = user.grade('ephemeral', 'good');
  assert.equal(g.ivl, 1, '第一次答对应该是 1 天后');
  assert.equal(user.grade('ephemeral', 'good').ivl, 6, '第二次是 6 天后');

  assert.equal(user.toggle('ephemeral').saved, false, '再次 toggle 应该移除');
  assert.equal(user.counts().total, 0);

  s.AndroidSql._close();
});

/**
 * 这条是冲着 SqlBridge.kt 里那个真实存在过的 bug 来的：
 * executeUpdateDelete() 和 executeInsert() 都会真的执行一遍语句，
 * 两个都调的话，history / quiz_log 这种没有主键的表会凭空多出一倍的行。
 */
test('无主键表的写入不会重复插入', { skip: !hasAssets || !hasDict }, () => {
  const s = bootDataLayer(tmpUser());
  const { UserDB } = s.__cjs.require('user-db');
  const user = new UserDB('');

  user.pushHistory('alpha');
  user.pushHistory('beta');
  user.pushHistory('alpha');

  const rows = user.db.prepare('SELECT COUNT(*) c FROM history').get();
  assert.equal(rows.c, 3, 'push 三次就应该只有三行');

  user.recordAnswer({ scope: 'cet4', kind: 'en2zh', word: 'alpha', correct: true });
  assert.equal(user.db.prepare('SELECT COUNT(*) c FROM quiz_log').get().c, 1);
  // 统计表用的是 upsert，seen 必须只加一次
  assert.equal(user.db.prepare('SELECT seen FROM quiz_stats WHERE word = ?').get('alpha').seen, 1);

  s.AndroidSql._close();
});

/**
 * 真机上第一次启动就挂在这里：`PRAGMA mmap_size = N` 的赋值形式也会返回一行，
 * 而 Android 的 execSQL 见到返回数据的语句直接抛
 * 「Queries can be performed using SQLiteDatabase query or rawQuery methods only」。
 * user.db 的迁移会写 PRAGMA user_version，所以这条路径必须走查询通道。
 */
test('PRAGMA 走的是查询通道', { skip: !hasAssets || !hasDict }, () => {
  const s = bootDataLayer(tmpUser());
  const db = new s.AndroidSQLite.DatabaseSync('user.db');

  // 赋值形式：不能抛
  db.exec('PRAGMA user_version = 7');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);

  // journal_mode 由 Kotlin 侧决定，shim 必须直接忽略而不是转发过去
  db.exec('PRAGMA journal_mode = WAL');
  assert.notEqual(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');

  s.AndroidSql._close();
});

test('迁移过后 user_version 落到最新版本', { skip: !hasAssets || !hasDict }, () => {
  const s = bootDataLayer(tmpUser());
  const { UserDB, SCHEMA_VERSION } = s.__cjs.require('user-db');
  const user = new UserDB('');
  assert.equal(user.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  // 再开一次不应重复迁移
  const again = new UserDB('');
  assert.equal(again.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  s.AndroidSql._close();
});

test('事务能正确提交与回滚', { skip: !hasAssets || !hasDict }, () => {
  const s = bootDataLayer(tmpUser());
  const { UserDB } = s.__cjs.require('user-db');
  const user = new UserDB('');

  const r = user.createList('测试词表', 'apple\nbanana\n# 注释\napple\n');
  assert.equal(r.ok, true);
  assert.equal(r.count, 2, '重复词要去掉，注释行要跳过');
  assert.equal(s.AndroidSql._depth, 0, '事务必须已经关闭');

  assert.deepEqual(user.listWords(r.id), ['apple', 'banana']);
  assert.equal(user.lists()[0].n, 2);

  user.deleteList(r.id);
  assert.equal(user.lists().length, 0);
  assert.equal(s.AndroidSql._depth, 0);

  s.AndroidSql._close();
});

test('参数类型经过 JSON 往返后仍然正确', { skip: !hasAssets || !hasDict }, () => {
  const s = bootDataLayer(tmpUser());
  const { UserDB } = s.__cjs.require('user-db');
  const user = new UserDB('');

  user.toggle('gamma');
  // ease 是 REAL，due 是 INTEGER：两者都要能原样存回来
  user.grade('gamma', 'easy');
  const row = user.db.prepare('SELECT * FROM wordbook WHERE word = ?').get('gamma');
  assert.equal(typeof row.ease, 'number');
  assert.ok(row.ease > 2.5 && row.ease <= 3.0, `ease 应该在 2.5~3.0，实际 ${row.ease}`);
  assert.ok(row.due > Date.now(), 'due 应该是未来的毫秒时间戳');
  assert.equal(typeof row.reps, 'number');

  s.AndroidSql._close();
});

test('出题引擎在桥上能正常出题', { skip: !hasAssets || !hasDict }, () => {
  const s = bootDataLayer(tmpUser());
  const { DictDB, setDatabaseOpener } = s.__cjs.require('dict-db');
  const { UserDB } = s.__cjs.require('user-db');
  const { Quiz } = s.__cjs.require('quiz');
  setDatabaseOpener((f) => new s.AndroidSQLite.DatabaseSync(f));

  const dict = new DictDB('dict.db');
  dict.open();
  const user = new UserDB('');
  const quiz = new Quiz(dict);
  quiz.setCustomSource({ lists: () => user.lists(), words: (id) => user.listWords(id) });

  const scopes = quiz.scopes();
  assert.ok(scopes.length >= 10, `范围数偏少：${scopes.length}`);
  assert.ok(scopes.every((x) => typeof x.scope === 'string' && !/^\d+$/.test(x.scope)),
    '范围标识不该是纯数字——那说明 word_tags 的列又错位了');

  const qs = quiz.batch('cet4', 5, { kinds: ['en2zh', 'zh2en'] });
  assert.equal(qs.length, 5);
  for (const q of qs) {
    assert.equal(q.options.length, 4);
    assert.ok(q.answer >= 0 && q.answer < 4);
    assert.ok(q.word);
  }

  assert.ok(quiz.studyBatch('toefl', 5).length > 0);

  s.AndroidSql._close();
});

test('index.html 按正确顺序加载脚本', { skip: !hasAssets }, () => {
  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  const order = [...html.matchAll(/<script src="js\/([^"]+)"/g)].map((m) => m[1]);
  // 数据层必须在渲染层之前：app.js 启动时就会调 window.lexica
  assert.ok(order.indexOf('android-sqlite.js') < order.indexOf('cjs-runtime.js'));
  assert.ok(order.indexOf('cjs-runtime.js') < order.indexOf('core.js'));
  assert.ok(order.indexOf('core.js') < order.indexOf('lexica-shim.js'));
  assert.ok(order.indexOf('lexica-shim.js') < order.indexOf('app.js'));
  // mobile.js 要能覆盖 ui.js 里的 Lx.tts，必须排在它后面、app.js 前面
  assert.ok(order.indexOf('ui.js') < order.indexOf('mobile.js'));
  assert.ok(order.indexOf('mobile.js') < order.indexOf('app.js'));
});

test('www 里的渲染层与 src/renderer 逐字节一致', { skip: !hasAssets }, () => {
  for (const f of ['ui.js', 'entry-view.js', 'drill.js', 'custom.js', 'views.js', 'app.js']) {
    assert.deepEqual(
      fs.readFileSync(path.join(WWW, 'js', f)),
      fs.readFileSync(path.join(ROOT, 'src/renderer/js', f)),
      `${f} 与桌面版不一致——安卓专有的改动应该放到 android/www-src 里`,
    );
  }
});

test('shim 覆盖了 preload 暴露的全部接口', { skip: !hasAssets || !hasDict }, () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf8');

  // 取 contextBridge 暴露对象里的键名
  const body = preload.slice(preload.indexOf('exposeInMainWorld'));
  const names = [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  assert.ok(names.length > 30, `没解析出接口名，只找到 ${names.length} 个`);

  /* 查真正启动起来的 window.lexica，不查源码文本：共用的那一大半是从 app-core
     展开进来的，源码里根本看不到方法名。 */
  const s = bootShim(tmpUser(), async () => ({}));
  const missing = names.filter((n) => typeof s.lexica[n] !== 'function');
  s.AndroidSql._close();
  assert.deepEqual(missing, [], `安卓 shim 缺少这些接口，渲染层调用时会崩`);
});

/* 下面两条原先都是安卓版的真 bug：shim 手抄了一份桌面的处理函数，抄漏了。
   现在两边用的是 app-core 同一份实现，这两条盯着它别再分叉。 */

test('安卓：词表带着练习范围，「去练习」不会把范围存成空串', { skip: !hasAssets || !hasDict }, async () => {
  const s = bootShim(tmpUser(), async () => ({}));
  const r = await s.lexica.listCreate('课程词表', 'apple\nbanana', null);
  assert.equal(r.ok, true);
  const [list] = await s.lexica.lists();
  assert.equal(list.scope, `list:${r.id}`);
  const scopes = (await s.lexica.drillScopes()).map((x) => x.scope);
  assert.ok(scopes.includes(list.scope), '词表的范围名必须是练习页认得的那一个');
  s.AndroidSql._close();
});

test('安卓：生词本导出和桌面一样，带着我的释义、笔记、出处和例句', { skip: !hasAssets || !hasDict }, async () => {
  const s = bootShim(tmpUser(), async () => ({}));
  const shared = [];
  s.AndroidApp.saveAndShare = (filename, content) => {
    shared.push({ filename, content });
    return JSON.stringify({ ok: true, path: `/tmp/${filename}` });
  };
  await s.lexica.wbAdd({ word: 'apple', note: '水果', myDef: '我的苹果' });
  await s.lexica.wbAddContext({ word: 'apple', en: 'An apple a day.', src: '第一课' });

  const r = await s.lexica.wbExport('csv');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.count, 1);
  const [header, row] = shared[0].content.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(header, ['单词', '音标', '释义', '我的释义', '我的笔记', '出处', '例句', '难度标签', '加入时间', '复习次数']
    .map((h) => `"${h}"`).join(','));
  assert.ok(shared[0].content.startsWith('\uFEFF'), 'Excel 要靠 BOM 认出 UTF-8');
  for (const v of ['我的苹果', '水果', 'An apple a day.（第一课）']) {
    assert.ok(row.includes(`"${v}"`), `导出行里没有 ${v}：${row}`);
  }
  s.AndroidSql._close();
});

/* ====================================================================== */
/*  在线翻译（安卓唯一联网的地方）                                         */
/* ====================================================================== */

/**
 * 把整个 shim 拉进沙箱：数据层之外再配一个假的 Kotlin 桥（AndroidApp）和假的 fetch。
 * 这次改动在真机上验不了（手边没有设备），能在沙箱里跑的路径都要跑到。
 */
function bootShim(userFile, fetchImpl) {
  const s = bootDataLayer(userFile);
  s.AndroidApp = {
    appendLog() {}, toast() {}, setTheme() {}, version: () => 'test',
    dataDir: () => '/tmp', takePendingText: () => '',
  };
  s.fetch = fetchImpl;
  s.AbortController = AbortController;
  s.setTimeout = setTimeout;
  s.clearTimeout = clearTimeout;
  s.Promise = Promise;
  s.URL = URL;
  s.encodeURIComponent = encodeURIComponent;
  s.decodeURIComponent = decodeURIComponent;
  s.addEventListener = () => {};
  vm.runInContext(fs.readFileSync(path.join(WWW, 'js/lexica-shim.js'), 'utf8'), s, { filename: 'lexica-shim.js' });
  return s;
}

/** 假的 Google 返回：[[[译文片段, 原文片段]], …] */
function fakeGoogle(map) {
  const calls = [];
  const fn = async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
    calls.push(q);
    const zh = q.split('\n').map((line) => map[line] || `译：${line}`).join('\n');
    return { ok: true, status: 200, json: async () => [zh.split('\n').map((l, i, a) => [i < a.length - 1 ? `${l}\n` : l, '']), null, 'en'] };
  };
  fn.calls = calls;
  return fn;
}

test('安卓：在线翻译默认关，关着时不发任何请求', { skip: !hasAssets || !hasDict }, async () => {
  const f = fakeGoogle({});
  const s = bootShim(tmpUser(), f);
  const st = await s.lexica.mtStatus();
  assert.equal(st.available, false, '默认必须是关的——开了就会把文本发给第三方');
  const r = await s.lexica.mtTranslate('A scalar reward.');
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 0, '关着还发请求，等于偷偷外发数据');
  s.AndroidSql._close();
});

test('安卓：打开在线翻译后查词组能拿到译文，状态跟着变', { skip: !hasAssets || !hasDict }, async () => {
  const f = fakeGoogle({ 'A scalar reward.': '标量奖励。' });
  const s = bootShim(tmpUser(), f);
  await s.lexica.putSettings({ mtOnline: true });

  const st = await s.lexica.mtStatus();
  assert.equal(st.available, true);
  assert.equal(st.localAvailable, false, '安卓没有本地模型');
  assert.equal(st.glossary, false, '安卓不接术语表，界面要据此把那个 tab 藏起来');
  assert.equal((await s.lexica.stats()).mtAvailable, true, '查词页的自动翻译看的是 stats');

  const r = await s.lexica.mtTranslate('A scalar reward.');
  assert.equal(r.ok, true);
  assert.equal(r.text, '标量奖励。');
  assert.equal(r.via, 'online');
  s.AndroidSql._close();
});

/* 分享进来的整段文字走这条路。切句规则必须和桌面版同一套（sentence-split），
   否则 e.g. 这类缩写会被切碎，双语对照就错位了。 */
test('安卓：整段翻译按桌面同一套规则切句，一次请求翻完', { skip: !hasAssets || !hasDict }, async () => {
  const f = fakeGoogle({});
  const s = bootShim(tmpUser(), f);
  await s.lexica.putSettings({ mtOnline: true });

  const progress = [];
  s.lexica.onMtProgress((p) => progress.push(p));
  const r = await s.lexica.mtTranslateLong('We use e.g. a buffer. Accuracy improved to 0.91. Next.', 't1');
  assert.equal(r.ok, true);
  // 数组是沙箱里造的（另一个 realm），deepStrictEqual 连原型都比，得先转回来
  assert.deepEqual(Array.from(r.sentences, (x) => x.src),
    ['We use e.g. a buffer.', 'Accuracy improved to 0.91.', 'Next.'], 'e.g. 和 0.91 都不该被切开');
  assert.equal(f.calls.length, 1, '三句应当一次往返');
  assert.ok(progress.some((p) => p.token === 't1' && p.done === p.total), '要推完成进度，结果页才会动');
  s.AndroidSql._close();
});

test('安卓：网络失败变成普通的失败返回，不会把异常甩给渲染层', { skip: !hasAssets || !hasDict }, async () => {
  const s = bootShim(tmpUser(), async () => { throw new TypeError('Failed to fetch'); });
  await s.lexica.putSettings({ mtOnline: true });
  const r = await s.lexica.mtTranslate('hello there');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Failed to fetch/);
  s.AndroidSql._close();
});

/* 这两条是「沙箱里全绿、装到手机上才坏」的那一类，只能靠静态检查挡住。 */
test('安卓：清单里申请了网络权限', () => {
  const m = fs.readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(m, /<uses-permission\s+android:name="android\.permission\.INTERNET"\s*\/>/);
});

test('安卓：页面 CSP 恰好放行在线翻译请求的那个域名', () => {
  const html = fs.readFileSync(path.join(ROOT, 'android/www-src/index.html'), 'utf8');
  const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)?.[1] || '';
  const connect = csp.split(';').map((x) => x.trim()).find((x) => x.startsWith('connect-src')) || '';

  // 端点写在 translate-online.js 里；改了端点却忘了改 CSP，手机上会静默拿不到译文
  const src = fs.readFileSync(path.join(ROOT, 'src/main/translate-online.js'), 'utf8');
  const host = src.match(/https:\/\/([a-z0-9.-]+)\/translate_a\//)?.[1];
  assert.ok(host, 'translate-online.js 里没找到翻译端点');
  assert.ok(connect.includes(`https://${host}`), `CSP 没放行 ${host}：${connect}`);

  // 只放行这一个：别图省事写成 https: 或 *，那等于整个页面想连哪儿就连哪儿
  const allowed = connect.replace('connect-src', '').trim().split(/\s+/);
  assert.deepEqual(allowed, [`https://${host}`], `connect-src 放得太宽：${connect}`);
});
