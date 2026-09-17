'use strict';
/**
 * 跨程序划词取词。
 *
 * 本机装不了原生模块（无 MSVC、Python 是 32 位），所以走一个常驻的 PowerShell
 * 辅助进程：它能加载 .NET 的 UIAutomation，也能用 Add-Type 在运行时编译 C# 做
 * P/Invoke。详见 selection-helper.ps1 顶部说明。
 *
 * 这里只负责进程生命周期、协议解析与结果清洗。
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

/**
 * 选区长度上限。
 *
 * 原来是 64 字符 + 最多四个词，理由是「整段话肯定不是要查的词」。
 * 但读论文时划的往往正是一整句——那时候这个限制直接把最需要帮助的场景挡在门外，
 * 而且悄无声息（返回 null，什么都不弹）。现在长句会走翻译 + 术语对照，
 * 所以放宽到一段话的量级；再长基本是误操作（整页选中）。
 */
const MAX_LEN = 1200;

/**
 * 清洗选区文本：去掉换行与多余空白，剥掉两侧标点。
 * @returns 清洗后的查询词，不合适则返回 null
 */
function cleanSelection(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // 整页选中之类的误操作，直接不理
  if (s.length > MAX_LEN) return null;

  // 剥掉包裹标点（含中文的各种括号与引号）
  s = s.replace(/^[\s"'“”‘’(（\[【「『〈〔《<,.;:!?、，。；：！？…—-]+/, '')
       .replace(/[\s"'“”‘’)）\]】」』〉〕》>,;:、，；：…—-]+$/, '');
  /* 句末的 . ! ? 只在单个词后面剥。
     整句时它是断句依据，剥掉的话最后一句会和下一句黏成一句，翻出来前后不成话。 */
  if (!/\s/.test(s)) s = s.replace(/[.!?。！？]+$/, '');
  if (!s) return null;

  // 必须含字母或汉字，纯数字/符号不查
  if (!/[a-zA-Z一-鿿]/.test(s)) return null;

  return s;
}

class SelectionWatcher extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.ready = false;
    this.buf = '';
    this.wanted = { watch: false, copyFallback: true };
    this.lastText = '';
    this.lastAt = 0;
    this.failures = 0;
    this.disabled = false;
  }

  get helperPath() {
    return path.join(__dirname, 'selection-helper.ps1');
  }

  /** 启动辅助进程；已在运行则只同步一下开关状态 */
  start() {
    if (this.disabled) return false;
    if (this.proc) {
      this._sync();
      return true;
    }
    if (!fs.existsSync(this.helperPath)) {
      console.error('[selection] 找不到辅助脚本：', this.helperPath);
      return false;
    }

    try {
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', this.helperPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (e) {
      console.error('[selection] 启动失败：', e.message);
      this.proc = null;
      return false;
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      const t = String(d).trim();
      if (t) console.error('[selection:helper]', t.slice(0, 400));
    });

    this.proc.on('exit', (code) => {
      this.ready = false;
      this.proc = null;
      if (code !== 0 && !this.disabled) {
        this.failures++;
        // 连续起不来就别再试了，免得无限重启拖垮系统
        if (this.failures >= 3) {
          this.disabled = true;
          console.error('[selection] 辅助进程连续退出，已停用划词功能');
          this.emit('disabled');
        } else if (this.wanted.watch) {
          setTimeout(() => this.start(), 1500);
        }
      }
    });

    return true;
  }

  stop() {
    this.wanted.watch = false;
    if (!this.proc) return;
    try {
      this.proc.stdin.write('quit\n');
    } catch { /* 忽略 */ }
    const p = this.proc;
    this.proc = null;
    this.ready = false;
    setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } }, 300);
  }

  _send(line) {
    if (!this.proc?.stdin.writable) return false;
    try {
      this.proc.stdin.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  _sync() {
    this._send(`copyfallback ${this.wanted.copyFallback ? 'on' : 'off'}`);
    this._send(`watch ${this.wanted.watch ? 'on' : 'off'}`);
  }

  setWatch(on) {
    this.wanted.watch = !!on;
    if (on) {
      if (!this.start()) return false;
      if (this.ready) this._sync();
    } else if (this.proc) {
      this._send('watch off');
    }
    return true;
  }

  setCopyFallback(on) {
    this.wanted.copyFallback = !!on;
    if (this.ready) this._send(`copyfallback ${on ? 'on' : 'off'}`);
  }

  /** 主动取一次当前选区（热键触发用） */
  capture() {
    if (!this.start()) return false;
    return this._send('get');
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 不是协议消息就忽略
      }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg.event === 'ready') {
      this.ready = true;
      this.failures = 0;
      this._sync();
      return;
    }
    if (msg.event !== 'selection') return;

    const text = cleanSelection(msg.text);
    if (!text) {
      if (msg.requested) this.emit('empty');
      return;
    }

    // 同一个词短时间内重复上报就跳过（松开鼠标常会连报两次）
    const now = Date.now();
    if (!msg.requested && text === this.lastText && now - this.lastAt < 1200) return;
    this.lastText = text;
    this.lastAt = now;

    this.emit('selection', {
      text,
      via: msg.via,
      x: msg.x,
      y: msg.y,
      pid: msg.pid,
      requested: !!msg.requested,
    });
  }
}

module.exports = { SelectionWatcher, cleanSelection };
