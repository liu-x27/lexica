/**
 * 流式识别拼字幕的回归测试。事件序列取自 MCIF OiqEWDVtWk 开头 60 秒在 Nemotron（1.12 秒分块）上的
 * 真实输出：临时稿每 1.12 秒长一截、只增不改；定稿在停顿处来，常常停在虚词上、末尾没有句号。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CaptionAssembler, dangling, closeSentence } = require(path.join(ROOT, 'src', 'main', 'stream-captions.js'));

/** 按空格给一串词配上均匀的时间：从 t0 起每个词 step 秒 */
const timed = (text, t0, step = 0.3) => text.split(' ').map((word, i) => ({
  word, start: +(t0 + i * step).toFixed(2), end: +(t0 + i * step + step * 0.8).toFixed(2),
}));

/** 喂一串临时稿（每个是累计文字 + 音频位置），收集出来的字幕 */
function feedPartials(a, steps) {
  const out = [];
  for (const [text, at] of steps) out.push(...a.partial(text, at));
  return out;
}

describe('句末标点', () => {
  test('问号后面开始了下一个词，就从临时稿里把这句出掉，不等定稿', () => {
    const a = new CaptionAssembler();
    const out = feedPartials(a, [
      ['What is simultaneous speech translation', 19.07],
      ['What is simultaneous speech translation? Simultaneous', 20.22],
    ]);
    assert.deepEqual(out.map((c) => c.en), ['What is simultaneous speech translation?']);
    assert.equal(out[0].at, 20220, 'at 是出这一条时已经处理到的音频位置（CU 时延按它算）');
    assert.ok(out[0].t1 <= out[0].at, 't1 是话说完的时刻，不晚于出字幕的时刻');
    assert.equal(a.displayText, 'Simultaneous');
  });

  test('句号还在临时稿末尾（后面没有新词）时不出：后面可能还跟着引号或别的标点', () => {
    const a = new CaptionAssembler();
    assert.deepEqual(feedPartials(a, [['We propose EDAtt.', 12]]), []);
    assert.equal(a.displayText, 'We propose EDAtt.');
  });

  test('定稿来时，从临时稿出掉的词按词数从开头扣掉，剩下的带真实时间', () => {
    // 剩下那句 7 秒多，长度上限放宽，免得它再被切开（这条测的是扣词，不是切长句）
    const a = new CaptionAssembler({ maxSec: 9 });
    feedPartials(a, [['What is simultaneous speech translation? Simultaneous', 20.22]]);
    const words = timed('What is simultaneous speech translation? Simultaneous speech translation or simulst is '
      + 'the process of translating spoken language into a text in another language in real time', 17.92, 0.33);
    const out = a.final({ words, audioSec: 28.03 });
    assert.equal(out.length, 1);
    assert.match(out[0].en, /^Simultaneous speech translation or simulst/);
    assert.equal(out[0].t0, Math.round(words[5].start * 1000), 't0 用定稿里的词时间');
    assert.equal(a.displayText, '');
  });

  test('缩写的句点不算句末', () => {
    const a = new CaptionAssembler();
    assert.deepEqual(feedPartials(a, [['As shown by Wang et al. the model', 6]]), []);
    assert.deepEqual(feedPartials(a, [['As shown by Wang et al. the model', 6], ['As shown by Wang et al. the model fails. It', 7]])
      .map((c) => c.en), ['As shown by Wang et al. the model fails.']);
  });
});

describe('停顿处（定稿边界）', () => {
  test('停在虚词上的短定稿先扣着，和下一个拼成一句', () => {
    const a = new CaptionAssembler();
    assert.deepEqual(a.final({ words: timed('and what are the problems of the', 31.6, 0.2), audioSec: 33.66 }), []);
    assert.equal(a.displayText, 'and what are the problems of the');
    const out = a.final({ words: timed('current simulacity models', 33.6, 0.3), audioSec: 35.97 });
    assert.deepEqual(out.map((c) => c.en), ['and what are the problems of the current simulacity models']);
    assert.equal(out[0].t0, 31600);
  });

  test('停在虚词上、但已经攒了 holdSec 秒以上的不再扣（不然一句长话要拖到十几秒才出）', () => {
    const a = new CaptionAssembler();
    const words = timed("Hi, I'm Sarah Babi from the University of Toronto and Fondazione Bruno Kessler and I will briefly introduce the",
      1.12, 0.3);
    const out = a.final({ words, audioSec: 7.94 });
    assert.equal(out.length, 1);
    assert.match(out[0].en, /introduce the$/);
  });

  test('太短的（不到 minSec）不出，等下一个定稿', () => {
    const a = new CaptionAssembler({ minSec: 2.5 });
    assert.deepEqual(a.final({ words: timed('Specific architectures are usually trained', 35.92, 0.3), audioSec: 37.5 }), []);
    const out = a.final({ words: timed('introducing additional modules to be optimized', 38.16, 0.35), audioSec: 41.47 });
    assert.deepEqual(out.map((c) => c.en),
      ['Specific architectures are usually trained introducing additional modules to be optimized']);
  });

  test('定稿之后讲者没再开口，过 pauseSec 把扣着的出掉', () => {
    const a = new CaptionAssembler({ pauseSec: 1.5 });
    assert.deepEqual(a.final({ words: timed('and another one with', 59.36, 0.3), audioSec: 60.5 }), []);
    assert.deepEqual(a.partial('', 61.2), [], '还没静够');
    const out = a.partial('', 62.1);
    assert.deepEqual(out.map((c) => c.en), ['and another one with']);
  });

  test('定稿之后讲者在继续说（临时稿不是空的），再久也不按停顿出', () => {
    const a = new CaptionAssembler({ pauseSec: 1.5 });
    a.final({ words: timed('and what are the', 31.6, 0.3), audioSec: 33.0 });
    assert.deepEqual(a.partial('current', 34.0), []);
    assert.deepEqual(a.partial('current simulacity', 35.5), []);
    assert.equal(a.displayText, 'and what are the current simulacity');
  });
});

