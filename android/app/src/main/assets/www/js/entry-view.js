'use strict';
/* 词条详情页渲染。输出 HTML 字符串，交互由 app.js 用事件委托统一接管。 */
(function (Lx) {
  const { esc, icon, highlight, badges, stars, freqLabel, posColor } = Lx;

  /** 把 ECDICT 与 WordNet 的词性缩写归到同一组 */
  const POS_GROUP = {
    n: 'n', u: 'n', c: 'n', pl: 'n',
    v: 'v', vt: 'v', vi: 'v', aux: 'v',
    adj: 'adj', a: 'adj',
    adv: 'adv', r: 'adv',
  };
  const groupOf = (p) => (p ? POS_GROUP[p] || p : 'other');

  const GROUP_NAME = {
    n: '名词', v: '动词', adj: '形容词', adv: '副词',
    prep: '介词', conj: '连词', pron: '代词', num: '数词',
    art: '冠词', int: '感叹词', abbr: '缩写', det: '限定词',
    other: '其他',
  };
  const GROUP_ABBR = {
    n: 'n.', v: 'v.', adj: 'adj.', adv: 'adv.', prep: 'prep.', conj: 'conj.',
    pron: 'pron.', num: 'num.', art: 'art.', int: 'int.', abbr: 'abbr.', det: 'det.', other: '—',
  };
  const GROUP_ORDER = ['n', 'v', 'adj', 'adv', 'prep', 'conj', 'pron', 'num', 'art', 'int', 'det', 'abbr', 'other'];

  /* --------------------------------------------------------------- 片段 */

  function heroBlock(e, saved, mine = null) {
    /* ECDICT 没有系统的英/美双音标（美式标记 (?@) 全库仅 41 条），
       所以这里不假装分栏：主音标标「音标」，有 (?@) 的才标「美」，
       分号或逗号分出的同口音变体标「又读」。 */
    const p = e.phon;
    const ph = p
      ? `<span class="phonetic">
           <span class="phonetic-tag">${p.us ? '英' : '音标'}</span>
           <span class="phonetic-text">/${esc(p.main)}/</span>
         </span>
         ${
           p.us
             ? `<span class="phonetic">
                  <span class="phonetic-tag">美</span>
                  <span class="phonetic-text">/${esc(p.us)}/</span>
                </span>`
             : ''
         }
         ${
           p.alts.length
             ? `<span class="phonetic">
                  <span class="phonetic-tag">又读</span>
                  <span class="phonetic-text">${p.alts.map((a) => `/${esc(a)}/`).join('　')}</span>
                </span>`
             : ''
         }`
      : '';

    return `
      <header class="entry-hero rise">
        <h1 class="word-head">
          <span class="head-text">${esc(e.word)}</span>
          ${e.isCustom ? '<span class="custom-flag">我的词条</span>' : ''}
          <span class="hero-actions">
            <button class="icon-btn ${saved ? 'is-on' : ''}" data-act="bookmark"
                    title="${saved ? '从生词本移除' : '加入生词本'}">${icon('bookmark')}</button>
            <button class="icon-btn ${mine?.note || mine?.my_def ? 'is-on' : ''}"
                    data-act="wb-edit" data-word="${esc(e.word)}"
                    title="写我的释义与笔记">${icon('quote')}</button>
            <button class="icon-btn" data-act="copy" title="复制单词">${icon('check')}</button>
          </span>
        </h1>

        <div class="phonetic-row">
          ${ph}
          <span class="phonetic">
            <span class="phonetic-tag">英</span>
            <button class="speak-btn" data-act="speak" data-accent="uk" data-text="${esc(e.word)}"
                    title="英式发音">${icon('volume')}</button>
            <span class="phonetic-tag">美</span>
            <button class="speak-btn" data-act="speak" data-accent="us" data-text="${esc(e.word)}"
                    title="美式发音">${icon('volume')}</button>
          </span>
        </div>

        <div class="meta-row">
          <span class="badge-set">${badges(e.tags.map((t) => t.code), e.oxford)}</span>
          ${stars(e.collins)}
          ${
            e.lemmaOf
              ? `<button class="chip" data-act="goto" data-word="${esc(e.lemmaOf.word)}">
                   原形 ${esc(e.lemmaOf.word)} →
                 </button>`
              : ''
          }
        </div>

        <div class="word-head-rule"></div>
      </header>`;
  }

  /**
   * 「我的」区块：生词本上写的释义与笔记。
   *
   * 排在词形变化之前、词库释义之前——用户特意记下来的东西优先级最高，
   * 而词库释义在下面整块都是。词库里没有这个词时（自己加的词组），
   * 这一块就是页面上唯一的释义。
   */
  function mineBlock(mine, word) {
    const def = mine?.my_def?.trim();
    const note = mine?.note?.trim();
    if (!def && !note) return '';
    return `<section class="section rise">
        <div class="label-rule"><span class="label">我的</span></div>
        <div class="mine-box">
          ${def ? `<div class="mine-def">${esc(def)}</div>` : ''}
          ${note ? `<div class="mine-note">${esc(note)}</div>` : ''}
          <button class="btn btn-outline" data-act="wb-edit" data-word="${esc(word)}">
            ${icon('wand')} 编辑
          </button>
        </div>
      </section>`;
  }

  function formsBlock(e) {
    if (!e.forms.length) return '';
    const caps = e.forms
      .map(
        (f) => `<button class="capsule" data-act="goto" data-word="${esc(f.words[0])}">
                  <span class="capsule-key">${esc(f.label)}</span>
                  <span class="capsule-val">${esc(f.words.join(' / '))}</span>
                </button>`,
      )
      .join('');
    return `<section class="section rise">
              <div class="label-rule"><span class="label">词形变化</span></div>
              <div class="forms">${caps}</div>
            </section>`;
  }

  /**
   * WordNet 自带例句。每条只占一行，来源标注整组只写一次——
   * 之前每条都带一个 WORDNET 角标，一个义项下重复三遍，版面很吵。
   */
  function wnExamples(list, word, forms) {
    if (!list.length) return '';
    const items = list
      .slice(0, 3)
      .map(
        (x) => `<div class="ex ex-compact">
                  <div class="ex-en">${highlight(x, word, forms)}</div>
                  <button class="icon-btn ex-speak" data-act="speak" data-accent="us"
                          data-text="${esc(x)}" title="朗读">${icon('volume')}</button>
                </div>`,
      )
      .join('');
    return `<div class="sense-ex">
              <div class="sense-ex-label">WordNet 例句</div>
              ${items}
            </div>`;
  }

  /** Tatoeba 例句（带中文对照时一并显示） */
  function tatoebaExamples(list, word, forms, label) {
    if (!list.length) return '';
    const items = list
      .map(
        (x) => `<div class="ex">
                  <div class="ex-en">${highlight(x.en, word, forms)}</div>
                  ${x.zh ? `<div class="ex-zh">${esc(x.zh)}</div>` : ''}
                  <div class="ex-foot">
                    <span class="ex-src">${esc(x.source)}${x.zh ? ' · 中英对照' : ''}</span>
                    <button class="icon-btn ex-speak" data-act="speak" data-accent="us"
                            data-text="${esc(x.en)}" title="朗读例句">${icon('volume')}</button>
                  </div>
                </div>`,
      )
      .join('');
    return `<div class="sense-ex">
              ${label ? `<div class="sense-ex-label">${esc(label)}</div>` : ''}
              ${items}
            </div>`;
  }

  /** 每个词性分组默认展开的义项条数，超出的折叠起来 */
  const SENSE_VISIBLE = 5;

  /** 释义区顶部的词性导航条：显示各词性义项数，点击滚动过去 */
  function posNav(groups) {
    if (groups.length < 2) return '';
    const chips = groups
      .map(
        ([g, bag], i) => `<button class="posnav-chip${i === 0 ? ' is-first' : ''}"
                                  data-act="jump-pos" data-pos="${esc(g)}">
                            <span class="posnav-abbr">${GROUP_ABBR[g] || g}</span>
                            <span class="posnav-name">${GROUP_NAME[g] || g}</span>
                            <span class="posnav-count">${bag.zh.length + bag.en.length}</span>
                          </button>`,
      )
      .join('');
    return `<div class="posnav">${chips}</div>`;
  }

  /**
   * 把中文释义与 WordNet 义项按词性合并成分组，并把按词性归好的例句分发进去。
   * 分发不到任何分组的例句作为 leftover 返回，由通用例句区兜底。
   */
  function buildGroups(e) {
    const groups = new Map();
    const touch = (g) => {
      if (!groups.has(g)) groups.set(g, { zh: [], en: [], ex: [] });
      return groups.get(g);
    };

    for (const t of e.translation) touch(groupOf(t.pos)).zh.push(t);
    for (const g of e.senses) touch(groupOf(g.pos)).en.push(...g.senses);

    // 例句按词性落到对应分组；分组不存在的留给通用例句区
    const leftover = [];
    for (const [pos, list] of Object.entries(e.examplesByPos || {})) {
      const key = groupOf(pos);
      if (groups.has(key)) groups.get(key).ex.push(...list);
      else leftover.push(...list);
    }

    /* 排序：先按这个词自己的词性占比（ephemeral 是 100% 形容词，
       形容词组就该排在名词组前面），占比里没有的再按通用词性顺序兜底。 */
    const ratioRank = new Map();
    e.posRatio.forEach((p, i) => {
      if (!ratioRank.has(p.pos)) ratioRank.set(p.pos, i);
    });
    const rankOf = (g) => {
      if (ratioRank.has(g)) return ratioRank.get(g);
      const i = GROUP_ORDER.indexOf(g);
      return 100 + (i < 0 ? 99 : i);
    };
    const ordered = [...groups.entries()].sort((a, b) => rankOf(a[0]) - rankOf(b[0]));

    return { groups, ordered, leftover };
  }

  /** 按词性把中文释义与 WordNet 义项合并成一组 */
  function sensesBlock(e, built) {
    const { groups, ordered } = built;

    // 中文释义没标词性、又没有 WordNet 义项时，退化成一段纯释义
    if (groups.size === 1 && groups.has('other') && !groups.get('other').en.length) {
      const lines = groups.get('other').zh;
      if (!lines.length) return '';
      return `<section class="section rise">
                <div class="label-rule"><span class="label">释义</span></div>
                <ul class="zh-block">
                  ${lines.map((t) => `<li class="zh-line">${esc(t.text)}</li>`).join('')}
                </ul>
              </section>`;
    }

    const formWords = e.forms.flatMap((f) => f.words);

    const html = ordered
      .map(([g, bag]) => {
        const count = bag.zh.length + bag.en.length;
        if (!count) return '';

        const zh = bag.zh.length
          ? `<ul class="zh-block">
               ${bag.zh
                 .map(
                   (t) => `<li class="zh-line">
                             ${t.pos && groupOf(t.pos) !== t.pos ? `<span class="zh-sub">${esc(t.pos)}.</span>` : ''}
                             ${esc(t.text)}
                           </li>`,
                 )
                 .join('')}
             </ul>`
          : '';

        const senseItem = (s, i) => `<li class="sense${i >= SENSE_VISIBLE ? ' is-folded' : ''}">
             <div class="sense-num">${i + 1}</div>
             <div class="sense-body">
               <div class="sense-gloss">${esc(s.gloss)}${
                 s.domain ? `<span class="sense-domain">${esc(s.domain)}</span>` : ''
               }</div>
               ${
                 s.synonyms.length
                   ? `<div class="sense-syn">近义：${s.synonyms
                       .slice(0, 6)
                       .map((w) => `<button class="chip" data-act="goto" data-word="${esc(w)}">${esc(w)}</button>`)
                       .join('')}</div>`
                   : ''
               }
               ${wnExamples(s.examples, e.word, formWords)}
               ${tatoebaExamples(s.tatoeba || [], e.word, formWords, '例句')}
             </div>
           </li>`;

        const hidden = bag.en.length - SENSE_VISIBLE;
        const en = bag.en.length
          ? `${bag.zh.length ? '<div class="sub-rule"><span>英文义项</span></div>' : ''}
             <ul class="sense-list">${bag.en.map(senseItem).join('')}</ul>
             ${
               hidden > 0
                 ? `<button class="fold-btn" data-act="unfold">
                      ${icon('chevronDown')} 展开其余 ${hidden} 条义项
                    </button>`
                 : ''
             }`
          : '';

        // 只定到词性、没定到具体义项的例句，挂在该词性分组末尾
        const groupEx = tatoebaExamples(
          (bag.ex || []).slice(0, 4), e.word, formWords, `${GROUP_NAME[g] || g}用例`,
        );

        return `<div class="pos-group" data-pos-group="${esc(g)}">
                  <div class="pos-head">
                    <span class="pos-abbr">${GROUP_ABBR[g] || g}</span>
                    <span class="pos-name">${GROUP_NAME[g] || g}</span>
                    <span class="pos-count">${count} 项</span>
                  </div>
                  ${zh}${en}${groupEx}
                </div>`;
      })
      .join('');

    return `<section class="section rise" id="sec-senses">
              <div class="label-rule"><span class="label">释义与义项</span></div>
              ${posNav(ordered)}
              ${html}
            </section>`;
  }

  /** 通用例句区：放没能归到任何词性/义项下的例句 */
  function examplesBlock(e, leftover) {
    const all = [...e.examples, ...leftover].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);
    if (!all.length) return '';
    const formWords = e.forms.flatMap((f) => f.words);
    const items = all
      .map(
        (x) => `<div class="ex">
                  <div class="ex-en">${highlight(x.en, e.word, formWords)}</div>
                  ${x.zh ? `<div class="ex-zh">${esc(x.zh)}</div>` : ''}
                  <div class="ex-foot">
                    <span class="ex-src">${esc(x.source)}${x.zh ? ' · 中英对照' : ''}</span>
                    <button class="icon-btn ex-speak" data-act="speak" data-accent="us"
                            data-text="${esc(x.en)}" title="朗读例句">${icon('volume')}</button>
                  </div>
                </div>`,
      )
      .join('');
    return `<section class="section rise">
              <div class="label-rule"><span class="label">例句</span></div>
              <div class="ex-list">${items}</div>
            </section>`;
  }

  /** 易混词：拼写相近但意思不同，考试丢分重灾区 */
  function confusablesBlock(e) {
    if (!e.confusables?.length) return '';
    const items = e.confusables
      .map(
        (c) => `<button class="confuse-item" data-act="goto" data-word="${esc(c.word)}">
                  <span class="confuse-word">${esc(c.word)}</span>
                  <span class="confuse-zh">${esc(c.brief || '')}</span>
                </button>`,
      )
      .join('');
    return `<section class="section rise">
              <div class="label-rule"><span class="label">易混词</span></div>
              <div class="confuse-note">拼写相近但含义不同，注意区分</div>
              <div class="confuse-list">${items}</div>
            </section>`;
  }

  /** 词源：GCIDE（韦氏 1913）的 <ety> 字段 */
  function etymBlock(e) {
    if (!e.etym) return '';
    return `<section class="section rise">
              <div class="label-rule"><span class="label">词源</span></div>
              <div class="etym">
                <div class="etym-text">${esc(e.etym)}</div>
                <div class="etym-src">GCIDE · 韦氏 1913</div>
              </div>
            </section>`;
  }

  /** 古典引文：19 世纪及更早的文学用例，带作者 */
  function quotesBlock(e) {
    if (!e.quotes?.length) return '';
    const items = e.quotes
      .map(
        (q) => `<figure class="quote">
                  <blockquote class="quote-text">${highlight(q.text, e.word, e.forms.flatMap((f) => f.words))}</blockquote>
                  ${q.author ? `<figcaption class="quote-au">— ${esc(q.author)}</figcaption>` : ''}
                </figure>`,
      )
      .join('');
    return `<section class="section rise">
              <div class="label-rule"><span class="label">古典引文</span></div>
              <div class="quote-list">${items}</div>
            </section>`;
  }

  function relationsBlock(e) {
    const map = [
      ['synonyms', '同义词'],
      ['antonyms', '反义词'],
      ['hypernyms', '上位词（更一般）'],
      ['hyponyms', '下位词（更具体）'],
    ];
    const parts = map
      .filter(([k]) => e.relations[k]?.length)
      .map(
        ([k, label]) => `<div class="rel-group">
            <div class="rel-head">${label}</div>
            <div class="rel-chips">${e.relations[k]
              .slice(0, 14)
              .map((w) => `<button class="chip" data-act="goto" data-word="${esc(w)}">${esc(w)}</button>`)
              .join('')}</div>
          </div>`,
      )
      .join('');
    if (!parts) return '';
    return `<section class="section rise">
              <div class="label-rule"><span class="label">词汇网络</span></div>
              ${parts}
            </section>`;
  }

  /* ------------------------------------------------------------ 右侧栏 */

  function asideBlock(e, built) {
    const f = freqLabel(e.rank);
    const freqCard = `
      <div class="card">
        <div class="card-title">使用频率</div>
        <div class="meter">
          <div class="meter-top">
            <span class="meter-label">综合词频</span>
            <span class="meter-value">${e.rank >= 999999 ? '—' : `#${e.rank}`}</span>
          </div>
          <div class="meter-track"><div class="meter-fill" style="width:${f.pct}%"></div></div>
          <div class="meter-note">${esc(f.text)}</div>
        </div>
        ${
          e.frq
            ? `<div class="meter">
                 <div class="meter-top"><span class="meter-label">当代语料库 COCA</span>
                 <span class="meter-value">#${e.frq}</span></div></div>`
            : ''
        }
        ${
          e.bnc
            ? `<div class="meter">
                 <div class="meter-top"><span class="meter-label">英国国家语料库 BNC</span>
                 <span class="meter-value">#${e.bnc}</span></div></div>`
            : ''
        }
      </div>`;

    const ratio = e.posRatio.filter((p) => p.pct > 0);
    const posCard = ratio.length
      ? `<div class="card">
           <div class="card-title">词性分布</div>
           <div class="pos-bar">
             ${ratio
               .map(
                 (p, i) => `<span class="pos-seg" style="width:${p.pct}%;background:${posColor(p.pos, i)}"
                                  title="${esc(p.posName)} ${p.pct}%"></span>`,
               )
               .join('')}
           </div>
           <div class="pos-legend">
             ${ratio
               .map(
                 (p, i) => `<div class="pos-legend-row">
                     <span class="pos-legend-swatch" style="background:${posColor(p.pos, i)}"></span>
                     <span>${esc(p.posName)}</span>
                     <span class="pos-legend-pct">${p.pct}%</span>
                   </div>`,
               )
               .join('')}
           </div>
         </div>`
      : '';

    const senseCount = e.senses.reduce((n, g) => n + g.senses.length, 0);
    const exCount =
      e.examples.length +
      built.leftover.length +
      [...built.groups.values()].reduce((n, bag) => n + bag.ex.length, 0) +
      e.senses.reduce((n, g) => n + g.senses.reduce((m, s) => m + (s.tatoeba?.length || 0), 0), 0);
    const statCard = `
      <div class="card">
        <div class="card-title">本词收录</div>
        <div class="src-list">
          <div class="src-row"><span class="src-name">中文释义</span><span class="src-desc">${e.translation.length} 条</span></div>
          <div class="src-row"><span class="src-name">英文义项</span><span class="src-desc">${senseCount} 条</span></div>
          <div class="src-row"><span class="src-name">例句</span><span class="src-desc">${exCount} 条</span></div>
          <div class="src-row"><span class="src-name">词形变化</span><span class="src-desc">${e.forms.length} 组</span></div>
          ${e.etym ? '<div class="src-row"><span class="src-name">词源</span><span class="src-desc">有</span></div>' : ''}
          ${e.quotes?.length ? `<div class="src-row"><span class="src-name">古典引文</span><span class="src-desc">${e.quotes.length} 条</span></div>` : ''}
          ${e.collins ? `<div class="src-row"><span class="src-name">柯林斯</span><span class="src-desc">${e.collins} 星</span></div>` : ''}
        </div>
      </div>`;

    const srcCard = `
      <div class="card">
        <div class="card-title">数据来源</div>
        <div class="src-list">
          <div class="src-row"><span class="src-name">ECDICT</span><span class="src-desc">释义 / 词频 / 考纲标签</span></div>
          <div class="src-row"><span class="src-name">WordNet 3.1</span><span class="src-desc">义项 / 词汇网络</span></div>
          <div class="src-row"><span class="src-name">Tatoeba</span><span class="src-desc">例句 / 中英对照</span></div>
          ${e.etym || e.quotes?.length ? '<div class="src-row"><span class="src-name">GCIDE</span><span class="src-desc">词源 / 古典引文</span></div>' : ''}
        </div>
      </div>`;

    return `<aside class="aside">${freqCard}${posCard}${statCard}${srcCard}</aside>`;
  }

  /* ------------------------------------------------------------- 对外 */

  /** 词形跳转提示条：查 running 实际展示 run */
  function viaBanner(via) {
    if (!via) return '';
    return `<div class="didyoumean rise">
              <div class="didyoumean-head">
                ${esc(via.from)} 是 <strong>${esc(via.lemma)}</strong> 的${esc(via.label)}，已显示其原形词条
              </div>
            </div>`;
  }

  /**
   * 低可信条目的纠正提示。ECDICT 收了不少常见错拼，
   * 直接展示会让人误以为拼写正确，所以要明确标出来。
   */
  function correctionBanner(corrections, weak) {
    if (!weak || !corrections?.length) return '';
    const list = corrections
      .map(
        (c) => `<button class="chip" data-act="goto" data-word="${esc(c.word)}">
                  ${esc(c.word)}${c.brief ? `<span class="faint"> · ${esc(c.brief.slice(0, 20))}</span>` : ''}
                </button>`,
      )
      .join('');
    return `<div class="didyoumean rise">
              <div class="didyoumean-head">
                这个词条没有词频、考纲与 WordNet 记录，可能是拼写有误。你要找的是不是：
              </div>
              <div class="didyoumean-list">${list}</div>
            </div>`;
  }

  Lx.renderEntry = (
    entry,
    { saved = false, via = null, corrections = [], weak = false, mine = null } = {},
  ) => {
    // 分组只算一次，释义区与通用例句区共用
    const built = buildGroups(entry);
    return `
    <div class="page has-aside">
      <article class="entry">
        ${viaBanner(via)}
        ${correctionBanner(corrections, weak)}
        ${heroBlock(entry, saved, mine)}
        ${mineBlock(mine, entry.word)}
        ${formsBlock(entry)}
        ${sensesBlock(entry, built)}
        ${examplesBlock(entry, built.leftover)}
        ${confusablesBlock(entry)}
        ${etymBlock(entry)}
        ${quotesBlock(entry)}
        ${relationsBlock(entry)}
      </article>
      ${asideBlock(entry, built)}
    </div>`;
  };

  /**
   * 检索结果列表：中文反查、或多词释义检索的落地页。
   */
  Lx.renderResultList = (query, items, kind, extra = {}) => {
    const title = kind === 'zh' ? '中文反查' : '释义检索';
    const hint =
      kind === 'zh'
        ? '按词频排序，点任意结果查看完整词条'
        : '在英文释义里全文匹配，按词频排序';

    const decomposed = extra.decomposed
      ? `<article class="entry">${Lx.renderDecomposed(extra.decomposed, extra)}</article>`
      : '';

    if (!items.length) {
      return `<div class="page"><div>
        ${
          decomposed ||
          `<div class="blank"><div>
             <div class="blank-mark">∅</div>
             <div class="blank-title">「${esc(query)}」没有匹配结果</div>
             <div class="blank-text">换个说法试试，中文可以用更常见的词，比如「短暂的」而不是「转瞬即逝的」。</div>
           </div></div>`
        }
      </div></div>`;
    }

    return `<div class="page">
      <div>
        <div class="wb-head">
          <div class="wb-title">${esc(query)}</div>
          <div class="spacer"></div>
          <div>
            <div class="label">${title}</div>
            <div class="set-desc" style="text-align:right">${items.length} 个结果 · ${hint}</div>
          </div>
        </div>
        ${decomposed}
        <div class="label-rule" style="margin-top:var(--sp-7)"><span class="label">${title}</span></div>
        ${Lx.renderResultItems(items)}
      </div>
    </div>`;
  };

  /** 结果条目列表。长句页的折叠区也用它，所以单独拆出来 */
  Lx.renderResultItems = (items) => `<div class="wb-list">${
    items
      .map(
        (r) => `<div class="wb-item" data-act="goto" data-word="${esc(r.word)}">
          <div>
            <div class="row row-gap-3">
              <span class="wb-word">${esc(r.word)}</span>
              ${r.phonetic ? `<span class="phonetic-text" style="font-size:var(--fs-2xs)">/${esc(r.phonetic)}/</span>` : ''}
              <span class="badge-set">${badges(r.tags, r.oxford)}</span>
            </div>
            ${r.brief ? `<div class="wb-tr">${esc(r.brief)}</div>` : ''}
          </div>
          <div class="wb-right">${stars(r.collins)}</div>
        </div>`,
      )
      .join('')
  }</div>`;

  /**
   * 词组拆解页：整体查不到时，把成分词摊开。
   * 读论文划到的词组多半查不到整体，但往往只有一个词是障碍。
   */
  Lx.renderDecomposed = (d, opts = {}) => {
    if (!d) return '';
    const parts = d.parts
      .map(
        (p) => `<div class="dc-part${p.stop ? ' is-stop' : ''}${p.found ? '' : ' is-missing'}"
                     ${p.found ? `data-act="goto" data-word="${esc(p.word)}"` : ''}>
            <div class="dc-word">
              ${esc(p.word)}
              ${p.via ? `<span class="dc-via">← ${esc(p.query)}</span>` : ''}
            </div>
            ${p.phonetic ? `<div class="dc-ph">/${esc(p.phonetic)}/</div>` : ''}
            <div class="dc-zh">${p.found ? esc(p.brief) : '词库中没有'}</div>
          </div>`,
      )
      .join('');

    const related = d.related.length
      ? `<div class="dc-related">
           <div class="rel-head">词库里的相关搭配</div>
           <div class="rel-chips">${d.related
             .map((r) => `<button class="chip" data-act="goto" data-word="${esc(r.word)}"
                            title="${esc(r.brief || '')}">${esc(r.word)}</button>`)
             .join('')}</div>
         </div>`
      : '';

    /* 机器翻译区。自动模式下由调用方填内容，这里只留容器；
       关掉自动时退回按钮，让用户自己决定要不要看。 */
    const mt = opts.mtAvailable
      ? `<div class="dc-mt" id="mtBox">${
          opts.mtAuto
            ? '<span class="dc-mt-note">正在翻译…</span>'
            : `<button class="btn btn-outline" data-act="mt-run" data-text="${esc(d.phrase)}">
                 ${icon('wand')} 试试机器翻译
               </button>
               <span class="dc-mt-note">本地模型离线翻译 · 专业术语可能不准，仅供参考</span>`
        }</div>`
      : '';

    return `<section class="section rise">
        <div class="label-rule"><span class="label">逐词拆解</span></div>
        <div class="dc-note">词库里没有「${esc(d.phrase)}」这个整体词条，下面是它的组成部分</div>
        <div class="dc-parts">${parts}</div>
        ${related}
        ${mt}
        <div class="dc-save">
          <button class="btn btn-outline" data-act="wb-edit" data-word="${esc(d.phrase)}">
            ${icon('bookmark')} 把这个词组加进生词本（可以自己写释义）
          </button>
        </div>
      </section>`;
  };

  /** 查不到时的页面：拼写建议 + 引导 */
  Lx.renderMiss = (query, suggestions) => {
    const list = (suggestions || [])
      .map(
        (s) => `<button class="chip" data-act="goto" data-word="${esc(s.word)}">
                  ${esc(s.word)}${s.brief ? `<span class="faint"> · ${esc(s.brief.slice(0, 18))}</span>` : ''}
                </button>`,
      )
      .join('');
    return `<div class="page">
      <div class="blank">
        <div>
          <div class="blank-mark">?</div>
          <div class="blank-title">没有找到「${esc(query)}」</div>
          <div class="blank-text">
            词库收录了 340 万条词条，但仍可能漏掉专有名词或很新的拼写。
            也可以直接输入中文来反查英文单词。
          </div>
          ${
            list
              ? `<div class="didyoumean" style="margin-top:var(--sp-7);text-align:left">
                   <div class="didyoumean-head">你要找的是不是：</div>
                   <div class="didyoumean-list">${list}</div>
                 </div>`
              : ''
          }
          <div class="blank-tips">
            <button class="btn btn-accent" data-act="wb-edit" data-word="${esc(query)}">
              ${icon('bookmark')} 加进生词本，自己写释义
            </button>
          </div>
        </div>
      </div>
    </div>`;
  };
})(window.Lx);
