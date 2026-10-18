'use strict';
/**
 * 数字守卫：原文里的数字必须原样出现在译文里，否则这句译文不能用。
 *
 * 为什么要有它：opus-mt 把 `degrades accuracy from 71.2 to 63.8` 译成
 * 「将直线概率从 71.2 降低至 638」——小数点被吃掉，句子照样通顺，不对照原文
 * 根本发现不了。大模型一样会出这种错（漏掉、换算错、改写），而数字恰好是
 * 课堂和论文里最要紧、也最容易核对的信息。所以译文里少了原文的哪个数，
 * 就退回兜底模型重译（见 translate.js）。
 *
 * 判据是「原样」：63.8 必须还是 63.8，不能是 638、63.80 或六十三点八。
 * 比的是整个数字串，不是子串——不然 63.8 会在 163.8 里「找到」，
 * 7 会在 70 里「找到」。
 *
 * 只有下面几种写法上的等价算对上，每一种都有测试：
 *   - 千分位：1,000 ≡ 1000（中文译文常把逗号去掉）
 *   - 全角数字：６３．８ ≡ 63.8
 *   - 两位以内的整数写成汉字：3 ≡ 三、2 ≡ 两、25 ≡ 二十五（「3 层」译成「三层」是正常中文）
 *   - 序数：1st ≡ 第一 ≡ 第1
 *   - 年代：1990s ≡ 1990 ≡ 90年代
 *   - 量级换成万/亿：7 billion ≡ 70亿 ≡ 7000000000、1.5 million ≡ 150万、10,000 ≡ 1万
 * 反过来，译文里数字后面紧跟百/千/万/亿的，按换算后的值核对：`7 billion`
 * 译成「7亿」差了十倍，算没对上。
 * 别的一律算没对上。宁可多退回兜底几句，也不能放过一句改错的数字。
 */

/** 数字串：带千分位的放前面，否则 1,000 会被拆成 1 和 000 */
const NUM_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** 原文里跟在数字后面、中文会换算成万/亿的量级 */
const SCALE_WORDS = {
  thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12,
  k: 1e3, m: 1e6, b: 1e9,
};
const SCALE_RE = /^\s*(thousand|million|billion|trillion)s?\b|^(k|m|b)\b/i;

const CN_DIGITS = '零一二三四五六七八九';
/** 紧挨着的话会连成另一个数的字：三 后面跟 十 就是三十，不是三 */
const CN_NUM_CHARS = new Set([...'零一二三四五六七八九十百千万亿两']);

/** 0–99 的汉字写法。2 另有「两」 */
function chineseNumerals(n) {
  if (!Number.isInteger(n) || n < 0 || n > 99) return [];
  const out = [];
  if (n < 10) out.push(CN_DIGITS[n]);
  else {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    const tail = ones ? CN_DIGITS[ones] : '';
    out.push(`${tens === 1 ? '' : CN_DIGITS[tens]}十${tail}`);
    if (tens === 1) out.push(`一十${tail}`);
  }
  if (n === 2) out.push('两');
  return out;
}

/**
 * 全角数字、全角小数点、不换行空格之类的千分位，统一成一种写法。
 * 普通空格和中文逗号不当千分位：「表 1 100 个样本」「100，200」都是两个数。
 */
function normalizeDigits(text) {
  return String(text || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(\d)．(?=\d)/g, '$1.')
    .replace(/(\d)[   ](?=\d{3}(?!\d))/g, '$1');
}

/** 去掉多余的零，并挡住浮点误差：150 不写成 150.00000000001 */
const fmt = (x) => String(Math.round(x * 1e6) / 1e6);

/**
 * 找出一段英文里的数字，连同判定它「对上了」时可以接受的写法。
 * @returns {Array<{raw:string, value:string, accept:string[]}>}
 */
