/**
 * 用户库的迁移与自定义功能测试。不依赖 dict.db，每个用例用独立临时目录。
 *
 * 重点锁定迁移：老用户的 user.db 里 user_version 是 0 但表已经建好了，
 * 迁移必须幂等且不能丢数据。这类问题一旦发生就是用户的生词本没了，
 * 而且很可能等到有人反馈才发现。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { UserDB, SCHEMA_VERSION } = require(path.join(ROOT, 'src', 'main', 'user-db.js'));

/** 换行符常量：测试里要拼多行文本 */
const NL = String.fromCharCode(10);

let dir;
let db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexica-test-'));
});

afterEach(() => {
  try { db?.close(); } catch { /* 忽略 */ }
  db = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一个「迁移机制上线之前」的库：表齐全，但 user_version 还是 0 */
function seedLegacy(file) {
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE wordbook (
      word TEXT PRIMARY KEY, added_at INTEGER NOT NULL, note TEXT,
      ease REAL NOT NULL DEFAULT 2.5, ivl INTEGER NOT NULL DEFAULT 0,
      reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL, last_at INTEGER);
    CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE history (word TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE reviews (word TEXT NOT NULL, at INTEGER NOT NULL, grade TEXT NOT NULL);
  `);
  legacy.prepare('INSERT INTO wordbook (word, added_at, due) VALUES (?,?,?)')
    .run('ephemeral', Date.now(), Date.now());
  legacy.prepare('INSERT INTO settings (k, v) VALUES (?,?)').run('theme', '"glass"');
  legacy.close();
}

describe('UserDB 迁移', () => {
  test('全新库直接建到最新版本', () => {
    db = new UserDB(dir);
    assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  });

  test('老库能就地升级且不丢数据', () => {
    seedLegacy(path.join(dir, 'user.db'));
    db = new UserDB(dir);

    assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.isSaved('ephemeral'), true, '生词本内容丢了');
    assert.equal(db.getSetting('theme'), 'glass', '设置丢了');

    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of ['custom_lists', 'custom_list_words', 'custom_entries', 'quiz_stats', 'quiz_log', 'glossary']) {
      assert.ok(tables.includes(t), `迁移后缺少表 ${t}`);
    }

    /* v4 是 ALTER TABLE 加列，不是建表。漏了的话写笔记会静默失败
       （UPDATE 找不到列直接抛，但只在用户真去写的时候才暴露）。 */
    const cols = db.db.prepare('PRAGMA table_info(wordbook)').all().map((c) => c.name);
    for (const c of ['note', 'my_def', 'noted_at']) {
      assert.ok(cols.includes(c), `wordbook 缺少列 ${c}`);
    }
    assert.equal(db.annotate('ephemeral', { note: '老库也能写' }).ok, true);
    assert.equal(db.entry('ephemeral').note, '老库也能写');
  });

  test('重复打开是幂等的', () => {
    db = new UserDB(dir);
    db.createList('t', 'run\njump');
    db.close();

    db = new UserDB(dir);
    assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.lists().length, 1, '重复迁移把数据搞没了');
  });
});

describe('自定义词表', () => {
  test('解析文本：去重、忽略注释、只取第一列', () => {
    db = new UserDB(dir);
    const r = db.createList(
      '测试',
      ['ephemeral', 'meticulous', '# 这是注释', 'ubiquitous, 无处不在的', '  serendipity  ', 'EPHEMERAL', ''].join('\n'),
    );
    assert.equal(r.ok, true);
    assert.equal(r.count, 4, '应去掉注释行、空行与重复项');
    assert.deepEqual(db.listWords(r.id), ['ephemeral', 'meticulous', 'ubiquitous', 'serendipity']);
  });

  test('支持带序号与项目符号的列表', () => {
    db = new UserDB(dir);
    const r = db.createList('t', ['1. abandon', '2) benign', '- candid', '• dubious'].join('\n'));
    assert.deepEqual(db.listWords(r.id), ['abandon', 'benign', 'candid', 'dubious']);
  });

  test('一个词都解析不出来时不建空词表', () => {
    db = new UserDB(dir);
    const r = db.createList('空的', '# 全是注释\n\n   \n');
    assert.equal(r.ok, false);
    assert.equal(db.lists().length, 0);
  });

  test('删除词表会连词一起清掉', () => {
    db = new UserDB(dir);
    const r = db.createList('t', 'run\njump');
    db.deleteList(r.id);
    assert.equal(db.lists().length, 0);
    assert.equal(db.listWords(r.id).length, 0, '词表删了但词还留着');
  });
});

describe('自定义词条', () => {
  test('新增与按小写查回', () => {
    db = new UserDB(dir);
    const r = db.putCustomEntry({ word: 'Power Bank', translation: 'n. 充电宝', phonetic: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.word, 'power bank', '词头应归一成小写');
    assert.equal(db.customEntry('POWER BANK').translation, 'n. 充电宝');
  });

  test('释义为空要拒绝', () => {
    db = new UserDB(dir);
    assert.equal(db.putCustomEntry({ word: 'x', translation: '   ' }).ok, false);
    assert.equal(db.putCustomEntry({ word: '  ', translation: 'y' }).ok, false);
    assert.equal(db.customCount(), 0);
  });

  test('同一个词再存是覆盖而不是新增', () => {
    db = new UserDB(dir);
    db.putCustomEntry({ word: 'qr code', translation: 'n. 二维码' });
    db.putCustomEntry({ word: 'QR Code', translation: 'n. 二维码（更新）' });
    assert.equal(db.customCount(), 1);
    assert.equal(db.customEntry('qr code').translation, 'n. 二维码（更新）');
  });

  test('前缀匹配用于搜索建议', () => {
    db = new UserDB(dir);
    db.putCustomEntry({ word: 'power bank', translation: 'n. 充电宝' });
    db.putCustomEntry({ word: 'powerhouse', translation: 'n. 强者' });
    db.putCustomEntry({ word: 'scan code', translation: 'v. 扫码' });
    assert.equal(db.customPrefix('power', 5).length, 2);
    assert.equal(db.customPrefix('scan', 5).length, 1);
    assert.equal(db.customPrefix('zzz', 5).length, 0);
  });
});

describe('每日目标', () => {
  test('统计当天的复习、练习与新收词', () => {
    db = new UserDB(dir);
    db.toggle('alpha');
    db.toggle('beta');
    const p = db.goalProgress({ dailyNew: 5, dailyReviews: 10, dailyQuiz: 0 });
    assert.equal(p.added.done, 2);
    assert.equal(p.added.target, 5);
    assert.equal(p.reviews.target, 10);
    assert.equal(p.quiz.target, 0, '目标为 0 表示不设目标');
  });
});

describe('术语表落库', () => {
  test('加、读、删', () => {
    db = new UserDB(dir);
    assert.equal(db.putTerm({ term: ' Policy ', zh: '策略' }).ok, true);
    const rows = db.glossary();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].term, 'policy', '主键要归一化');
    assert.equal(rows[0].surface, 'Policy', '显示用的原始写法要留着');
    assert.deepEqual(rows[0].wrong, [], '还没探测过时是空数组而不是 null');

    db.deleteTerm('POLICY');
    assert.equal(db.glossary().length, 0, '删除也要走归一化');
  });

  test('空译名不收', () => {
    db = new UserDB(dir);
    assert.equal(db.putTerm({ term: 'policy', zh: '   ' }).ok, false);
    assert.equal(db.putTerm({ term: '', zh: '策略' }).ok, false);
    assert.equal(db.glossaryCount(), 0);
  });

  /* 探测一次要跑一遍模型，很慢，结果必须能存下来 */
  test('错译写法能缓存，改了译名要作废', () => {
    db = new UserDB(dir);
    db.putTerm({ term: 'policy', zh: '策略' });
    db.setTermWrong('policy', ['政策', '政策', '']);
    assert.deepEqual(db.glossary()[0].wrong, ['政策'], '去重并去空');

    // 同样的译名重新提交：缓存要保住，否则每次编辑备注都要重探一遍
    db.putTerm({ term: 'policy', zh: '策略', note: '强化学习' });
    assert.deepEqual(db.glossary()[0].wrong, ['政策']);

    // 译名换了：之前探到的错法未必还对得上，必须清掉
    db.putTerm({ term: 'policy', zh: '方针' });
    assert.deepEqual(db.glossary()[0].wrong, [], '换译名后旧的错法要作废');
  });

  test('批量导入：解析、跳过坏行、可选覆盖', () => {
    db = new UserDB(dir);
    const r = db.importGlossary([
      '# 我的术语表',
      'policy = 策略',
      'value function: 价值函数',
      'garbage line without chinese = nope',
    ].join(NL));
    assert.equal(r.ok, true);
    assert.equal(r.count, 2);
    assert.equal(r.skipped, 1);

    // 追加模式：原有的留着
    db.importGlossary('scalar = 标量');
    assert.equal(db.glossaryCount(), 3);

    // 覆盖模式：全清了重来
    db.importGlossary('buffer = 缓冲区', { replace: true });
    assert.equal(db.glossaryCount(), 1);
  });

  test('命中次数累加', () => {
    db = new UserDB(dir);
    db.putTerm({ term: 'policy', zh: '策略' });
    db.bumpTermHits({ policy: 2, nonexistent: 5 });
    db.bumpTermHits({ Policy: 1 });
    assert.equal(db.glossary()[0].hits, 3, '大小写不同也要算同一条');
  });

  test('坏 JSON 不能让整张表读不出来', () => {
    db = new UserDB(dir);
    db.putTerm({ term: 'policy', zh: '策略' });
    db.db.exec("UPDATE glossary SET wrong = 'not json'");
    assert.deepEqual(db.glossary()[0].wrong, []);
  });
});

describe('生词本的自有释义与笔记', () => {
  test('手动添加词库里没有的词组', () => {
    db = new UserDB(dir);
    const r = db.addWord('replay buffer', {
      myDef: '经验回放缓冲：存历史转移的池子',
      note: 'RL 第三周',
    });
    assert.equal(r.ok, true);
    assert.equal(db.isSaved('replay buffer'), true);
    const e = db.entry('replay buffer');
    assert.equal(e.my_def, '经验回放缓冲：存历史转移的池子');
    assert.equal(e.note, 'RL 第三周');
    assert.ok(e.noted_at > 0, '注释时间要记下来');
  });

  test('空词不收', () => {
    db = new UserDB(dir);
    assert.equal(db.addWord('   ').ok, false);
    assert.equal(db.addWord('').ok, false);
    assert.equal(db.counts().total, 0);
  });

  /* addWord 对已存在的词必须是「保留并改注释」。
     早先只有 toggle，拿它来存编辑框会把词直接删掉。 */
  test('对已有的词是改注释，不是删掉', () => {
    db = new UserDB(dir);
    db.toggle('policy');
    const before = db.entry('policy').added_at;
    db.addWord('policy', { myDef: '策略', note: '不是政策' });
    assert.equal(db.isSaved('policy'), true, '不该被删掉');
    assert.equal(db.entry('policy').my_def, '策略');
    assert.equal(db.entry('policy').added_at, before, '加入时间不该被改写');
  });

  test('写笔记时词还不在生词本里，就先加进来', () => {
    db = new UserDB(dir);
    assert.equal(db.isSaved('serendipity'), false);
    db.annotate('serendipity', { note: '看论文遇到的' });
    assert.equal(db.isSaved('serendipity'), true);
    assert.equal(db.entry('serendipity').note, '看论文遇到的');
  });

  test('清空注释', () => {
    db = new UserDB(dir);
    db.addWord('policy', { myDef: '策略', note: 'x' });
    db.annotate('policy', { myDef: '', note: '' });
    const e = db.entry('policy');
    assert.equal(e.my_def, null, '空字符串要存成 null');
    assert.equal(e.note, null);
  });

  /* remove 必须和 toggle 分开：toggle 对不存在的词是添加，
     编辑框里连点两下「移出」会把刚删的词又加回来。 */
  test('remove 是删除，不是切换', () => {
    db = new UserDB(dir);
    db.addWord('policy');
    db.remove('policy');
    assert.equal(db.isSaved('policy'), false);
    db.remove('policy');
    assert.equal(db.isSaved('policy'), false, '再删一次不该把词加回来');
  });

  test('统计里能看出有多少条写过东西', () => {
    db = new UserDB(dir);
    db.toggle('alpha');
    db.addWord('beta', { note: '写过' });
    db.addWord('gamma', { myDef: '也写过' });
    const c = db.counts();
    assert.equal(c.total, 3);
    assert.equal(c.noted, 2, '只算写了笔记或释义的');
  });

  test('删词时注释一起走', () => {
    db = new UserDB(dir);
    db.addWord('policy', { note: 'x', myDef: 'y' });
    db.remove('policy');
    assert.equal(db.entry('policy'), null);
    db.addWord('policy');
    const e = db.entry('policy');
    assert.equal(e.note, null, '重新加回来不该带着旧笔记');
    assert.equal(e.my_def, null);
  });

  test('注释跟着到期队列一起出来（复习卡要用）', () => {
    db = new UserDB(dir);
    db.addWord('replay buffer', { myDef: '经验回放缓冲' });
    const q = db.dueQueue(10);
    const row = q.find((r) => r.word === 'replay buffer');
    assert.ok(row, '新加的词应当立刻到期');
    assert.equal(row.my_def, '经验回放缓冲');
  });
});