describe('长度上限', () => {
  test('超过 maxSec 时在最后一个停顿处切，不在句子中间硬切', () => {
    // 第一个定稿停在虚词上、3.3 秒：扣到 5 秒的话会留着，等第二个定稿来了再按长度上限切
    const a = new CaptionAssembler({ maxSec: 9, holdSec: 5 });
    a.final({ words: timed('and what are the problems of the', 10, 0.5), audioSec: 13.8 });
    const out = a.final({ words: timed('current simulacity models that we use every day in practice', 14, 0.6), audioSec: 20.5 });
    assert.equal(out[0].en, 'and what are the problems of the', '切在上一个定稿的边界上');
    assert.ok(out.every((c) => (c.t1 - c.t0) / 1000 < 12));
  });

  test('超长时不在句首的逗号处切出一条只有一个词的字幕（MCIF OiqEWDVtWk 开头）', () => {
    const a = new CaptionAssembler({ maxSec: 6 });
    const words = [{ word: 'Hi,', start: 1.13, end: 1.13 },
      ...timed("I'm Sarah Babi from the University of Toronto and Fondazione Bruno Kessler and I will briefly introduce the",
        1.64, 0.3)];
    const out = a.final({ words, audioSec: 7.94 });
    assert.ok(out.length >= 1);
    assert.notEqual(out[0].en, 'Hi,');
    assert.match(out[0].en, /^Hi, I'm Sarah/);
  });

  test('一个停顿都没有时按 maxSec 硬切，每条不超过上限', () => {
    const a = new CaptionAssembler({ maxSec: 4 });
    const words = timed(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '), 0, 0.3);
    const out = [...a.final({ words, audioSec: 12.5 }), ...a.flush(13)];
    assert.equal(out.map((c) => c.en).join(' ').split(' ').length, 40, '一个词都不能丢');
    for (const c of out.slice(0, -1)) assert.ok(c.en.split(' ').length <= 14);
  });

  test('临时稿里攒太长、又没有句末，也按 maxSec 切', () => {
    const a = new CaptionAssembler({ maxSec: 4, lagSec: 0 });
    const steps = [];
    let text = '';
    for (let i = 0; i < 30; i++) { text += `${i ? ' ' : ''}w${i}`; steps.push([`${text} `, 0.3 * (i + 1)]); }
    const out = feedPartials(a, steps);
    assert.ok(out.length >= 1);
    for (const c of out) assert.ok((c.t1 - c.t0) / 1000 <= 4.6, `${c.en} 跨了 ${(c.t1 - c.t0) / 1000}s`);
  });
});

describe('定稿和临时稿对不上', () => {
  test('定稿开头和已经出掉的临时稿不一样时只扣对得上的，不吞讲者的话', () => {
    const a = new CaptionAssembler();
    feedPartials(a, [['We use beam search. Then', 5]]);
    const out = a.final({ words: timed('We use beam searches. Then we decode the whole thing', 2, 0.3), audioSec: 6 });
    // "searches." 和出掉的 "search." 对不上：只扣前三个词，"searches." 留下（多一个词，不丢词）
    assert.match([...out.map((c) => c.en), a.displayText].join(' '), /^searches\. Then we decode/);
  });
});

test('收尾时临时稿里没定稿的也出', () => {
  const a = new CaptionAssembler();
  feedPartials(a, [['thank you for your atten', 3]]);
  const out = a.flush(3.2);
  assert.deepEqual(out.map((c) => c.en), ['thank you for your atten']);
});

test('送去翻译的补成一句话：开头大写、没有句末标点的补句号，已经有的不动', () => {
  assert.equal(closeSentence('and what are the problems of the current simulacity models'),
    'And what are the problems of the current simulacity models.');
  assert.equal(closeSentence('long and complicated training procedures, for example,'),
    'Long and complicated training procedures, for example.');
  assert.equal(closeSentence('What is simultaneous speech translation?'), 'What is simultaneous speech translation?');
  assert.equal(closeSentence('He said "it works."'), 'He said "it works."');
  assert.equal(closeSentence(''), '');
});

test('默认门限是实时字幕挑好的那一组（改了要重跑 MCIF 的离线重放，见 stream-captions.js）', () => {
  const a = new CaptionAssembler();
  assert.deepEqual({ minSec: a.minSec, maxSec: a.maxSec, holdSec: a.holdSec, pauseSec: a.pauseSec },
    { minSec: 1.5, maxSec: 6, holdSec: 2, pauseSec: 1 });
});

test('dangling', () => {
  for (const w of ['the', 'of', 'and', 'example,', 'We']) assert.ok(dangling(w), w);
  for (const w of ['models', 'translation.', 'it']) assert.ok(!dangling(w), w);
});