function numbersIn(text) {
  const src = normalizeDigits(text);
  const out = [];
  for (const m of src.matchAll(NUM_RE)) {
    const raw = m[0];
    const value = raw.replace(/,/g, '');
    const after = src.slice(m.index + raw.length);
    const n = Number(value);
    const accept = [value];

    // 序数：1st / 22nd / 3rd / 4th
    if (/^(st|nd|rd|th)\b/i.test(after) && Number.isInteger(n)) {
      for (const c of chineseNumerals(n)) accept.push(`第${c}`);
    }
    // 年代：1990s → 90年代；只认四位数年份后面直接跟 s
    if (/^s\b/.test(after) && /^\d{4}$/.test(value)) accept.push(`${value.slice(2)}年代`);

    // 量级：7 billion → 70亿 / 7000000000；10,000 → 1万；3 thousand → 3千 / 3000
    const sw = after.match(SCALE_RE);
    const scale = sw ? SCALE_WORDS[(sw[1] || sw[2]).toLowerCase()] : 1;
    const total = n * scale;
    if (scale !== 1) accept.push(fmt(total));
    if (total >= 1e3 && total < 1e4) {
      const v = total / 1e3;
      accept.push(`${fmt(v)}千`);
      if (Number.isInteger(v)) for (const c of chineseNumerals(v)) accept.push(`${c}千`);
    }
    if (total >= 1e4) {
      for (const [unit, size] of [['万亿', 1e12], ['亿', 1e8], ['万', 1e4]]) {
        if (total < size) continue;
        const v = total / size;
        accept.push(`${fmt(v)}${unit}`);
        if (Number.isInteger(v)) for (const c of chineseNumerals(v)) accept.push(`${c}${unit}`);
      }
    }

    // 两位以内的整数可以写成汉字（带量级词的不算：7 billion 不能对上「七」）
    if (scale === 1 && /^\d{1,2}$/.test(value)) accept.push(...chineseNumerals(n));

    out.push({ raw, value, accept: [...new Set(accept)] });
  }
  return out;
}

/**
 * 译文里出现的数字串集合（千分位去掉之后的写法）。
 *
 * 后面紧跟百/千/万/亿的不收：「7亿」是七亿不是 7，`7 billion` 译成「7亿」
 * 差了十倍，这正是要拦的那种错。带单位的写法另由 hasForm 按换算后的值核对。
 */
function numberSet(text) {
  const s = new Set();
  for (const m of text.matchAll(NUM_RE)) {
    const next = text.slice(m.index + m[0].length).match(/^\s*(\S)/)?.[1];
    if (next && '百千万亿'.includes(next)) continue;
    s.add(m[0].replace(/,/g, ''));
  }
  return s;
}

const isNumCh = (c) => !!c && (/\d/.test(c) || CN_NUM_CHARS.has(c));

/**
 * 带汉字或单位的写法（三、第一、70亿、90年代）在译文里有没有独立出现：
 * 前后紧挨着的不能是别的数字，否则「十三」里会找到「三」，「170亿」里会找到「70亿」。
 */
function hasForm(text, form) {
  for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) {
    const before = text[i - 1];
    const after = text[i + form.length];
    if (isNumCh(form[0]) && (isNumCh(before) || before === '.')) continue;
    if (isNumCh(form[form.length - 1])
      && (isNumCh(after) || (after === '.' && /\d/.test(text[i + form.length + 1] || '')))) continue;
    return true;
  }
  return false;
}

/**
 * 原文的每个数字是不是都在译文里。
 * @returns {{ ok: boolean, missing: string[] }} missing 是原文里没对上的写法
 */
function checkNumbers(src, out) {
  const want = numbersIn(src);
  if (!want.length) return { ok: true, missing: [] };
  const zh = normalizeDigits(out);
  const have = numberSet(zh);
  // 「70 亿」「第 1」这种中间夹空格的写法也要认；数字串本身照上面那份带空格的比
  const compact = zh.replace(/\s+/g, '');
  const missing = [];
  for (const w of want) {
    const hit = w.accept.some((a) => (/^\d+(?:\.\d+)?$/.test(a) ? have.has(a) : hasForm(compact, a)));
    if (!hit) missing.push(w.raw);
  }
  return { ok: missing.length === 0, missing };
}

module.exports = { checkNumbers, numbersIn, normalizeDigits, chineseNumerals };
