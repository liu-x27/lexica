#!/usr/bin/env node
/**
 * 假的 nemo-speech serve，给 test/nemo-asr.test.mjs 用。只实现 Lexica 用到的那一小块：
 *   GET  /ready                                  --warm 毫秒之内回 503，之后回 {"ready":true}
 *   GET  /debug/session                          最近一次 session.update 收到的内容（测试核对用）
 *   WS   /v1/audio/transcriptions/realtime       session.created → session.update → 二进制 PCM16 帧 → commit
 *
 * 「识别」规则：每收到一帧有声音的（不全是 0），临时稿就多一个词（取自 --words 的下一个）；
 * 连着 --eou 帧全是 0，就把攒着的词发成一个定稿（带词的时间戳）。和真服务一样：
 * 每一帧都回一个 delta（没有新词时 delta 是空串），定稿只在停顿处发，commit 时把剩下的也发掉。
 *
 * 参数：--port N  --warm MS  --crash（一启动就带着报错退出）  --die-after N（收到 N 帧后进程退出）
 *       --words "a b c"  --eou N
 * Node 只有 WebSocket 客户端，服务端的握手和分帧在这里手写（RFC 6455 最小子集）。
 */
import http from 'node:http';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const port = Number(arg('--port', '8800'));
const warm = Number(arg('--warm', '0'));
const dieAfter = arg('--die-after') ? Number(arg('--die-after')) : null;
const WORDS = arg('--words', 'Hello, this is a test of the streaming recognizer. It works.').split(' ');
const EOU = Number(arg('--eou', '3'));

if (argv.includes('--crash')) {
  console.error('error: failed to load model: invalid GGUF magic');
  process.exit(3);
}

const t0 = Date.now();
let lastSession = null;

const server = http.createServer((req, res) => {
  if (req.url === '/ready') {
    const ok = Date.now() - t0 >= warm;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { capabilities: ['asr'], device: 'cpu', ready: true } : { ready: false }));
    return;
  }
  if (req.url === '/debug/session') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(lastSession));
    return;
  }
  res.writeHead(404);
  res.end();
});

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  return Buffer.concat([head, payload]);
}

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/v1/audio/transcriptions/realtime')) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);

  const send = (obj) => socket.write(frame(1, Buffer.from(JSON.stringify(obj))));
  let samples = 0;
  let frames = 0;
  let next = 0;          // WORDS 里下一个要出的词
  let pending = [];      // 这一句已经出了的词 { word, start, end }
  let partial = '';
  let silent = 0;

  const audioSec = () => samples / 16000;
  const emitFinal = () => {
    if (!pending.length) return;
    send({ type: 'conversation.item.input_audio_transcription.completed',
      transcript: pending.map((w) => w.word).join(' '), words: pending, audio_processed: audioSec() });
    pending = [];
    partial = '';
  };

  const onBinary = (buf) => {
    const n = Math.floor(buf.length / 2);
    let loud = false;
    for (let i = 0; i < n; i++) if (buf.readInt16LE(i * 2) !== 0) { loud = true; break; }
    const startSec = audioSec();
    samples += n;
    frames += 1;
    if (dieAfter !== null && frames >= dieAfter) process.exit(7);
    let delta = '';
    if (loud) {
      silent = 0;
      if (next < WORDS.length) {
        const w = { word: WORDS[next++], start: startSec, end: audioSec() };
        pending.push(w);
        delta = (partial ? ' ' : '') + w.word;
        partial += delta;
      }
    } else {
      silent += 1;
    }
    send({ type: 'conversation.item.input_audio_transcription.delta', delta, audio_processed: audioSec() });
    if (!loud && silent === EOU) emitFinal();
  };

  const onText = (text) => {
    const m = JSON.parse(text);
    if (m.type === 'session.update') {
      lastSession = m.session;
      send({ type: 'session.updated', session: m.session });
    } else if (m.type === 'input_audio_buffer.commit') {
      emitFinal();
      send({ type: 'input_audio_buffer.committed' });
    }
  };

  // 收帧：客户端发的帧都带掩码；可能一次收到半帧或好几帧
  let acc = Buffer.alloc(0);
  let fragments = [];
  let fragOp = 0;
  socket.on('data', (d) => {
    acc = Buffer.concat([acc, d]);
    for (;;) {
      if (acc.length < 2) return;
      const fin = (acc[0] & 0x80) !== 0;
      const op = acc[0] & 0x0f;
      let len = acc[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (acc.length < 4) return; len = acc.readUInt16BE(2); off = 4; } else if (len === 127) {
        if (acc.length < 10) return; len = Number(acc.readBigUInt64BE(2)); off = 10;
      }
      const masked = (acc[1] & 0x80) !== 0;
      const maskOff = off;
      if (masked) off += 4;
      if (acc.length < off + len) return;
      const payload = Buffer.from(acc.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= acc[maskOff + (i % 4)];
      acc = acc.subarray(off + len);
      if (op === 8) { socket.end(frame(8, Buffer.alloc(0))); return; }
      if (op === 9) { socket.write(frame(10, payload)); continue; }
      if (op === 0 || !fin) {
        if (op !== 0) fragOp = op;
        fragments.push(payload);
        if (!fin) continue;
      }
      const whole = fragments.length ? Buffer.concat(fragments) : payload;
      const kind = fragments.length ? fragOp : op;
      fragments = [];
      if (kind === 1) onText(whole.toString('utf8'));
      else if (kind === 2) onBinary(whole);
    }
  });
  socket.on('error', () => {});
  send({ type: 'session.created', session: { input_audio_format: 'pcm16', sample_rate: 16000, model: 'fake' } });
});

server.listen(port, '127.0.0.1');
