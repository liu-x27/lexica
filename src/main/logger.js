'use strict';
/**
 * 极简文件日志。
 *
 * 打包之后 console 输出是看不见的，出了问题没有任何线索。
 * 这里把 console 的输出与未捕获异常一并落到 userData/logs/lexica.log，
 * 超过上限就滚动一次（只保留一个 .1 备份），不引入任何依赖。
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 512 * 1024;

let stream = null;
let logPath = null;

const stamp = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

function rotateIfNeeded() {
  try {
    if (!logPath || !fs.existsSync(logPath)) return;
    if (fs.statSync(logPath).size < MAX_BYTES) return;
    stream?.end();
    fs.rmSync(`${logPath}.1`, { force: true });
    fs.renameSync(logPath, `${logPath}.1`);
    stream = fs.createWriteStream(logPath, { flags: 'a' });
  } catch { /* 日志本身出问题不能影响主流程 */ }
}

function write(level, args) {
  if (!stream) return;
  try {
    const text = args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') {
          try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
      })
      .join(' ');
    stream.write(`[${stamp()}] ${level} ${text}\n`);
    rotateIfNeeded();
  } catch { /* 忽略 */ }
}

/**
 * @param dir userData 目录
 * @returns 日志文件路径
 */
function init(dir) {
  try {
    const logDir = path.join(dir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logPath = path.join(logDir, 'lexica.log');
    rotateIfNeeded();
    stream = fs.createWriteStream(logPath, { flags: 'a' });

    for (const level of ['log', 'info', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        original(...args);
        write(level.toUpperCase().padEnd(5), args);
      };
    }

    process.on('uncaughtException', (err) => {
      write('FATAL', ['uncaughtException', err]);
      console.error('[fatal] 未捕获异常：', err);
    });
    process.on('unhandledRejection', (reason) => {
      write('FATAL', ['unhandledRejection', reason]);
    });

    write('INFO ', [`=== 启动 ${new Date().toISOString()} ===`]);
    return logPath;
  } catch {
    return null;
  }
}

module.exports = { init, path: () => logPath };
