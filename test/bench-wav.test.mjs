/**
 * 基准模式读 wav 的回归测试：只认 16k 单声道 16-bit，别的格式要报错，
 * 不能当成 16k 硬喂进去——那样识别出来全是乱码，时间轴也全错，分数照样算得出来。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readWav16k } = require(path.join(ROOT, 'src', 'main', 'bench.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexica-wav-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** 拼一个 PCM wav；extra 是插在 fmt 和 data 之间的块（真实文件里常有 LIST） */
function wav(name, { rate = 16000, channels = 1, bits = 16, samples = [0, 16384, -32768, 32767], extra = null } = {}) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * channels * bits / 8, 16);
  fmt.writeUInt16LE(channels * bits / 8, 20); fmt.writeUInt16LE(bits, 22);
  const head = Buffer.alloc(8);
  head.write('data', 0); head.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, ...(extra ? [extra] : []), head, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0); riff.writeUInt32LE(body.length, 4);
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.concat([riff, body]));
  return f;
}

describe('基准模式读 wav', () => {
  test('16k 单声道 16-bit 读成 [-1, 1] 的浮点', () => {
    const pcm = readWav16k(wav('ok.wav'));
    assert.deepEqual([...pcm], [0, 0.5, -1, 32767 / 32768]);
  });

  test('fmt 和 data 之间夹着别的块也能找到 data', () => {
    const list = Buffer.alloc(14);
    list.write('LIST', 0); list.writeUInt32LE(5, 4); list.write('INFOx', 8);   // 奇数长度，后面补一个字节
    assert.equal(readWav16k(wav('list.wav', { extra: list })).length, 4);
  });

  test('采样率、声道、位深不对都要报错', () => {
    assert.throws(() => readWav16k(wav('44k.wav', { rate: 44100 })), /44100Hz/);
    assert.throws(() => readWav16k(wav('stereo.wav', { channels: 2, samples: [0, 0, 0, 0] })), /2 声道/);
    const notWav = path.join(dir, 'x.wav');
    fs.writeFileSync(notWav, 'hello world, not a wav file');
    assert.throws(() => readWav16k(notWav), /不是 wav/);
  });
});
