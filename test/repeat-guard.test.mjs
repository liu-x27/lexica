/**
 * 识别结果去重的回归测试。
 *
 * 一半是「该删的要删掉」：whisper 原地打转、接缝处的重说，例句都是公开基准（MCIF）上
 * whisper 的原样输出；
 * 一半是「真话里的重复不能删」：强调时说两遍、跨句的顶真、参考稿（人工转写）里真实出现过的重复。
 * 删错一次就是把讲者的话从字幕和转写稿里抹掉，比多出几个词更糟。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { collapseRepeats, trimSeamRepeat } = require(path.join(ROOT, 'src', 'main', 'repeat-guard.js'));

/** seconds 是这一块音频的时长，决定语速那一档 */
const collapsed = (text, seconds) => collapseRepeats(text, { seconds }).text;
const kept = (text, seconds) => assert.equal(collapsed(text, seconds), text, `不该动：${text}`);

describe('打转：该删的', () => {
  test('一句话转了十几遍，留第一遍（ccpXHNfaoy 323.5 s，9 秒 171 个词）', () => {
    const loop = 'We developed the constraint language planning ability of learning language planning problem. ';
    const text = `We established the constraint language planning problem. ${loop.repeat(13)}We developed the constraint language planning ability of learning`;
    const r = collapseRepeats(text, { seconds: 9 });
    assert.equal(r.text, 'We established the constraint language planning problem. '
      + 'We developed the constraint language planning ability of learning language planning problem.');
    assert.ok(r.removed > 140);
  });

  test('短语转五遍，句末标点取最后一遍的', () => {
    assert.equal(collapsed('For additive overfitting, for additive overfitting, for additive overfitting, '
      + 'for additive overfitting, for additive overfitting.', 3.3), 'For additive overfitting.');
  });

  test('四个词以上转三遍，不看语速', () => {
    assert.equal(collapsed('So we have a plan, so we have a plan, so we have a plan. Then we start.', 20),
      'So we have a plan. Then we start.');
  });

  test('第二遍不逐字相同也认：换了语气词、连字符写法不同', () => {
    const a = 'Okay, the argument is based on the principle of dependency length minimization that I\'ll explain on the basis of these examples.';
    const b = 'So, the argument is based on the principle of dependency-length minimization that I\'ll explain on the basis of these examples.';
    assert.equal(collapsed(`${a} ${b}`, 9), a);
  });

  test('讲得慢的人一句话占满 9 秒，整句被转了两遍（3.1 词/秒，语速拦不住）', () => {
    const s = 'If we do try to sanitize somehow, we will also risk censorship or exclusion.';
    assert.equal(collapsed(`${s} ${s}`, 9), s);
  });

  test('音频用完时第二遍只吐了半句，也删', () => {
    const s = 'Hello, everyone. I\'m Akshata, and today, my co-author, Martin, and I are presenting our work, "The Keep Mustache."';
    assert.equal(collapsed(`${s} Hello, everyone. I'm Akshata, and today, my co-author, Martin, and I are presenting our`, 9), s);
  });

  test('折掉一层露出的下一层也折（A B B A → A B）', () => {
    const a = 'Further mentioning that I don\'t think I could keep my job without them, justifies the second occurrence and they have a correct occurrence.';
    assert.equal(collapsed(`${a} They have a correct occurrence. ${a}`, 9), a);
  });

  test('留下的那一遍从句首起算，不断在半句上', () => {
    assert.equal(collapsed('So both these sentences are fine. March trend is fine. March trend is fine. March trend is fine.', 9),
      'So both these sentences are fine. March trend is fine.');
  });

  test('语速快到不可能时，五个词以上的两遍也算', () => {
    // 9 秒 45 个词，5 词/秒
    const s = 'If the language model has access to the exact same background knowledge as the annotators, then the accuracy is really hard.';
    assert.equal(collapsed(`Or summarized below. ${s} ${s}`, 9), `Or summarized below. ${s}`);
  });
});

