'use strict';
/**
 * 腾讯 Hy-MT2（Apache-2.0）：官方 GGUF 跑在 llama-server 里（见 llama-server.js）。
 *
 * 提示词一律照官方模板写，一个字都别自己改：这类专用翻译模型是按固定模板训的，
 * 换个说法它就可能开始解释、续写，或者把术语当成要翻译的正文。
 * 术语表命中的词填进官方的术语模板（「参考下面的翻译」那段）。
 *
 * 模板出处：论文 arXiv 2605.22064 的表 1，和 tencent/Hy-MT2-7B-GGUF 模型卡上的表一致。
 * 卡上的表是 markdown，`{target_lang}` 两边有反引号和空格；论文里那一格没有空格，
 * 这里照论文。中文提示词里的语言名要用中文（卡上原话），所以目标语言写「中文」。
 * 卡上的代码示例用的是另一种说法（「翻译成英语,」半角逗号），和它自己的表对不上，没照它。
 */

/** 可选的两档。key 也是设置项 mtModel / lectureMtModel 的值 */
const HYMT_MODELS = {
  hymt7b: {
    backend: 'llama',
    repo: 'tencent/Hy-MT2-7B-GGUF',
    file: 'Hy-MT2-7B-Q4_K_M.gguf',          // 4,624,648,896 字节
    label: 'Hy-MT2-7B（大模型，要显卡）',
    note: '腾讯的翻译专用模型。数字有守卫，术语表直接喂给它。没有独显也能跑，但一句要好几秒。',
  },
  hymt18b: {
    backend: 'llama',
    repo: 'tencent/Hy-MT2-1.8B-GGUF',
    /* 1.8B 用 Q8_0 而不是 Q4_K_M：论文表 5 里 Q4 让 1.8B 的指令遵循（IFMTB）从 69.4
       掉到 63.5，术语模板正靠这个；1.9GB 也不算大。 */
    file: 'Hy-MT2-1.8B-Q8_0.gguf',          // 1,908,528,192 字节
    label: 'Hy-MT2-1.8B（小一号）',
    note: '同一系列的小模型，显存和速度都省得多。',
  },
};

const ASK = '将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：';

/** 默认翻译的官方模板 */
const PLAIN = (src) => `${ASK}\n\n${src}`;

/**
 * 术语干预的官方模板：每条术语一行「原文 翻译成 译文」。
 * 中文版的术语行和「将以下文本…」之间没有空行（英文版有），照原样。
 */
const WITH_TERMS = (src, terms) => `参考下面的翻译：\n${
  terms.map((t) => `${t.en} 翻译成 ${t.zh}`).join('\n')
}\n${ASK}\n\n${src}`;

/** 一句话最多带几条术语。一句字幕里命中十几条的多半是术语表加得太泛，全塞进去只会干扰 */
const MAX_TERMS = 8;

/**
 * 拼成发给 /v1/chat/completions 的消息。模型卡没有系统提示，只有一条 user 消息。
 * @param terms [{ en, zh }]，术语表里在这句英文中命中的条目
 */
function hymtMessages(src, { terms = [] } = {}) {
  const picked = (terms || []).filter((t) => t && t.en && t.zh).slice(0, MAX_TERMS);
  return [{ role: 'user', content: picked.length ? WITH_TERMS(src, picked) : PLAIN(src) }];
}

/**
 * 采样参数。
 *
 * 模型卡推荐 top_k 20 / top_p 0.6 / repetition_penalty 1.05 / temperature 0.7
 * （仓库里的 generation_config.json 写的 top_p 是 0.8）。这里用贪心（temperature 0）：
 * 同一句每次译得一样，字幕不会因为重放、重译就变，基准两次跑的数也能比。
 * 重复惩罚照官方的留着，防止原地打转。
 *
 * 生成上限按原文长度给，和 translate-worker.js 的 budgetFor 一个思路：
 * 写死的话长句会被拦腰截断，而截断处没有任何提示。
 */
function hymtParams(src) {
  const words = String(src).split(/\s+/).filter(Boolean).length;
  return {
    temperature: 0,
    top_k: 1,
    top_p: 1,
    repeat_penalty: 1.05,
    max_tokens: Math.max(96, Math.min(1024, words * 4 + 64)),
  };
}

/**
 * 清理模型输出：去掉首尾空白、偶尔夹带的「译文：」前缀，以及模型自己加的整句引号。
 * 只动首尾，不碰正文——正文里的任何改动都可能把译文改坏。
 * 原文本身就是引号括起来的一句话时，引号是原文的，留着。
 */
function cleanOutput(text, src = '') {
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  t = t.replace(/^(?:译文|翻译|中文)\s*[:：]\s*/, '');
  if (!/^\s*["“'‘]/.test(src)) {
    for (const [a, b] of [['"', '"'], ['“', '”'], ['「', '」']]) {
      if (t.length <= 2 || !t.startsWith(a) || !t.endsWith(b)) continue;
      const inner = t.slice(a.length, -b.length);
      // 「“注意力”与“记忆”」首尾也是引号，但那是两对，剥掉就成了半截引号
      if (!inner.includes(a) && !inner.includes(b)) t = inner.trim();
    }
  }
  return t;
}

module.exports = { HYMT_MODELS, hymtMessages, hymtParams, cleanOutput, MAX_TERMS };
