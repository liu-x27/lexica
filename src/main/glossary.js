'use strict';
/**
 * 术语表：用用户自己维护的译名去修正机器翻译的输出。
 *
 * 为什么需要它：本地翻译模型在专业术语上稳定地错，而且每次错得一样——
 *   policy            → 政策      （应为 策略）
 *   value function    → 价值功能  （应为 价值函数）
 *   replay buffer     → 重弹缓冲  （应为 经验回放缓冲）
 * 这类错误对读论文、上课是致命的，但它是**可预测**的，所以能修。
 *
 * 为什么不用词库自动修：实测过，不行。词库对课堂词汇命中 8/15，
 * 而错的那些会主动引入错义（value function → 明度函数 是光学义，
 * scalar → 数量/纯量 不是标量），且 replay buffer、ablation study 压根没收录；
 * 从整句里抽取时 replay buffer 抽不到、只抽到 replay → 重新比赛。
 * 自动替换会让译文更差。所以只认用户自己加的条目。
 *
 * ── 替换的门槛（这是这个模块的核心设计）──
 *
 * 只在**两个条件同时成立**时才动译文：
 *   1. 英文原文里确实出现了这个术语；
 *   2. 译文里确实出现了这个术语的某个「错译写法」。
 *
 * 缺一不可。只看条件 2 的话，「政策」这个词在任何谈政策的句子里都会被改成
 * 「策略」；只看条件 1 的话，我们并不知道该把译文里的哪几个字换掉。
 *
 * 「错译写法」从哪来：把术语单独喂给模型翻一次，拿到它的固定错法并缓存下来
 * （模型是确定性的，同一个词每次都译成同样的东西）。用户也可以手填补充，
 * 因为同一个词在不同上下文里模型可能给出不同的错法。
 */

/** 术语表条目上限。再多就该怀疑是不是误把词表粘进来了 */
const MAX_TERMS = 2000;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * 解析用户粘贴的术语表文本。
 *
 * 接受这些写法，因为人不会按格式来：
 *   policy = 策略
 *   policy    策略
 *   policy: 策略
 *   policy,策略
 *   policy = 策略   # 备注
 * `#` 或 `//` 开头的整行跳过。
 *
 * @returns {{ terms: Array<{surface,term,zh}>, skipped: number }}
 */
