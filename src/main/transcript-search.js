'use strict';
/**
 * 在过往的课堂转写稿里搜关键词。
 *
 * 「老师哪节课讲过 replay buffer？」——转写稿都在各自目录的 journal.jsonl 里，
 * 一学期也就几万行，每次搜索直接扫一遍就够快，不值得为它建索引
 * （索引要跟着正在录的那节课实时更新，复杂度远高于收益）。
 *
 * 纯函数，不碰文件系统：读文件和缓存在 lecture.js 里做。
 */

/** 搜索结果上限。再多就该让用户换个更具体的词 */
const MAX_HITS = 300;

/**
 * 切关键词。英文按空格切、不区分大小写；中文没有空格，整串当一个词。
 * 「replay buffer」要求两个词都出现，不要求紧挨着——
 * 识别出来的字幕里常夹着别的词（the replay, uh, buffer）。
 */
function tokenize(query) {
  return String(query || '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * @param lectures [{ dir, title, startedAt, segments: [{ id, t0, en, zh }] }]
 * @param query    关键词
 * @returns {{ hits: Array, total: number, truncated: boolean, tokens: string[] }}
 *   hits 按课程时间倒序、课内按时间正序
 */
function searchTranscripts(lectures, query, { limit = MAX_HITS } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return { hits: [], total: 0, truncated: false, tokens };

  const phrase = tokens.join(' ');
  const ordered = [...(lectures || [])].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  const hits = [];
  let total = 0;
  for (const lec of ordered) {
    for (const seg of lec.segments || []) {
      const hay = `${seg.en || ''}\n${seg.zh || ''}`.toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) continue;
      total += 1;
      if (hits.length >= limit) continue;   // 继续数总数，但不再收
      hits.push({
        dir: lec.dir,
        title: lec.title,
        startedAt: lec.startedAt,
        id: seg.id,
        t0: seg.t0,
        en: seg.en,
        zh: seg.zh || null,
        // 整个词组原样出现的，排序时往前放（同一节课里）
        exact: hay.includes(phrase),
      });
    }
  }

  // 课与课之间保持时间倒序；课内原样出现的词组排前，其余按时间
  hits.sort((a, b) => {
    if (a.dir !== b.dir) return (b.startedAt || 0) - (a.startedAt || 0);
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    return (a.t0 || 0) - (b.t0 || 0);
  });

  return { hits, total, truncated: total > hits.length, tokens };
}

module.exports = { searchTranscripts, tokenize, MAX_HITS };
