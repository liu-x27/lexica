// 一次性探针：确认 Electron 内置 Node 是否提供 node:sqlite，且带 FTS5 / trigram。
// 用法：node_modules\.bin\electron scripts/probe-electron.js
const { app } = require('electron');

app.whenReady().then(() => {
  const out = [];
  const say = (k, v) => out.push(`${k} = ${v}`);
  say('electron', process.versions.electron);
  say('node', process.versions.node);
  say('chrome', process.versions.chrome);

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    say('sqlite', db.prepare('select sqlite_version() v').get().v);

    db.exec("CREATE VIRTUAL TABLE t USING fts5(a, tokenize='porter unicode61')");
    db.exec("INSERT INTO t VALUES('running quickly')");
    say('fts5+porter', JSON.stringify(db.prepare("select a from t where t match 'run'").all()));

    db.exec("CREATE VIRTUAL TABLE g USING fts5(a, tokenize='trigram')");
    db.exec("INSERT INTO g VALUES('receive')");
    say('fts5+trigram', JSON.stringify(db.prepare("select a from g where g match 'ceiv'").all()));

    db.function('jsfn', (a) => String(a).length);
    say('js function', db.prepare("select jsfn('abcde') n").get().n);

    // ATTACH 是构建脚本合并 ECDICT 的关键
    db.exec("ATTACH DATABASE ':memory:' AS side");
    db.exec('CREATE TABLE side.x (a)');
    say('ATTACH', 'ok');

    say('RESULT', 'node:sqlite 在 Electron 中完全可用');
  } catch (e) {
    say('RESULT', `FAIL -> ${e.message}`);
  }

  console.log('\n===PROBE===\n' + out.join('\n') + '\n===END===\n');
  app.exit(0);
});
