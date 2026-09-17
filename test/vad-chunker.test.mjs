/**
 * 静音切分的回归测试。
 *
 * 这个模块决定实时字幕的句子完整度。实测固定时长切分会把句子剖开：
 *   "...receives a scalar reward."  /  "signal at each time step."
 * 所以这里盯的是「该在停顿处切」「不该在句中切」「一直讲话时要有上限」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { VadChunker } = require(path.join(ROOT, 'src', 'main', 'vad-chunker.js'));

const RATE = 16000;

/** 造一段「语音」：用带噪声的正弦，能量明显高于底噪 */
function speech(ms, amp = 0.25) {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * (Math.sin((2 * Math.PI * 180 * i) / RATE) + 0.3 * (Math.random() - 0.5));
  }
  return out;
}

/** 造一段静音：留一点底噪，真实录音不会是绝对零 */
function silence(ms, floor = 0.0008) {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = floor * (Math.random() - 0.5);
  return out;
}

function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** 按 100ms 一片喂进去，模拟实时；返回切出来的段 */
function feed(vad, audio, sliceMs = 100) {
  const step = Math.round((sliceMs / 1000) * RATE);
  const out = [];
  for (let i = 0; i < audio.length; i += step) {
    out.push(...vad.push(audio.subarray(i, Math.min(i + step, audio.length))));
  }
  return out;
}

describe('静音切分', () => {
  test('在句间停顿处切开', () => {
    const vad = new VadChunker({ rate: RATE });
    // 三句，每句 3 秒，句间停顿 700ms（> silenceMs 420）
    const audio = concat(
      speech(3000), silence(700),
      speech(3000), silence(700),
      speech(3000), silence(700),
    );
    const chunks = feed(vad, audio);
    assert.equal(chunks.length, 3, `应切成三段，实际 ${chunks.length}`);
    assert.ok(chunks.every((c) => c.reason === 'silence'));
    // 时间轴要连续递增，不能重叠或跳跃
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].startMs >= chunks[i - 1].startMs, '起点必须单调');
    }
  });

  test('短于 minMs 的停顿不切（句中的短停顿）', () => {
    const vad = new VadChunker({ rate: RATE, minMs: 2500 });
    // 1 秒语音 + 600ms 停顿 + 1 秒语音：总时长没到 minMs，不该切
    const chunks = feed(vad, concat(speech(1000), silence(600), speech(1000)));
    assert.equal(chunks.length, 0, '攒够 minMs 之前不该切');
  });

  test('一直讲话时按上限强切', () => {
    const vad = new VadChunker({ rate: RATE, maxMs: 4000 });
    // 10 秒不带停顿的连续语音
    const chunks = feed(vad, speech(10000));
    assert.ok(chunks.length >= 2, `应至少强切两段，实际 ${chunks.length}`);
    assert.ok(chunks.some((c) => c.reason === 'maxlen'));
    // 强切的段不能超过上限，否则会撞上 whisper 的 audio-ctx 覆盖范围
    for (const c of chunks) {
      const dur = c.pcm.length / RATE;
      assert.ok(dur <= 4.05, `强切段 ${dur.toFixed(2)}s 超过了上限`);
    }
  });

  test('全程静音不产出任何段', () => {
    const vad = new VadChunker({ rate: RATE });
    const chunks = feed(vad, silence(20000));
    assert.equal(chunks.length, 0, '没有人说话就不该送去识别');
    assert.equal(vad.flush(), null);
  });

  test('flush 取出尾巴，但丢掉太短或纯静音的残余', () => {
    const vad = new VadChunker({ rate: RATE });
    feed(vad, concat(speech(3000), silence(700)));   // 这段会被切走
    feed(vad, speech(1500));                          // 尾巴，没到停顿就结束了
    const tail = vad.flush();
    assert.ok(tail, 'flush 应该把尾巴吐出来');
    assert.equal(tail.reason, 'flush');

    const vad2 = new VadChunker({ rate: RATE });
    feed(vad2, silence(3000));
    assert.equal(vad2.flush(), null, '纯静音的尾巴要丢掉');

    const vad3 = new VadChunker({ rate: RATE });
    feed(vad3, speech(200));
    assert.equal(vad3.flush({ minMs: 500 }), null, '太短的尾巴要丢掉');
  });

  test('切分点留头，避免削掉句首', () => {
    const vad = new VadChunker({ rate: RATE, headMs: 120 });
    const chunks = feed(vad, concat(speech(3000), silence(700), speech(3000), silence(700)));
    assert.equal(chunks.length, 2);
    // 第二段的起点应该比第一段的终点早一点（借了 headMs 的音频）
    assert.ok(chunks[1].startMs < chunks[0].endMs,
      `第二段应往前借一点：seg0 end=${chunks[0].endMs} seg1 start=${chunks[1].startMs}`);
    assert.ok(chunks[0].endMs - chunks[1].startMs <= 200);
  });

  test('门限自适应：底噪大的环境也能认出语音', () => {
    const vad = new VadChunker({ rate: RATE });
    // 先喂 2 秒较大的底噪让门限抬上去，再说话
    const noisy = 0.01;
    const chunks = feed(vad, concat(
      silence(2000, noisy * 4),
      speech(3000, 0.3), silence(800, noisy * 4),
    ));
    assert.equal(chunks.length, 1, `嘈杂环境下也该切出一段，实际 ${chunks.length}`);
    assert.ok(vad.threshold > 0.006, '门限应随底噪抬高');
  });

  test('输入不是帧整数倍时，语音部分不能丢', () => {
    const vad = new VadChunker({ rate: RATE });
    // 故意用 137 个采样点这种零碎长度喂，检验帧对齐的余数处理
    const audio = concat(speech(3000), silence(800));
    const chunks = [];
    for (let i = 0; i < audio.length; i += 137) {
      chunks.push(...vad.push(audio.subarray(i, Math.min(i + 137, audio.length))));
    }
    const tail = vad.flush();
    const got = chunks.reduce((s, c) => s + c.pcm.length, 0) + (tail ? tail.pcm.length : 0);
    /* 只要求语音那 3 秒都在。尾部静音被丢掉是对的——
       送静音去识别只会让 whisper 臆造字幕。 */
    const speechSamples = 3 * RATE;
    assert.ok(got >= speechSamples, `语音不该丢：应至少 ${speechSamples}，实际 ${got}`);
  });

  test('reset 后可以重新开始', () => {
    const vad = new VadChunker({ rate: RATE });
    feed(vad, concat(speech(3000), silence(700)));
    vad.reset();
    assert.equal(vad.bufferedMs, 0);
    const chunks = feed(vad, concat(speech(3000), silence(700)));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].startMs, 0, 'reset 后时间轴要从零开始');
  });
});
