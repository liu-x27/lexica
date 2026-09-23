'use strict';
/**
 * 建库时写进索引、查询时又要按同样规则算一遍的那几个键。
 *
 * 这几条规则原先在 scripts/build-db.mjs 和 dict-db.js 里各写一份，靠注释里一句
 * 「必须保持一致」维持。它们一旦改歪不会报错，只会静默查漏：soundex 不一样，
 * 拼写纠错就拿不到候选；spaceCJK 不一样，中文反查的全文索引就对不上查询串；
 * zhSegments 不一样，zh_seg 表里的片段就和查询时切出来的对不上。
 * 现在两边都从这里取。
 *
 * 纯函数，不依赖任何 Node 接口：安卓的 WebView 里也原样加载（dict-db 要用）。
 */

/** 汉字之间插空格，FTS 才能按字切词。建库时写 fts_zh、查询时构造查询串，用的都是它 */
function spaceCJK(s) {
  if (!s) return '';
  let out = '';
  let prevCJK = false;
  for (const ch of s) {
    const cjk = ch >= '㐀' && ch <= '鿿';
    if (cjk) {
      out += (out && !out.endsWith(' ') ? ' ' : '') + ch;
    } else {
      if (prevCJK && ch !== ' ') out += ' ';
      out += ch;
    }
    prevCJK = cjk;
  }
  return out;
}

/** 英文读音键，words.sdx 列就是它。拼写纠错按它找「读起来像」的候选 */
function soundex(word) {
  const s = word.toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  const code = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2,
                 D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
  let out = s[0];
  let last = code[s[0]] || 0;
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const c = s[i];
    const d = code[c] || 0;
    if (d && d !== last) out += d;
    if (c !== 'H' && c !== 'W') last = d;
  }
  return out.padEnd(4, '0');
}

/** 释义行里的词性缩写与域标记，切片段前要剥掉 */
const ZH_NOISE = /^(?:[a-z]{1,5}\.\s*)+|^\[[^\]]{1,6}\]\s*|^(?:un|abbr|pl)\.\s*/i;

/**
 * 把一条中文释义拆成若干「语义片段」。
 * 释义形如 "[网络] 高速铁路；高铁；高铁宝山段"，按标点切开后每段是一个独立义项。
 * 建库时每个片段写一行 zh_seg；查询时拿同样的片段算覆盖率。
 *
 * @returns {{text: string, web: boolean}[]}  web：出自 [网络] 释义行
 */
function zhSegments(translation) {
  const out = [];
  for (const line of String(translation || '').split(/\r?\n/)) {
    const isWeb = /^\[网络\]/.test(line);
    for (const raw of line.split(/[；;，,、]/)) {
      let s = raw.trim().replace(ZH_NOISE, '').replace(ZH_NOISE, '').trim();
      s = s.replace(/^\[[^\]]{1,6}\]\s*/, '').trim();
      if (s) out.push({ text: s, web: isWeb });
    }
  }
  return out;
}

module.exports = { spaceCJK, soundex, ZH_NOISE, zhSegments };
