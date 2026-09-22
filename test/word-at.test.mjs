/**
 * 点词取词与转写稿搜索的测试。
 *
 * 取词最容易出错的是边界：点在词的右半边时浏览器把光标放在词尾**之后**、
 * 标点和所有格、连字符。这些都是真实字幕里天天出现的。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { wordAt, phraseOf } = require(path.join(ROOT, 'src', 'main', 'word-at.js'));
const { searchTranscripts, tokenize } = require(path.join(ROOT, 'src', 'main', 'transcript-search.js'));

const S = 'The replay buffer breaks the correlation between samples.';
const at = (text, needle, k = 0) => text.indexOf(needle) + k;

describe('点词取词', () => {
  test('点在词中间', () => {
    assert.equal(wordAt(S, at(S, 'buffer', 2)).word, 'buffer');
  });

  test('点在词首', () => {
    assert.equal(wordAt(S, at(S, 'replay')).word, 'replay');
  });

  /* 点在词的右半边时，浏览器常把光标放在词尾之后（落在空格上） */
  test('光标落在词尾之后也要取到这个词', () => {
    assert.equal(wordAt(S, at(S, 'replay') + 'replay'.length).word, 'replay');
  });

  test('句末标点不算进词里', () => {
    const r = wordAt(S, at(S, 'samples', 3));
    assert.equal(r.word, 'samples');
    assert.equal(S.slice(r.start, r.end), 'samples');
  });

  test('所有格去掉', () => {
    const t = "The agent's policy is fixed.";
    assert.equal(wordAt(t, at(t, 'agent', 1)).word, 'agent');
  });

  test('缩写保留', () => {
    const t = "We don't need a model.";
    assert.equal(wordAt(t, at(t, "don't", 1)).word, "don't");
  });

  test('弯引号的所有格也认', () => {
    const t = 'The agent’s reward.';
    assert.equal(wordAt(t, at(t, 'agent', 1)).word, 'agent');
  });

  /* 连字符切开：actor-critic 词库里没有，拆开的两个词都有。
     想查整个复合词可以拖选。 */
  test('连字符两边各算一个词', () => {
    const t = 'the actor-critic family';
    assert.equal(wordAt(t, at(t, 'actor', 1)).word, 'actor');
    assert.equal(wordAt(t, at(t, 'critic', 1)).word, 'critic');
  });

  test('引号不算进词里', () => {
    const t = "the 'policy' network";
    assert.equal(wordAt(t, at(t, 'policy', 2)).word, 'policy');
  });

  test('点在空白、数字、中文上返回空', () => {
    const t = 'from 71.2 to 63.8 经验回放';
    assert.equal(wordAt(t, t.indexOf('71') + 1), null);
    assert.equal(wordAt(t, t.indexOf('经') + 1), null);
    assert.equal(wordAt('   ', 1), null);
    assert.equal(wordAt('', 0), null);
  });

  test('越界的偏移不报错', () => {
    assert.equal(wordAt('hello', 999).word, 'hello');
    assert.equal(wordAt('hello', -5).word, 'hello');
  });
});

describe('拖选词组', () => {
  test('去掉首尾标点和多余空白', () => {
    assert.equal(phraseOf('  replay   buffer, '), 'replay buffer');
    assert.equal(phraseOf('"actor-critic"'), 'actor-critic');
  });

  /* 选一整句多半是想复制，不该弹查词卡片挡着 */
  test('太长的不当词组', () => {
    assert.equal(phraseOf('The replay buffer breaks the correlation between consecutive samples'), null);
  });

  test('没有英文字母的不当词组', () => {
    assert.equal(phraseOf('71.2'), null);
    assert.equal(phraseOf('经验回放'), null);
    assert.equal(phraseOf(''), null);
  });
});

describe('转写稿搜索', () => {
  const lectures = [
    {
      dir: 'a', title: '强化学习导论', startedAt: 1000,
      segments: [
        { id: 1, t0: 0, en: 'The agent observes a state.', zh: '智能体观察状态。' },
        { id: 2, t0: 5000, en: 'We use a replay buffer here.', zh: '这里用经验回放缓冲。' },
        { id: 3, t0: 9000, en: 'The buffer stores the replay data.', zh: null },
      ],
    },
    {
      dir: 'b', title: '深度 Q 网络', startedAt: 2000,
      segments: [
        { id: 1, t0: 1200, en: 'The replay buffer breaks correlation.', zh: '经验回放缓冲打破相关性。' },
      ],
    },
  ];

  test('多个词都要出现，但不要求紧挨着', () => {
    const r = searchTranscripts(lectures, 'replay buffer');
    assert.equal(r.total, 3, '三句都含这两个词');
  });

  test('课与课之间新的在前', () => {
    const r = searchTranscripts(lectures, 'replay buffer');
    assert.equal(r.hits[0].dir, 'b');
  });

  /* 同一节课里，整个词组原样出现的更可能是用户要找的 */
  test('课内原样出现词组的排前面', () => {
    const r = searchTranscripts(lectures, 'replay buffer');
    const inA = r.hits.filter((h) => h.dir === 'a');
    assert.equal(inA[0].id, 2, '「replay buffer」原样出现的那句先出');
    assert.equal(inA[0].exact, true);
    assert.equal(inA[1].exact, false);
  });

  test('不区分大小写', () => {
    assert.equal(searchTranscripts(lectures, 'REPLAY').total, 3);
  });

  test('中文也能搜', () => {
    const r = searchTranscripts(lectures, '经验回放');
    assert.equal(r.total, 2);
  });

  test('空关键词不返回任何东西', () => {
    assert.equal(searchTranscripts(lectures, '   ').total, 0);
  });

  test('超过上限时照样数总数，并标出截断', () => {
    const many = [{
      dir: 'x', title: 't', startedAt: 1,
      segments: Array.from({ length: 50 }, (_, i) => ({ id: i, t0: i, en: `policy ${i}`, zh: null })),
    }];
    const r = searchTranscripts(many, 'policy', { limit: 10 });
    assert.equal(r.hits.length, 10);
    assert.equal(r.total, 50);
    assert.equal(r.truncated, true);
  });

  test('切词', () => {
    assert.deepEqual(tokenize('  Replay   Buffer '), ['replay', 'buffer']);
    assert.deepEqual(tokenize('经验回放'), ['经验回放']);
  });
});
