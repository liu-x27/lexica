'use strict';
/**
 * 基准模式（`LEXICA_BENCH=<plan.json> electron .`）：把公开测试集的长音频按实时节奏
 * 喂进实时字幕的同一条流水线（VAD → 识别 → 翻译 → 流水账），跑完就退出。
 * 计划文件和打分都在 scripts/bench-stream.mjs，这里只管喂和收。
 *
 * 为什么在应用里跑而不是另写一个脚本：要量的就是这条流水线本身——排队、积压丢弃、
 * 识别和翻译抢 CPU、收尾时等译文，这些都写在 index.js 里。另抄一份就成了量抄本，
 * 改了应用、基准还在量旧的。这里只调 IPC 处理函数，和界面走的是同一批入口。
 *
 * 计划文件：
 *   { outDir, speed: 1, title?, settings: {...}, talks: [{ id, wav }] }
 * title 是每一场的课程名（会进识别提示词），默认 'ACL research talk'。
 * 每场输出 <outDir>/<id>/journal.jsonl 和 run.json（喂入开始的墙钟时刻、
 * 实际用时、段数、丢弃数）。已经有 run.json 的场次跳过，中途断了重跑能接着来。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 读 16k 单声道 16-bit PCM 的 wav。别的格式先用 ffmpeg 转好（bench-stream.mjs 会做） */
function readWav16k(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`不是 wav：${file}`);
  }
  let pos = 12;
  let fmt = null;
  let off = -1;
  let len = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const sz = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(pos + 8),
        channels: b.readUInt16LE(pos + 10),
        rate: b.readUInt32LE(pos + 12),
        bits: b.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') {
      off = pos + 8;
      len = Math.min(sz, b.length - off);
      break;
    }
    pos += 8 + sz + (sz % 2);
  }
  if (!fmt || off < 0) throw new Error(`wav 里没有 fmt/data 段：${file}`);
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1 || fmt.rate !== 16000) {
    throw new Error(`要 16k 单声道 16-bit PCM，这个是 ${fmt.rate}Hz / ${fmt.channels} 声道 / ${fmt.bits} 位：${file}`);
  }
  const n = Math.floor(len / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + i * 2) / 32768;
  return out;
}

/**
 * @param planPath 计划文件
 * @param host.call      按通道名直接调 IPC 处理函数
 * @param host.warmup    把当前翻译模型载好，返回 { ok, reason? }
 * @param host.settings  应用当前的设置（只读，用来记进 run.json）
 * @param host.userData  这次运行的临时 profile，跑完把日志拷出来
 * @returns 退出码
 */
async function runBench(planPath, { call, warmup, settings, userData }) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const outDir = path.resolve(plan.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const progress = (o) => fs.appendFileSync(path.join(outDir, 'progress.jsonl'),
    `${JSON.stringify({ at: Date.now(), ...o })}\n`, 'utf8');

  // 走 set:put：换翻译模型、开关滚动字幕这些副作用都在那里面
  if (plan.settings) {
    const r = await call('set:put', plan.settings);
    if (r?.__error) throw new Error(`设置失败：${r.__error}`);
  }
  const pick = ['asrModel', 'asrPrompt', 'mtModel', 'lectureMtModel', 'mtOnline',
    'lectureRolling', 'lectureRollingModel', 'lectureSilenceMs'];
  const used = Object.fromEntries(pick.map((k) => [k, settings[k]]));
  progress({ kind: 'start', talks: plan.talks.length, speed: plan.speed || 1, title: plan.title, settings: used });

  let failed = 0;
  for (const talk of plan.talks) {
    const dest = path.join(outDir, talk.id);
    if (fs.existsSync(path.join(dest, 'run.json'))) {
      progress({ kind: 'skip', id: talk.id });
      continue;
    }
    try {
      const pcm = readWav16k(talk.wav);
      /* 课程名会拼进识别的领域提示词（Lecture: <课程名>.），所以用一个像真课名的固定值，
         别把 OiqEWDVtWk 这种随机编号喂给 whisper；场次编号记在音频来源里。 */
      const start = await call('lec:start', {
        title: plan.title || 'ACL research talk', source: 'bench', sourceLabel: `基准 ${talk.id}`,
      });
      if (!start?.ok) throw new Error(`开始记录失败：${start?.reason || JSON.stringify(start)}`);
      /* lec:start 里的预热是发出去不等的；基准要等它真载好，不然第一场
         第一句的延迟里混着模型加载（7B 的权重要好几秒）。 */
      const warm = warmup ? await warmup() : null;
      if (warm && warm.ok === false) throw new Error(`翻译模型预热失败：${warm.reason}`);
      progress({ kind: 'talk', id: talk.id, seconds: pcm.length / 16000, mtModel: start.mtModel });

      const feed = await call('lec:selfTestFeed', { pcm: pcm.buffer, speed: plan.speed || 1 });
      if (feed?.error) throw new Error(`喂入失败：${feed.error}`);
      const stop = await call('lec:stop');
      if (!stop?.ok) throw new Error(`停止记录失败：${stop?.reason}`);

      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(stop.dir, 'journal.jsonl'), path.join(dest, 'journal.jsonl'));
      // run.json 最后写：它在就说明这一场完整跑完了
      fs.writeFileSync(path.join(dest, 'run.json'), `${JSON.stringify({
        id: talk.id,
        wav: talk.wav,
        asrModel: start.asrModel,
        mtModel: start.mtModel,
        settings: used,
        feed,
        segments: stop.segments,
        dropped: stop.dropped,
        stoppedAt: Date.now(),
      }, null, 2)}\n`, 'utf8');
      progress({ kind: 'done', id: talk.id, segments: stop.segments, dropped: stop.dropped,
        wallSeconds: feed.wallSeconds });
    } catch (e) {
      failed += 1;
      progress({ kind: 'error', id: talk.id, message: e.message });
      console.error(`[bench] ${talk.id} 失败：`, e);
      // 记录还开着的话收掉，不然下一场开不了
      try { await call('lec:stop'); } catch { /* 忽略 */ }
    }
  }

  try {
    fs.copyFileSync(path.join(userData, 'logs', 'lexica.log'), path.join(outDir, 'lexica.log'));
  } catch { /* 没有日志就算了 */ }
  progress({ kind: 'end', failed });
  return failed ? 1 : 0;
}

module.exports = { runBench, readWav16k };
