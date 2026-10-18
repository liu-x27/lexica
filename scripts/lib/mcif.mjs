/**
 * MCIF 参考文件与句级切分的解析和对账（fetch-bench.mjs 用，test/bench-data.test.mjs 测）。
 *
 * 不引 XML/YAML 库：两种文件的结构都是固定的（MCIF 的 testset_generator.py 和
 * IWSLT 基线仓库生成的），而且 alignTalks 会逐场拿段数对账，解析错了一定会被发现，
 * 不会悄悄错位。
 */

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 取出参考 XML 里的 <sample>：
 *   <sample id="…" iid="TRANS_3" task="TRANS"><audio_path>X.wav</audio_path>
 *     <reference>…</reference><metadata><transcript>…</transcript></metadata></sample>
 */
export function samples(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<sample\b([^>]*)>([\s\S]*?)<\/sample>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)]
      .map((a) => [a[1], decodeEntities(a[2])]));
    const field = (tag) => {
      const f = m[2].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return f ? decodeEntities(f[1]) : null;
    };
    out.push({ ...attrs, audio: field('audio_path'), reference: field('reference'), transcript: field('transcript') });
  }
  return out;
}

/** 句级切分，一行一段的流式写法：- {duration: 14.381, offset: 0.672, speaker_id: '1', wav: X.wav} */
export function parseSegYaml(text) {
  const segs = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^- \{(.*)\}\s*$/);
    if (!m) throw new Error(`认不出的 YAML 行：${line}`);
    const o = {};
    for (const kv of m[1].split(/,\s*/)) {
      const at = kv.indexOf(':');
      if (at < 0) throw new Error(`认不出的 YAML 字段：${kv}`);
      o[kv.slice(0, at).trim()] = kv.slice(at + 1).trim().replace(/^'(.*)'$/, '$1');
    }
    const seg = { wav: o.wav, offset: Number(o.offset), duration: Number(o.duration), speaker_id: o.speaker_id };
    if (!seg.wav || !Number.isFinite(seg.offset) || !Number.isFinite(seg.duration)) {
      throw new Error(`切分缺字段：${line}`);
    }
    segs.push(seg);
  }
  return segs;
}

const lines = (t) => String(t || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/**
 * 按切分里的场次顺序，把每场的中文参考、英文原文按行排成与切分一一对应的两列。
 * 参考里一行就是一段（生成脚本用单个换行把句子连起来）；行数和段数对不上的场次
 * 记进 problems，调用方见到 problems 就该停下。
 *
 * @param segs   parseSegYaml 的结果
 * @param trans  中文参考的 TRANS 样本
 * @param asr    英文参考的 ASR 样本（算 WER 用，可缺）
 */
export function alignTalks(segs, trans, asr = []) {
  const byWav = (list) => new Map(list.map((s) => [s.audio, s]));
  const t = byWav(trans);
  const a = byWav(asr);
  const order = [...new Set(segs.map((s) => s.wav))];

  // 同一场的段必须连着（OmniSTEval 也这么要求），不然按顺序拼出来的参考会错位
  const seen = new Set();
  for (let i = 0; i < segs.length; i++) {
    if (i && segs[i].wav !== segs[i - 1].wav && seen.has(segs[i].wav)) {
      return { talks: [], zh: [], en: [], problems: [`${segs[i].wav}：同一场的段没有连在一起`] };
    }
    seen.add(segs[i].wav);
  }

  const talks = [];
  const zh = [];
  const en = [];
  const problems = [];
  for (const wav of order) {
    const n = segs.filter((s) => s.wav === wav).length;
    const ref = t.get(wav);
    if (!ref) { problems.push(`${wav}：中文参考里没有这一场`); continue; }
    const z = lines(ref.reference);
    const e = lines(ref.transcript);
    if (z.length !== n || e.length !== n) {
      problems.push(`${wav}：切分 ${n} 段，中文参考 ${z.length} 行，英文原文 ${e.length} 行`);
      continue;
    }
    zh.push(...z);
    en.push(...e);
    const asrRef = a.get(wav)?.reference;
    talks.push({ wav, segments: n, asrRef: asrRef ? asrRef.replace(/\s+/g, ' ').trim() : null });
  }
  return { talks, zh, en, problems };
}