describe('打转：真话里的重复别删', () => {
  test('强调时说两遍', () => {
    kept('It is very, very important to normalize the inputs first.', 4);
    kept('This is really, really hard.', 2);
    kept('We need more data, more data.', 2.5);
  });

  test('单个词三遍', () => {
    kept('No, no, no, that is not what we mean.', 3);
  });

  test('短语三遍、语速正常', () => {
    kept('Thank you, thank you, thank you.', 3);
  });

  test('跨句的顶真（参考稿原文）', () => {
    kept('So we need to detect whether another service contains the watermark. The watermark method needs to meet the following properties.', 6);
    kept('What is simultaneous speech translation? Simultaneous speech translation, or SimulST, is the process of translating spoken language.', 7);
    kept('Let\'s first define text simplification. Text simplification is a process of adapting a text.', 5);
  });

  test('参考稿里八个词的真重复，正常语速下留着', () => {
    kept('Therefore, it\'s necessary to protect the copyright of embedding as services. '
      + 'To protect the copyright of embedding as services, one of the solutions is to embed a watermark.', 10);
  });

  test('排比：同一个开头接不同的内容', () => {
    kept('Likert ratings on the turn level, Likert ratings on the dialog level, and dialog level pairwise comparisons.', 7.4);
    kept('The drop is caused by temporal drift, and kind of surprisingly, it is not caused by adaptive overfitting.', 9);
  });

  test('整句两遍但不到 8 个词，不删', () => {
    kept('Thank you very much for listening. Thank you very much for listening.', 4);
  });

  test('不给时长就不按语速判断', () => {
    const s = 'If the language model has access to the same knowledge as annotators';
    assert.equal(collapsed(`${s}, ${s}`, 0), `${s}, ${s}`);
  });

  test('空串和单个词', () => {
    assert.equal(collapsed('', 3), '');
    assert.equal(collapsed('Okay.', 1), 'Okay.');
  });
});

describe('接缝处的重说', () => {
  const trimmed = (prev, text) => trimSeamRepeat(prev, text).text;

  test('上一块停在虚词上，这一块开头又说了一遍', () => {
    assert.equal(trimmed('We propose those results as a benchmark, a base benchmark for',
      'For the problem of automatic text simplification in the future.'),
    'the problem of automatic text simplification in the future.');
    assert.equal(trimmed('We assume the provider applied it to the dataset to...', 'To count word frequency.'),
      'count word frequency.');
  });

  test('句末标点打在虚词后面也算半截（"to." 收不了尾）', () => {
    assert.equal(trimmed('We can use this model to.', 'To translate German queries.'), 'translate German queries.');
  });

  test('结巴的连字符', () => {
    assert.equal(trimmed('So, thank you for- for- for-', 'For this presentation.'), 'this presentation.');
  });

  test('重说的不止一个词', () => {
    assert.equal(trimmed('Due to the absence of any prior such dataset, we are facing the', 'Facing the problem of absolute rarity.'),
      'problem of absolute rarity.');
  });

  test('上一句是完整的，开头重复的是顶真，不动', () => {
    const t = 'The watermark method needs to meet the following properties.';
    assert.equal(trimmed('…and detect whether another service contains the watermark.', t), t);
    const u = 'Embedding marker contains two main steps.';
    assert.equal(trimmed('Then let me introduce the details of our embedding marker.', u), u);
  });

  test('代词收尾是完整的句子', () => {
    const t = 'It works on every language pair.';
    assert.equal(trimmed('So we evaluate it.', t), t);
  });

  test('开头不一样就不动', () => {
    const t = 'The number of fine-tuning examples matters.';
    assert.equal(trimmed('And last but not least, we all know that', t), t);
  });

  test('没有上一句', () => {
    assert.equal(trimmed('', 'For example, this one.'), 'For example, this one.');
  });
});
