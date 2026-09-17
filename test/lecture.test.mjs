/**
 * 课堂记录的回归测试。
 *
 * 盯的是两件容易错的事：
 *   1. 译文比原文晚到，写出去的顺序不能乱，也不能有条目被卡死在队列里；
 *   2. 崩溃后能从流水账把成品重新生成出来。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { LectureRecorder, srtTime, clockTime, safeName } = require(path.join(ROOT, 'src', 'main', 'lecture.js'));

describe('课堂记录', () => {
  let dir;
  let rec;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexica-lec-'));
    rec = new LectureRecorder(dir);
  });

  afterEach(async () => {
    if (rec.active) await rec.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const read = (info, ext) => fs.readFileSync(path.join(info.dir, `transcript.${ext}`), 'utf8');

  test('时间格式化', () => {
    assert.equal(srtTime(0), '00:00:00,000');
    assert.equal(srtTime(1234), '00:00:01,234');
    assert.equal(srtTime(3723456), '01:02:03,456');
    // 负数来自时间轴对齐的边界情况，不该产出 -1 这种非法时间码
    assert.equal(srtTime(-5), '00:00:00,000');

    assert.equal(clockTime(0), '0:00');
    assert.equal(clockTime(83000), '1:23');
    assert.equal(clockTime(3723000), '1:02:03');
  });

  test('课程名里的非法字符要过滤掉', () => {
    assert.equal(safeName('CS 5100: Foundations of AI'), 'CS 5100 Foundations of AI');
    assert.equal(safeName('a/b\\c*d?'), 'a b c d');
    assert.equal(safeName('   '), '未命名');
    assert.ok(safeName('x'.repeat(200)).length <= 60);
  });

  test('开一场记录会建目录与选中的格式文件', async () => {
    const info = await rec.start({ title: 'CS 5100', formats: ['md', 'srt'], meta: { sourceLabel: '麦克风' } });
    assert.ok(fs.existsSync(info.dir));
    assert.ok(fs.existsSync(path.join(info.dir, 'transcript.md')));
    assert.ok(fs.existsSync(path.join(info.dir, 'transcript.srt')));
    // 没选的格式不该生成
    assert.equal(fs.existsSync(path.join(info.dir, 'transcript.txt')), false);
    // 流水账与选了什么格式无关，永远写
    assert.ok(fs.existsSync(path.join(info.dir, 'journal.jsonl')));
    assert.match(read(info, 'md'), /# CS 5100/);
    assert.match(read(info, 'md'), /麦克风/);
  });

  /**
   * 这条是这个模块存在的理由：识别先到、翻译后到，
   * 如果原文一来就写，译文回来时位置已经过去了。
   */
  test('译文晚到也不能乱序', async () => {
    const info = await rec.start({ title: '顺序', formats: ['md', 'txt'] });
    const a = rec.addSegment({ t0: 0, t1: 2000, en: 'First sentence.' });
    const b = rec.addSegment({ t0: 2000, t1: 4000, en: 'Second sentence.' });
    const c = rec.addSegment({ t0: 4000, t1: 6000, en: 'Third sentence.' });

    // 第二条的译文先回来：此时什么都不该写出去
    rec.setTranslation(b, '第二句。');
    assert.equal(rec.info().written, 0, '队首没齐就不该往外写');

    // 队首齐了，前两条一起冲出去
    rec.setTranslation(a, '第一句。');
    assert.equal(rec.info().written, 2);

    rec.setTranslation(c, '第三句。');
    assert.equal(rec.info().written, 3);

    const md = read(info, 'md');
    assert.ok(md.indexOf('First sentence.') < md.indexOf('Second sentence.'));
    assert.ok(md.indexOf('Second sentence.') < md.indexOf('Third sentence.'));
    assert.ok(md.indexOf('第一句。') < md.indexOf('第二句。'));
  });

  test('翻译失败的条目要放行，不能把队列卡死', async () => {
    const info = await rec.start({ title: '失败', formats: ['txt'] });
    const a = rec.addSegment({ t0: 0, t1: 1000, en: 'Alpha.' });
    const b = rec.addSegment({ t0: 1000, t1: 2000, en: 'Beta.' });

    rec.setTranslation(a, null);        // 翻译失败
    rec.setTranslation(b, '贝塔。');
    assert.equal(rec.info().written, 2, '失败的条目也要写出去，否则后面全堵住');

    const txt = read(info, 'txt');
    assert.ok(txt.includes('Alpha.'));
    assert.ok(txt.includes('贝塔。'));
  });

  test('结束时把还没等到译文的条目按现状写掉', async () => {
    const info = await rec.start({ title: '收尾', formats: ['md', 'json'] });
    rec.addSegment({ t0: 0, t1: 1000, en: 'Only English.' });
    const out = await rec.stop();
    assert.equal(out.segments, 1, '停止时不能丢掉未完成的条目');
    assert.match(read(info, 'md'), /Only English\./);
    const j = JSON.parse(read(info, 'json'));
    assert.equal(j.segments.length, 1);
  });

  test('SRT 序号连续、时间码合法', async () => {
    const info = await rec.start({ title: '字幕', formats: ['srt'] });
    for (let i = 0; i < 3; i++) {
      const id = rec.addSegment({ t0: i * 2000, t1: i * 2000 + 1500, en: `Line ${i}.` });
      rec.setTranslation(id, `第 ${i} 行。`);
    }
    await rec.stop();
    const srt = read(info, 'srt').trim();
    const blocks = srt.split(/\n\n+/);
    assert.equal(blocks.length, 3);
    blocks.forEach((b, i) => {
      const lines = b.split('\n');
      assert.equal(lines[0], String(i + 1), '序号必须从 1 连续递增');
      assert.match(lines[1], /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/);
    });
  });

  test('零长度的段也要给出可播放的时长', async () => {
    // whisper 偶尔会给出 t0 === t1 的段，直接写进 srt 的话字幕一闪而过
    const info = await rec.start({ title: '零长', formats: ['srt'] });
    const id = rec.addSegment({ t0: 5000, t1: 5000, en: 'Blink.' });
    rec.setTranslation(id, '闪。');
    await rec.stop();
    const m = read(info, 'srt').match(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/);
    assert.ok(m);
    assert.notEqual(m[1], m[2], '起止时间不能相同');
  });

  /** 把 srt 里的时间码解析成毫秒对 */
  const srtTimes = (text) => [...text.matchAll(
    /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/g,
  )].map((m) => ({
    from: ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4],
    to: ((+m[5] * 60 + +m[6]) * 60 + +m[7]) * 1000 + +m[8],
  }));

  /**
   * 切分器为了不削掉句首会往前借一点音频（VadChunker 的 headMs），
   * 于是相邻两条字幕的时间会重叠一百多毫秒。有些播放器会因此报格式错误。
   * 实测导出的 srt 里就出现过：第 1 条到 04,700 结束，第 2 条从 04,580 开始。
   */
  test('SRT 时间轴不能重叠', async () => {
    const info = await rec.start({ title: '重叠', formats: ['srt'] });
    for (const [t0, t1] of [[0, 4700], [4580, 12300], [12180, 19600]]) {
      const id = rec.addSegment({ t0, t1, en: `seg${t0}` });
      rec.setTranslation(id, 'x');
    }
    await rec.stop();
    const times = srtTimes(read(info, 'srt'));
    assert.equal(times.length, 3);
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i].from >= times[i - 1].to,
        `第 ${i + 1} 条从 ${times[i].from}ms 开始，但第 ${i} 条到 ${times[i - 1].to}ms 才结束`);
    }
    for (const t of times) assert.ok(t.to > t.from, '终点必须晚于起点');
  });

  test('恢复出来的 SRT 时间轴同样不重叠', async () => {
    const info = await rec.start({ title: '重叠恢复', formats: [] });
    for (const [t0, t1] of [[0, 4700], [4580, 12300]]) {
      const id = rec.addSegment({ t0, t1, en: `seg${t0}` });
      rec.setTranslation(id, 'x');
    }
    rec.session = null;   // 模拟崩溃
    await rec.recover(info.dir, ['srt']);
    const times = srtTimes(read(info, 'srt'));
    assert.equal(times.length, 2);
    assert.ok(times[1].from >= times[0].to,
      `恢复出来的第二条不该早于第一条的终点（${times[1].from} < ${times[0].to}）`);
  });

  test('JSON 汇总包含全部条目与元信息', async () => {
    const info = await rec.start({
      title: 'CS 5100',
      formats: ['json'],
      meta: { sourceLabel: '系统声音', asrModel: 'base', mtModel: 'nllb' },
    });
    for (let i = 0; i < 5; i++) {
      const id = rec.addSegment({ t0: i * 1000, t1: i * 1000 + 900, en: `S${i}` });
      rec.setTranslation(id, `句${i}`);
    }
    const out = await rec.stop();
    const j = JSON.parse(read(info, 'json'));
    assert.equal(j.title, 'CS 5100');
    assert.equal(j.segments.length, 5);
    assert.equal(j.asrModel, 'base');
    assert.equal(j.mtModel, 'nllb');
    assert.equal(j.durationMs, out.durationMs);
    assert.equal(j.segments[2].en, 'S2');
  });

  test('历史列表按时间倒序，并统计条数与时长', async () => {
    for (const t of ['第一节', '第二节']) {
      await rec.start({ title: t, formats: ['md'] });
      const id = rec.addSegment({ t0: 0, t1: 3000, en: 'x' });
      rec.setTranslation(id, 'y');
      await rec.stop();
      // 目录名精确到分钟，同一分钟内建两场会重名，这里错开一点
      await new Promise((r) => setTimeout(r, 20));
    }
    const list = await rec.list();
    assert.equal(list.length, 2);
    assert.ok(list[0].at >= list[1].at, '新的应该在前');
    for (const s of list) {
      assert.equal(s.segments, 1);
      assert.equal(s.durationMs, 3000);
    }
  });

  /**
   * 崩溃恢复：一节课一个多小时，中途强退或崩了不能白听。
   * 流水账是一直在写的，成品可以从它重建。
   */
  test('能从流水账恢复出成品（模拟中途崩溃）', async () => {
    const info = await rec.start({ title: '崩溃现场', formats: ['md'] });
    for (let i = 0; i < 4; i++) {
      const id = rec.addSegment({ t0: i * 2000, t1: i * 2000 + 1800, en: `Sentence ${i}.` });
      rec.setTranslation(id, `第 ${i} 句。`);
    }
    // 模拟进程被杀：不调 stop()，直接丢掉 session
    rec.session = null;

    // json 压根没生成
    assert.equal(fs.existsSync(path.join(info.dir, 'transcript.json')), false);

    const out = await rec.recover(info.dir, ['md', 'txt', 'srt', 'json']);
    assert.equal(out.segments, 4);
    const j = JSON.parse(read(info, 'json'));
    assert.equal(j.segments.length, 4);
    assert.equal(j.recovered, true);
    assert.equal(j.segments[3].en, 'Sentence 3.');
    assert.match(read(info, 'md'), /第 0 句。/);
    // 恢复出来的 srt 序号也要连续
    assert.match(read(info, 'srt'), /^1\n00:00:00,000 --> /);
  });

  test('流水账里的半行（崩溃时写到一半）要能跳过', async () => {
    const info = await rec.start({ title: '半行', formats: [] });
    const id = rec.addSegment({ t0: 0, t1: 1000, en: 'Good line.' });
    rec.setTranslation(id, '好的。');
    rec.session = null;

    // 手工追加一条被截断的 JSON，模拟断电
    fs.appendFileSync(path.join(info.dir, 'journal.jsonl'), '{"kind":"seg","id":2,"en":"tru');

    const out = await rec.recover(info.dir, ['json']);
    assert.equal(out.segments, 1, '坏行应被跳过，好行仍要保留');
  });

  test('没有流水账时恢复要明确失败，而不是产出空文件', async () => {
    const empty = path.join(dir, '空目录');
    await fsp.mkdir(empty, { recursive: true });
    await assert.rejects(() => rec.recover(empty), /没有流水账/);
  });
});
