'use strict';
/**
 * 识别结果里的两类重复。
 *
 * 1. whisper「原地打转」：一块音频里把同一句话来回吐好几遍。公开基准（MCIF 21 场 ACL 演讲）上
 *    1248 块里有 31 块超过 4.5 词/秒，最狠的一块 9 秒吐了 171 个词，同一句话出现 14 遍；
 *    插入错误（2075）因此比替换（1231）还多。CPU 版和 CUDA 版 whisper 都会，换构建治不了。
 *    whisper.cpp 自带的防线是「最后 32 个 token 的熵低于 2.4 就换温度重解」，
 *    但一句十几个 token 的话转两遍，32 个 token 里有十几种，熵约 2.7，正好漏过去。
 *
 * 2. 接缝处的重说：讲者在虚词上停顿，VAD 在停顿里切了一刀，下一块开头把那个词又说了一遍
 *    （"…as a benchmark, a base benchmark for" / "For the problem of automatic text simplification…"）。
 *    参考稿只记一遍。切分器为了不削掉句首，下一块会往前借 120 毫秒（VadChunker 的 headMs），
 *    上一个词的尾巴就落在这里：把这 120 毫秒剪掉重新识别，29 处里 17 处开头的词变了。
 *    但剪掉也不行，残留的半个音节会被听成别的词（"To count" → "Account"，"We generate" → "Regenerate"），
 *    所以 headMs 照留，重复的词在文字上去掉。
 *
 * 难处在于真实讲话里也有重复，删了就是删掉讲者的话。参考稿（人工转写）里能找到这几种，
 * 全都只重复两遍：
 *   "…contains the watermark. The watermark method…"            （两个词，跨句）
 *   "What is simultaneous speech translation? Simultaneous speech translation, or…"
 *   "…to protect the copyright of embedding as services. To protect the copyright of
 *    embedding as services, one of…"                              （八个词，跨句）
 * 所以越是可能出现在真话里的形状，要的证据越多：
 *   - 连续重复三遍以上：真话里一次都没有（单个词放宽到四遍，"no, no, no" 是真的会说）。
 *     两三个词的短语三遍还要再看语速，"thank you, thank you, thank you" 照常保留。
 *   - 只重复两遍，两种情况才算打转：
 *     这一块的语速快到不可能（> 4 词/秒），且一遍至少 5 个词；
 *     或者一整句（至少 8 个词，前后都是句末标点）原样又来了一遍，第二遍可以是块尾的半句（至少 5 个词）。
 *     后一种是给讲得慢的人留的：一句话占满 9 秒时 whisper 照样转两遍，语速拦不住。
 *     上面那个八个词的真重复从句子中间起、不是整句，又出现在正常语速里，两条都碰不到它。
 *   - 接缝处：上一块必须停在半截上（没有句末标点，或者停在 to/for/the 这类虚词上），
 *     下一块开头又是同样的词，才去掉。"…the watermark." / "The watermark method…" 上一句是完整的，不动。
 *
 * 效果（MCIF 21 场，离线套在已有的流水账上）：CPU 版 whisper 的 WER 21.1% → 14.7%，
 * CUDA 版 20.6% → 14.9%。参考稿按句切成 2724 个窗口过一遍，按正常语速一个词都没删。
 * 发现打转后换参数把这块重识别一遍（不带提示词、贪心、升温、调高熵阈值）也试过：最好的只再降 0.02 个点，
 * 每块打转的音频却要多等 0.9~2.3 秒（中位，升温最慢 17 秒），所以没有做。
 *
 * 只看文字和这块音频的时长，不依赖 whisper 的段时间——那是估计值，而且离线复算时拿不到。
 */

/** 一块的语速超过这个（词/秒）就不可能是人在正常讲话。MCIF 上块语速中位 2.4，p90 3.2 */
const DENSE_WPS = 4.0;

/* 停在这些词上的一句话是半截的。只收虚词：it / this / that / all 这些代词和限定词
   完全可以收尾（"we evaluate it."），不放进来。 */
const DANGLING_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'from', 'with', 'by', 'into', 'onto',
  'than', 'between', 'about', 'as', 'via', 'and', 'or', 'but', 'nor', 'because', 'if', 'whether',
  'we', 'i', 'you', 'they', 'he', 'she', 'our', 'their', 'my', 'your', 'its', 'his',
  'is', 'are', 'was', 'were', 'be', 'been', 'can', 'could', 'will', 'would', 'should', 'may',
  'might', 'must', 'shall', 'do', 'does', 'did', 'have', 'has', 'had', 'very', 'so', 'such',
]);

