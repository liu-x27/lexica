'use strict';
/**
 * 从一段文本里取出某个位置上的英文单词。
 *
 * 字幕和翻译页里「点一下查词」用它：渲染层用 caretRangeFromPoint 拿到
 * 鼠标下的文本节点和偏移，交给这里扩成一个完整的词。
 *
 * 为什么不给每个词包一个 <span>：一节课几百行、几千个词，DOM 会膨胀一大截；
 * 而且字幕行的渲染刚统一成一个函数（lectureRow），再改它的结构风险更大。
 * 取词放到点击那一刻做，渲染一个字都不用动。
 *
 * 和 vad-chunker.js 一样双导出：主进程测试用 require，渲染层挂在 window 上。
 */
(function (root) {
  /** 构成单词的字符：英文字母和词中的撇号（don't、we're） */
  const WORD_CH = /[A-Za-z'’]/;

  /**
   * @param text   整段文本
   * @param offset 光标位置（caretRangeFromPoint 给的 offset）
   * @returns {{word:string, start:number, end:number}|null}
   */
  function wordAt(text, offset) {
    const s = String(text || '');
    if (!s) return null;
    let i = Math.max(0, Math.min(Number(offset) || 0, s.length));

    /* 点在一个词的右半边时，浏览器常把光标放在词**尾之后**——
       那个位置上是空格或标点，不往回退一格就会一个词都取不到。 */
    if (!WORD_CH.test(s[i] || '') && i > 0 && WORD_CH.test(s[i - 1])) i -= 1;
    if (!WORD_CH.test(s[i] || '')) return null;

    let start = i;
    let end = i + 1;
    while (start > 0 && WORD_CH.test(s[start - 1])) start -= 1;
    while (end < s.length && WORD_CH.test(s[end])) end += 1;

    let word = s.slice(start, end);

    // 首尾的撇号是引号，不是词的一部分（'policy' → policy）
    while (/^['’]/.test(word)) { word = word.slice(1); start += 1; }
    while (/['’]$/.test(word)) { word = word.slice(0, -1); end -= 1; }

    /* 所有格去掉：agent's → agent。词库里查的是原形，
       带着 's 大概率查不到，还会被当成拼写错误去纠正。 */
    const poss = word.match(/^(.+?)['’]s$/i);
    if (poss) { word = poss[1]; end = start + word.length; }

    if (!/[A-Za-z]/.test(word)) return null;
    return { word, start, end };
  }

  /**
   * 拖选出来的一段文字，整理成可以拿去查的词组。
   * 太长的不是词组，是在选句子复制——那时不该弹查词卡片。
   *
   * @returns {string|null}
   */
  function phraseOf(selected) {
    const t = String(selected || '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s"'“”‘’([{,.;:!?-]+/, '')
      .replace(/[\s"'“”‘’)\]},.;:!?-]+$/, '')
      .trim();
    if (!t || !/[A-Za-z]/.test(t)) return null;
    // 超过 6 个词或 60 个字符，多半是想复制一句话
    if (t.length > 60 || t.split(' ').length > 6) return null;
    return t;
  }

  const api = { wordAt, phraseOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined' && root) root.LexicaWordAt = api;
})(typeof window !== 'undefined' ? window : null);