function parseGlossary(text) {
  const terms = [];
  const seen = new Set();
  let skipped = 0;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    /* 先按显式分隔符切；都没有才退到「两个以上空格」或「制表符」。
       不能用单个空格切——多词术语本身就带空格（replay buffer）。 */
    let left = null;
    let right = null;
    const m = line.match(/^(.+?)\s*(?:=|:|：|\||,|，|\t)\s*(.+)$/);
    if (m) {
      [, left, right] = m;
    } else {
      const m2 = line.match(/^(.+?)\s{2,}(.+)$/);
      if (m2) [, left, right] = m2;
    }

    if (!left || !right) { skipped += 1; continue; }

    // 行尾备注去掉
    right = right.replace(/\s*(?:#|\/\/).*$/, '').trim();
    const surface = left.trim();
    const term = norm(surface);

    // 英文侧必须是英文；中文侧必须含中文，否则多半是把别的东西粘进来了
    if (!term || !/[a-z]/.test(term) || !/^[a-z0-9\s'’.-]+$/.test(term)) { skipped += 1; continue; }
    if (!right || !/[一-鿿]/.test(right)) { skipped += 1; continue; }
    if (term.length > 64 || right.length > 80) { skipped += 1; continue; }
    if (seen.has(term)) { skipped += 1; continue; }

    seen.add(term);
    terms.push({ surface, term, zh: right });
    if (terms.length >= MAX_TERMS) break;
  }

  return { terms, skipped };
}

/**
 * 术语 → 匹配用正则。
 *
 * 缓存是必要的：一节课几百句，每句都要拿整张表（最多 2000 条）来匹配，
 * 不缓存就是每句现场构造两千个 RegExp。词表内容变了也不用清——
 * key 就是术语本身，同一个术语的正则永远一样。
 */
const RE_CACHE = new Map();
function termRe(term) {
  let re = RE_CACHE.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 术语后面跟标点或复数的情况也要认
    re = new RegExp(`(^|\\s)${esc}(s|es|'s)?([\\s.,;:!?)\\]]|$)`);
    RE_CACHE.set(term, re);
  }
  return re;
}

/**
 * 找出这段英文里命中的术语，按长的优先（replay buffer 要盖过 buffer）。
 *
 * @param text  英文原文
 * @param rows  术语表条目 [{ term, surface, zh, wrong: string[] }]
 */
function matchTerms(text, rows) {
  if (!text || !rows?.length) return [];
  const hay = ` ${norm(text)} `;
  const hits = [];
  for (const r of rows) {
    /* 用空格包边做整词匹配：不加的话 `policy` 会命中 `policymaker`，
       `ai` 会命中句子里几乎每个含这两个字母的词。 */
    if (hay.includes(` ${r.term} `) || termRe(r.term).test(hay)) hits.push(r);
  }
  // 长术语优先：替换时先处理它，避免被短术语切开
  return hits.sort((a, b) => b.term.length - a.term.length);
}

/**
 * 错译写法的候选：原形，以及去掉最后一个字的形式。
 *
 * 为什么要去掉一个字：探测拿到的写法常常比译文里实际出现的多一个尾字。
 * 实测 `replay buffer` 探到「反弹缓冲器」，而句子里出现的是「反弹缓冲」——
 * 差一个「器」，整条术语就白配置了。中文译名的尾部量词/后缀
 * （器、区、性、的）本来就是可有可无的。
 *
 * 只削一个字，且削完必须还有三个字。放宽会出事：
 * 「反弹缓冲器」一路削成「反弹」，那两个字在别的句子里也会出现。
 */
function withTrimmed(w) {
  return w.length >= 4 ? [w, w.slice(0, -1)] : [w];
}

/**
 * 把译文里的错译写法换成用户指定的译名。
 *
 * @param zh    机器译文
 * @param hits  matchTerms 的结果
 * @returns {{ text, applied: Array<{term,from,to}> }}
 */
function applyGlossary(zh, hits) {
  let out = String(zh || '');
  const applied = [];
  if (!out || !hits?.length) return { text: out, applied };

  for (const h of hits) {
    if (out.includes(h.zh)) continue;   // 模型已经译对了，别动

    /* 候选错译写法按长度倒序：同一个术语可能有「价值功能」和「功能」两种错法，
       先换长的，否则短的会把长的切碎。 */
    const forms = [...new Set((h.wrong || []).filter(Boolean))]
      .sort((a, b) => b.length - a.length);

    let done = false;
    for (const w of forms) {
      if (done) break;
      if (w === h.zh) continue;
      /* 只挡单字错法。中文术语绝大多数是两个字（政策、策略、缓冲），
         门槛设到三个字会把最常见的情况全堵死——这是写测试时发现的。
         单字（「能」「量」「数」）在中文里到处都是，拿来替换会把整句改烂，
         而两字以上配合「英文原文里必须出现这个术语」那道门槛已经足够安全。 */
      if (w.length < 2) continue;

      for (const cand of withTrimmed(w)) {
        if (!out.includes(cand)) continue;
        out = out.split(cand).join(h.zh);
        applied.push({ term: h.surface, from: cand, to: h.zh });
        done = true;   // 一个术语只改一次，改完就走
        break;
      }
    }
  }

  return { text: out, applied };
}

/**
 * 折叠紧邻的整体重复。
 *
 * 模型拿到一个孤零零的词时经常原地打转，实测输出：
 *   policy   → 政策政策
 *   scalar   → 标标
 *   baseline → 基准基准基准基准
 * 不折叠的话这些写法在真实译文里永远匹配不上，等于白探一次。
 */
function collapseRepeat(t) {
  const n = t.length;
  for (let len = 1; len <= n / 2; len++) {
    if (n % len) continue;
    const unit = t.slice(0, len);
    if (unit.repeat(n / len) === t) return unit;
  }
  return t;
}

/**
 * 清洗探测结果：把模型的原始输出变成可用的错译写法。
 *
 * 模型不会老老实实只回一个词。实际见到的：
 *   "政策。"          → 带句末标点
 *   "政策 (policy)"   → 把原词也带出来
 *   "政策政策"        → 孤零零一个词时原地打转
 *   "这项政策是指…"   → NLLB 有时会补成一句话
 * 最后一种没法用——拿一整句去做子串替换会把译文改烂，直接丢掉。
 *
 * @returns {string|null} 可用的写法，或 null 表示这次探测没拿到东西
 */
function cleanProbe(raw) {
  let t = String(raw || '').trim();
  if (!t) return null;
  // 括注、书名号里的补充说明去掉
  t = t.replace(/[（(【[].*?[)）\]】]/g, '').trim();
  // 首尾标点去掉（中英文都要）
  t = t.replace(/^[\s"'“”‘’、，。；：!?！？.,;:-]+/, '')
    .replace(/[\s"'“”‘’、，。；：!?！？.,;:-]+$/, '').trim();
  if (!t) return null;
  // 必须是中文；混着拉丁字母的多半是模型没译或者把原词抄回来了
  if (!/[一-鿿]/.test(t) || /[a-zA-Z]/.test(t)) return null;
  /* 超过 12 个字基本就是一句话而不是一个词。拿句子做子串替换会毁掉译文，
     而术语再长也就「经验回放缓冲区」这个量级。 */
  if (t.length > 12) return null;
  return collapseRepeat(t);
}

/**
 * 掐掉两串的共同头尾，返回 a 中间不一样的那段。
 *
 * 用来从「框架句」里抠出术语的译法：把 `We use the replay buffer.` 和
 * `We use the thing.` 的译文一减，中间剩下的就是模型给 replay buffer 的写法。
 *
 * 为什么需要这一手：模型对同一个术语的错译**不是固定的**，取决于上下文。
 * 单独问 replay buffer 给的是「复制缓冲器」，而句子里出现的是「反弹缓冲」，
 * 拿前者去替换什么也换不动。框架句更接近真实语境。
 */
function diffMiddle(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y) return '';
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i
    && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return x.slice(i, x.length - j);
}

/** 框架句：问模型「它在句子里怎么译这个术语」。X 位置换成控制词就是对照 */
const PROBE_FRAME = (x) => `We use the ${x}.`;
/** 控制词：挑一个模型一定会稳定翻译、且不会和任何术语混起来的普通名词 */
const PROBE_CONTROL = 'thing';

/**
 * 框架做差的结果可不可信。
 *
 * 做差假定两句译文只在术语那一段不同，但模型会改写框架本身。实测
 * `We use the value function.` 得到的差是「使用价值函数」——把框架里的
 * 动词吸进来了。这种写法一旦命中，替换会连「使用」一起删掉，是真能改坏译文的。
 *
 * 判据：差异段不该含有对照译文里的任何字。含了就说明框架没对齐，这次不算。
 */
function frameDiffOk(form, ctrlZh) {
  if (!form) return false;
  if (!ctrlZh) return true;
  const ctrl = new Set(String(ctrlZh));
  for (const ch of form) if (ctrl.has(ch)) return false;
  return true;
}

/**
 * 需要向模型问「它把这些术语译成什么」的条目。
 * 已经问过的（wrong 非空）就不用再问——模型是确定性的，问一次就够。
 */
function needProbe(hits) {
  return hits.filter((h) => !h.wrong || !h.wrong.length);
}

module.exports = {
  parseGlossary, matchTerms, applyGlossary, needProbe, cleanProbe, diffMiddle,
  frameDiffOk, PROBE_FRAME, PROBE_CONTROL, norm, MAX_TERMS,
};