/** 比较用的键：小写、只留字母和数字。"Today," 和 "today" 是同一个词 */
function keyOf(raw) {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 按空白切词，记下原文和键。单独的标点（"-"、"—"）挂到前一个词上，不算一个词 */
function tokenize(text) {
  const out = [];
  for (const raw of String(text || '').split(/\s+/)) {
    if (!raw) continue;
    const key = keyOf(raw);
    if (!key && out.length) {
      out[out.length - 1].raw += ` ${raw}`;
      continue;
    }
    out.push({ raw, key: key || raw });
  }
  return out;
}

const join = (toks) => toks.map((t) => t.raw).join(' ');

/**
 * 两段允许差几个词还算同一句。whisper 的重复不总是逐字的：
 * "Okay, the argument is based on…" 第二遍成了 "So, the argument is based on…"，
 * "dependency length" 第二遍成了 "dependency-length"。三个词以下必须逐字相同。
 */
function tolerance(n) {
  return n < 4 ? 0 : 1 + Math.floor((n - 4) / 8);
}

/** a[i..i+n) 与 b[p..p+m) 的编辑距离（按词），超过 cap 就提前返回 cap + 1 */
function editDistance(a, i, n, b, p, m, cap) {
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let y = 0; y <= m; y++) prev[y] = y;
  for (let x = 1; x <= n; x++) {
    cur[0] = x;
    let rowMin = cur[0];
    for (let y = 1; y <= m; y++) {
      const sub = prev[y - 1] + (a[i + x - 1].key === b[p + y - 1].key ? 0 : 1);
      cur[y] = Math.min(sub, prev[y] + 1, cur[y - 1] + 1);
      if (cur[y] < rowMin) rowMin = cur[y];
    }
    if (rowMin > cap) return cap + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/**
 * 从 p 开始找一份 unit（toks[i..i+n)）的拷贝，长度允许差 tolerance(n) 个词。
 *
 * 拷贝的首词和尾词必须与 unit 对上。不然模糊匹配会接受「错位」的一遍：
 * "…the same phenomena in blame person text gym, that is, when…" 转了三遍时，
 * 从 "the structure" 起算的一遍和后面每一遍只差开头两个词，在容差以内，
 * 结果留下的那一遍截在 "blame person"，把 "text gym" 删了。
 * 开头允许多出一个词（多算一处差异）：第二遍常常换了个语气词起头（"Okay, the…" → "So, the…"）。
 *
 * @returns {{len:number, d:number}|null} len 是这份拷贝占了几个词（含跳过的那个），d 是差了几处
 */
function copyAt(toks, i, n, p) {
  const tol = tolerance(n);
  if (!tol) {
    if (p + n > toks.length) return null;
    for (let x = 0; x < n; x++) if (toks[i + x].key !== toks[p + x].key) return null;
    return { len: n, d: 0 };
  }
  let best = null;
  for (let skip = 0; skip <= 1; skip++) {
    const q = p + skip;
    const left = toks.length - q;
    if (left < n - tol || toks[q].key !== toks[i].key) continue;

    /* 先用词袋粗筛：共有的词太少就不必算编辑距离（打转的块很长，逐位置全算太慢） */
    const bag = new Map();
    for (let x = 0; x < n; x++) bag.set(toks[i + x].key, (bag.get(toks[i + x].key) || 0) + 1);
    let shared = 0;
    for (let y = 0; y < Math.min(n, left); y++) {
      const k = toks[q + y].key;
      const c = bag.get(k);
      if (c) { shared += 1; bag.set(k, c - 1); }
    }
    if (shared < n - 2 * tol) continue;

    for (let m = Math.max(1, n - tol); m <= Math.min(n + tol, left); m++) {
      if (toks[q + m - 1].key !== toks[i + n - 1].key) continue;
      const d = skip + editDistance(toks, i, n, toks, q, m, tol - skip);
      if (d > tol) continue;
      if (!best || d < best.d || (d === best.d && skip + m === n)) best = { len: skip + m, d };
    }
  }
  return best;
}

/**
 * toks[p..end) 是不是 unit 的一个前缀（打转到 token 上限时，最后一遍常常只吐了半句）。
 * 和 copyAt 一样允许开头多出一个词。
 * @returns 差了几处；不是前缀返回 -1
 */
function prefixEdits(toks, i, n, p) {
  let best = -1;
  for (let skip = 0; skip <= 1; skip++) {
    const q = p + skip;
    const len = toks.length - q;
    if (len <= 0 || len >= n || toks[q].key !== toks[i].key) continue;
    const tol = tolerance(len);
    if (skip > tol) continue;
    const d = skip + editDistance(toks, i, len, toks, q, len, tol - skip);
    if (d <= tol && (best < 0 || d < best)) best = d;
  }
  return best;
}

/**
 * 从 i 开始、够得上打转的最长一串连续重复（够不够得上见 isLoop）。
 *
 * 一个位置上往往有好几种切法都成立（一遍 3 个词转五遍，也可以看成一遍 6 个词转两遍半），
 * 取删得最多的那种；每处差异扣半分，一遍以标点收尾的加一分。不这么算的话，少一个词的那种切法
 * 每遍都靠「开头多出一个词」对上，删得还多一个，留下的那一遍就缺了尾巴
 * （"…the third speech bubble," 成了 "…the third speech"）。
 *
 * @returns {{n:number, copies:number, end:number, tail:number}|null}
 *   n 是一遍的词数，copies 是后面跟了几遍完整拷贝，end 是这一串结束的位置（不含），
 *   tail 是块尾挂着的那半遍有几个词（没有就是 0）
 */
function runAt(toks, i, maxUnit, dense) {
  let best = null;
  // 一遍可以比剩下的一半还长：后面只跟着块尾那半遍的时候
  const limit = Math.min(maxUnit, toks.length - i - 1);
  for (let n = 1; n <= limit; n++) {
    let p = i + n;
    let copies = 0;
    let edits = 0;
    for (;;) {
      const c = copyAt(toks, i, n, p);
      if (!c) break;
      copies += 1;
      edits += c.d;
      p += c.len;
    }
    /* 一遍完整拷贝都没有时，只看块尾挂着的半遍，而且至少 5 个词——那是「转到第二遍音频就用完了」 */
    let tail = 0;
    if (p < toks.length && (copies || toks.length - p >= 5)) {
      const d = prefixEdits(toks, i, n, p);
      if (d >= 0) {
        tail = toks.length - p;
        edits += d;
        p = toks.length;
      }
    }
    if (!copies && !tail) continue;
    const closes = /[.?!,;:]["')\]]*$/.test(toks[i + n - 1].raw) ? 1 : 0;
    const run = { n, copies, end: p, tail, score: p - (i + n) - edits / 2 + closes };
    if (isLoop(toks, i, run, dense) && (!best || run.score > best.score)) best = run;
  }
  return best;
}

const endsSentence = (tok) => /[.?!]["')\]]*$/.test(tok.raw);

/** 这一串重复算不算打转，规则见文件头 */
function isLoop(toks, i, { n, copies, tail }, dense) {
  const times = copies + 1;
  if (!copies) return n >= 8 && isSentence(toks, i, n);
  if (n === 1) return times >= 4;
  if (times >= 4) return true;
  if (times === 3) return n >= 4 || dense;
  if (dense && n >= 5) return true;
  /* 两遍、语速正常：只认「整句话原样又说了一遍」，而且至少 8 个词。
     讲得慢的人一句话占满 9 秒，whisper 照样会把它转两遍（"If we do try to sanitize somehow,
     we will also risk censorship or exclusion." 两遍，3.1 词/秒），语速拦不住。
     参考稿里那个八个词的真重复是从句子中间起的（"…necessary to protect the copyright…"），不是整句。 */
  return n >= 8 && (tail ? i === 0 || endsSentence(toks[i - 1]) : isSentence(toks, i, n));
}

/** toks[i..i+n) 是不是完整的一句（或几句）：前面是块首或句末标点，自己也以句末标点收尾 */
function isSentence(toks, i, n) {
  return (i === 0 || endsSentence(toks[i - 1])) && endsSentence(toks[i + n - 1]);
}

/**
 * 从 j 起算这一串重复有多「顺」：句首起算 2 分，这一遍以句末标点收尾 1 分。
 * 逗号不算：挪到逗号收尾的那一遍，往往是把半遍拷贝多留了下来
 * （"…from their opposite, but they are better at detecting misinformation from their opposite,"）。
 */
function rotationNice(toks, j, run) {
  return (j === 0 || endsSentence(toks[j - 1]) ? 2 : 0) + (endsSentence(toks[j + run.n - 1]) ? 1 : 0);
}

/**
 * 把一块识别结果里的打转折叠掉，每串重复只留第一遍。
 * @param text    这一块合并后的英文
 * @param seconds 这一块音频的时长，用来算语速；不给就只按重复遍数判断
 * @returns {{text:string, removed:number, loops:number}} removed 是删掉的词数
 */
function collapseRepeats(text, { seconds = 0, maxUnit = 40 } = {}) {
  let toks = tokenize(text);
  const words = toks.length;
  const dense = seconds > 0 && words / seconds > DENSE_WPS;
  let loops = 0;

  /* 折叠一遍之后可能露出新的相邻重复："A B B A" 折掉一个 B 就成了 "A B A"，
     而一块打转的音频里常有这种两层的（xiSxNRoOzm 那块就是）。多扫几遍，直到不再变化。 */
  for (let pass = 0; pass < 4; pass++) {
    const out = [];
    let changed = false;
    for (let i = 0; i < toks.length;) {
      let run = runAt(toks, i, maxUnit, dense);
      if (run && i > 0 && !endsSentence(toks[i - 1])) {
        /* 一个循环从哪一遍算「第一遍」是任意的，从最左边起算常常起在半句上：
           "…sentences are fine. March trend is fine. March trend is fine." 最左边的一遍是
           "fine. March trend is"，留下它句子就断在 "is"。最左边那遍不是句首起算的，就把起点往右挪着试
           （挪过的几个词照常保留），删的范围差不多的前提下，优先句首起算的、其次以句末标点收尾的。 */
        let best = { j: i, run, nice: rotationNice(toks, i, run) };
        for (let j = i + 1; j < i + run.n; j++) {
          const r = runAt(toks, j, maxUnit, dense);
          if (!r || r.end < run.end - 2) continue;
          const nice = rotationNice(toks, j, r);
          if (nice > best.nice) best = { j, run: r, nice };
        }
        out.push(...toks.slice(i, best.j));
        i = best.j;
        run = best.run;
      }
      if (run) {
        const keep = toks.slice(i, i + run.n).map((t) => ({ ...t }));
        /* 留下的第一遍用最后一遍完整拷贝的句末标点，免得句子停在逗号上 */
        if (!run.tail) {
          const last = toks[run.end - 1].raw.match(/[.?!,;:]+$/);
          keep[keep.length - 1].raw = keep[keep.length - 1].raw.replace(/[.?!,;:]+$/, '') + (last ? last[0] : '');
        }
        out.push(...keep);
        i = run.end;
        loops += 1;
        changed = true;
      } else {
        out.push(toks[i]);
        i += 1;
      }
    }
    toks = out;
    if (!changed) break;
  }
  return { text: join(toks), removed: words - toks.length, loops };
}

/** 上一块是不是停在半截上：没有句末标点、以省略号或连字符收尾、或者最后一个词是虚词 */
function endsMidSentence(prevToks) {
  const last = prevToks[prevToks.length - 1];
  if (!last) return false;
  if (/(\.\.\.|…|-)$/.test(last.raw)) return true;
  if (!endsSentence(last)) return true;
  return DANGLING_WORDS.has(last.key);
}

/**
 * 接缝处的重说：上一块停在半截，这一块开头又把最后几个词说了一遍，就把开头这几个去掉。
 * @param prevText 上一条已经出去的字幕
 * @param text     这一块的英文（已经折叠过打转）
 * @returns {{text:string, removed:number}}
 */
function trimSeamRepeat(prevText, text, { maxWords = 3 } = {}) {
  const prev = tokenize(prevText);
  const cur = tokenize(text);
  if (!prev.length || !cur.length || !endsMidSentence(prev)) return { text, removed: 0 };
  for (let k = Math.min(maxWords, prev.length, cur.length); k >= 1; k--) {
    let same = true;
    for (let x = 0; x < k; x++) {
      if (prev[prev.length - k + x].key !== cur[x].key) { same = false; break; }
    }
    if (same) return { text: join(cur.slice(k)), removed: k };
  }
  return { text, removed: 0 };
}

module.exports = { collapseRepeats, trimSeamRepeat };
