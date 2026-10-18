/**
 * 基准数据整理（scripts/lib/mcif.mjs）的回归测试。
 *
 * 盯的是「参考和切分错位」：中文参考按行和句级切分一一对应，错一行，
 * 后面每一段的参考都换成了别人的，分数照样算得出来，只是全错——
 * 所以对不上的场次必须报出来，不能悄悄生成。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { samples, parseSegYaml, alignTalks, decodeEntities } from '../scripts/lib/mcif.mjs';

const XML = `<?xml version='1.0' encoding='utf-8'?>
<testset name="MCIF1.2">
  <task track="long" text_lang="zh">
    <sample id="0" iid="TRANS_0" task="TRANS">
      <audio_path>AAA.wav</audio_path>
      <reference>第一句。
第二句 &amp; 第三个 &lt;词&gt;。</reference>
      <metadata>
        <transcript>First sentence.
Second &amp; third &lt;word&gt;.</transcript>
      </metadata>
    </sample>
    <sample id="1" iid="QA_0" task="QA" qa_type="A" qa_origin="B">
      <audio_path>AAA.wav</audio_path>
      <reference>不是翻译</reference>
    </sample>
    <sample id="2" iid="TRANS_1" task="TRANS">
      <audio_path>BBB.wav</audio_path>
      <reference>只有一句。</reference>
      <metadata><transcript>Only one.</transcript></metadata>
    </sample>
  </task>
</testset>`;

const YAML = `- {duration: 14.381, offset: 0.672, speaker_id: '1', wav: AAA.wav}
- {duration: 1.7679999999999971, offset: 17.225, speaker_id: '1', wav: AAA.wav}
- {duration: 3.5, offset: 0.5, speaker_id: '2', wav: BBB.wav}
`;

describe('基准数据整理', () => {
  test('取出 sample 的属性和字段，解开实体', () => {
    const s = samples(XML);
    assert.equal(s.length, 3);
    assert.equal(s[0].task, 'TRANS');
    assert.equal(s[0].iid, 'TRANS_0');
    assert.equal(s[0].audio, 'AAA.wav');
    assert.equal(s[0].reference, '第一句。\n第二句 & 第三个 <词>。');
    assert.equal(s[0].transcript, 'First sentence.\nSecond & third <word>.');
    assert.equal(s[1].transcript, null);
    assert.equal(decodeEntities('&#x4e2d;&#25991;'), '中文');
  });

  test('句级切分：秒数、场次、字段', () => {
    const segs = parseSegYaml(YAML);
    assert.equal(segs.length, 3);
    assert.deepEqual(segs[0], { wav: 'AAA.wav', offset: 0.672, duration: 14.381, speaker_id: '1' });
    assert.throws(() => parseSegYaml('- {offset: 1}\n'), /缺字段/);
    assert.throws(() => parseSegYaml('wav: x\n'), /认不出/);
  });

  test('参考按行与切分一一对应，按切分的场次顺序排', () => {
    const r = alignTalks(parseSegYaml(YAML), samples(XML).filter((s) => s.task === 'TRANS'));
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.zh, ['第一句。', '第二句 & 第三个 <词>。', '只有一句。']);
    assert.deepEqual(r.en, ['First sentence.', 'Second & third <word>.', 'Only one.']);
    assert.deepEqual(r.talks.map((t) => [t.wav, t.segments]), [['AAA.wav', 2], ['BBB.wav', 1]]);
  });

  test('行数对不上的场次要报出来，不能悄悄错位', () => {
    const extra = `${YAML}- {duration: 2, offset: 5, speaker_id: '2', wav: BBB.wav}\n`;
    const r = alignTalks(parseSegYaml(extra), samples(XML).filter((s) => s.task === 'TRANS'));
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /BBB\.wav：切分 2 段，中文参考 1 行/);
  });

  test('切分里有、参考里没有的场次要报出来', () => {
    const r = alignTalks(parseSegYaml(`${YAML}- {duration: 2, offset: 0, speaker_id: '3', wav: CCC.wav}\n`),
      samples(XML).filter((s) => s.task === 'TRANS'));
    assert.match(r.problems.join('\n'), /CCC\.wav：中文参考里没有这一场/);
  });

  test('同一场的段没连在一起就停下（按顺序拼参考会错位）', () => {
    const shuffled = `- {duration: 1, offset: 0, speaker_id: '1', wav: AAA.wav}
- {duration: 1, offset: 0, speaker_id: '2', wav: BBB.wav}
- {duration: 1, offset: 2, speaker_id: '1', wav: AAA.wav}
`;
    const r = alignTalks(parseSegYaml(shuffled), samples(XML).filter((s) => s.task === 'TRANS'));
    assert.match(r.problems[0], /没有连在一起/);
    assert.equal(r.zh.length, 0);
  });
});
