'use strict';
/**
 * 把整段英文切成适合逐句翻译的片段。
 *
 * 原先写在 translate.js 里，但那个文件顶上就引入了 electron 模块，
 * 于是两处用不了它：测试（只能把源码按文本切出来再 new Function）和安卓
 * （安卓的在线翻译要做整段翻译，同样得按这套规则切句）。抽出来之后两边都直接 require。
 *
 * 纯函数，不依赖任何 Node 或 Electron 接口——安卓 WebView 里也能跑。
 */

/** 整段翻译的上限。超过就截断并告知，别让人盯着进度条等几分钟 */
const MAX_CHARS = 8000;
const MAX_SENTENCES = 60;
/** 单句超过这个长度会被继续切：Marian 的输入上限是 512 token */
const MAX_CHUNK = 320;

/* 句末点号后面跟空格通常是句子边界，但这些缩写后面的点不是。
   不排除的话 "et al. 2021" 会被切成两句，翻出来的东西前后都不成话。 */
const ABBREV = new Set([
  'e.g', 'i.e', 'et al', 'al', 'cf', 'vs', 'etc', 'resp', 'approx', 'ca',
  'fig', 'figs', 'tab', 'tabs', 'eq', 'eqs', 'ref', 'refs', 'sec', 'ch', 'pp', 'no', 'vol',
  'dr', 'prof', 'mr', 'mrs', 'ms', 'st', 'jr', 'sr', 'inc', 'ltd', 'dept', 'univ',
]);

/**
 * 把整段文本切成适合逐句翻译的片段。
 *
 * 为什么必须切：模型一次只吃得下 512 token，整段塞进去会被静默截断；
 * 而且逐句翻完能立刻显示一句，不用等整段跑完。
 */
function splitSentences(text) {
  const out = [];

  // 空行/换行是硬边界：论文里换行往往就是段落或列表项
  for (const para of String(text).split(/\n+/)) {
    const line = para.trim();
    if (!line) continue;

    let buf = '';
    // 在「点号 + 空格」处试着断句，是不是真边界交给下面判断
    for (const piece of line.split(/(?<=[.!?])\s+/)) {
      buf = buf ? `${buf} ${piece}` : piece;

      const tail = buf.match(/([A-Za-z.]+)\.$/)?.[1]?.toLowerCase().replace(/\.$/, '');
      const endsWithAbbrev = tail && ABBREV.has(tail);
      // 单个大写字母后的点是人名缩写：J. Doe
      const endsWithInitial = /(?:^|\s)[A-Z]\.$/.test(buf);
      /* 只有「整段就是一个编号」才当列表标记挡住，比如 "1." + "First item"。
         不能一见数字结尾就挡——"improved to 0.91." 和 "…in Tab. 2." 都是正常句尾，
         挡掉的话后面那句会被并进来，成了一大坨。 */
      const isListMarker = /^\s*\d{1,3}\.$/.test(buf);

      if (endsWithAbbrev || endsWithInitial || isListMarker) continue;
      out.push(buf.trim());
      buf = '';
    }
    if (buf.trim()) out.push(buf.trim());
  }

  // 过长的单句继续按分号/逗号切，切不动就硬断
  const chunks = [];
  for (const s of out) {
    if (s.length <= MAX_CHUNK) { chunks.push(s); continue; }
    let rest = s;
    while (rest.length > MAX_CHUNK) {
      const window = rest.slice(0, MAX_CHUNK);
      const cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf(', '), window.lastIndexOf(' '));
      const at = cut > MAX_CHUNK * 0.5 ? cut + 1 : MAX_CHUNK;
      chunks.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) chunks.push(rest);
  }

  return chunks.filter(Boolean);
}

module.exports = { splitSentences, MAX_CHARS, MAX_SENTENCES, MAX_CHUNK, ABBREV };
