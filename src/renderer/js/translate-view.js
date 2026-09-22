'use strict';
/* 长句 / 整段翻译的渲染。
 *
 * 一条贯穿始终的设计前提：本地模型（opus-mt-en-zh q8）在学术文本上不可靠。
 * 实测它会把 ablation study 译成「通膨研究」、code and checkpoints 译成
 * 「密码和检查站」，甚至把 63.8 写成 638——数字都会被改错。
 * 所以这里坚持三件事：
 *   1. 永远逐句给出原文与译文的对照，不提供「只看译文」的模式；
 *   2. 词典能给出准确译名的术语单独列在最前，那部分是数据不是推测；
 *   3. 标注写清楚是机器翻译，并明确提醒数字要对着原文核。
 */
(function (Lx) {
  const { esc, icon, badges } = Lx;

  /** 句中术语：来自词库，译名可信，所以摆在译文前面 */
  function renderTerms(terms) {
    if (!terms?.length) return '';
    return `
      <div class="tr-terms">
        <div class="label-rule"><span class="label">句中术语</span>
          <span class="faint tr-terms-hint">词典收录，译名可信</span>
        </div>
        <div class="tr-term-list">
          ${terms.map((t) => `
            <button class="tr-term" data-act="goto" data-word="${esc(t.word)}">
              <span class="tr-term-surface">${esc(t.surface)}</span>
              ${t.lemma && t.lemma.toLowerCase() !== t.surface.toLowerCase()
                ? `<span class="tr-term-lemma">${esc(t.lemma)}</span>` : ''}
              ${t.phonetic ? `<span class="tr-term-ph">/${esc(t.phonetic)}/</span>` : ''}
              <span class="tr-term-brief">${esc(t.brief)}</span>
              <span class="tr-term-badges">${badges(t.tags.map((x) => x.code), t.oxford)}</span>
            </button>`).join('')}
        </div>
      </div>`;
  }

  /**
   * 双语对照译文。
   * @param r 主进程返回的 { sentences:[{src,out}], truncated }
   */
  function renderPairs(r) {
    if (!r?.sentences?.length) return '';
    return `
      ${r.truncated ? `<div class="tr-warn">${icon('alert')} ${esc(r.truncated)}</div>` : ''}
      <div class="tr-pairs" data-ctx-src="整段翻译">
        ${r.sentences.map((p) => `
          <div class="tr-pair">
            <div class="tr-src">${esc(p.src)}</div>
            <div class="tr-out">${p.out ? esc(p.out) : '<span class="faint">（未译出）</span>'}</div>
          </div>`).join('')}
      </div>`;
  }

  /** 译文区的外框：加载中 / 出错 / 结果三态共用 */
  function shell(inner, { ms = null, actions = '' } = {}) {
    return `
      <div class="tr-block">
        <div class="label-rule">
          <span class="label">机器翻译</span>
          <span class="faint tr-caveat">
            本地模型逐句翻译${ms ? ` · ${(ms / 1000).toFixed(1)}s` : ''}
            —— 术语与数字常有偏差，务必对照左侧原文
          </span>
          ${actions}
        </div>
        ${inner}
      </div>`;
  }

  Lx.renderMtLoading = (done, total) => shell(`
    <div class="tr-progress">
      <div class="tr-progress-bar"><i style="width:${total ? Math.round((done / total) * 100) : 8}%"></i></div>
      <div class="tr-progress-text">${total ? `正在翻译 ${done} / ${total} 句…` : '正在加载模型…'}</div>
    </div>`);

  Lx.renderMtResult = (r) => {
    if (!r?.ok) {
      return shell(`<div class="tr-error">${esc(r?.reason || '翻译失败')}</div>`);
    }
    return shell(renderPairs(r), {
      ms: r.ms,
      actions: `<button class="btn btn-ghost btn-xs" data-act="tr-copy">${icon('copy')} 复制译文</button>`,
    });
  };

  /* ==================================================================== */
  /*  查词框输入长句时的结果页                                            */
  /* ==================================================================== */

  Lx.renderSentence = (res, { mtAvailable, mtAuto }) => {
    const wordCount = res.query.split(/\s+/).filter(Boolean).length;
    return `<div class="page">
      <div class="sent-head">
        <div class="sent-kind">${icon('quote')} 整句</div>
        <div class="sent-text" id="sentSrc">${esc(res.query)}</div>
        <div class="sent-meta">
          ${wordCount} 个词
          <button class="btn btn-ghost btn-xs" data-act="speak"
                  data-text="${esc(res.query)}" data-accent="us">${icon('volume')} 朗读</button>
        </div>
      </div>

      ${renderTerms(res.terms)}

      <div id="mtBox">
        ${
          mtAvailable
            ? (mtAuto
                ? Lx.renderMtLoading(0, 0)
                : `<div class="tr-block"><button class="btn btn-accent" data-act="mt-long"
                     data-text="${esc(res.query)}">${icon('translate')} 翻译这句</button></div>`)
            : `<div class="tr-block"><div class="tr-error">
                 没有安装翻译模型。在项目目录运行 <span class="mono">npm run fetch:model</span> 后可用（约 117MB）。
               </div></div>`
        }
      </div>

      ${
        res.decomposed
          ? `<details class="tr-more"><summary>逐词拆解</summary>${Lx.renderDecomposed(res.decomposed)}</details>`
          : ''
      }
      ${
        res.items?.length
          ? `<details class="tr-more"><summary>词库里含这些词的条目（${res.items.length}）</summary>
               ${Lx.renderResultItems(res.items)}</details>`
          : ''
      }
    </div>`;
  };

  /* ==================================================================== */
  /*  独立的翻译页                                                        */
  /* ==================================================================== */

  Lx.renderTranslate = (st) => `<div class="page">
    <div class="wb-head">
      <div class="wb-title">翻译</div>
      <div class="wb-sub">粘贴整段英文，逐句对照。完全离线。</div>
    </div>

    <div class="tr-input-box">
      <textarea class="tr-input" id="trInput" rows="6" spellcheck="false"
        placeholder="粘贴一段英文…（Ctrl+Enter 开始翻译）">${esc(st.draft || '')}</textarea>
      <div class="tr-input-bar">
        <span class="faint" id="trCount">${(st.draft || '').length} 字符</span>
        <div class="row row-gap-2">
          <!-- 常驻而不是按 draft 有无来渲染：输入时只更新字数、不重绘
               （重绘会换掉 textarea，光标和输入法状态都会丢），
               条件渲染的话按钮就一直不出现。 -->
          <button class="btn btn-outline" data-act="tr-clear">清空</button>
          <button class="btn btn-accent" data-act="tr-run" ${st.busy ? 'disabled' : ''}>
            ${icon('translate')} ${st.busy ? '翻译中…' : '翻译'}
          </button>
        </div>
      </div>
    </div>

    ${st.terms?.length ? renderTerms(st.terms) : ''}

    <div id="trResult">
      ${st.busy ? Lx.renderMtLoading(st.done || 0, st.total || 0) : st.result ? Lx.renderMtResult(st.result) : ''}
    </div>

    ${
      !st.result && !st.busy
        ? `<div class="tr-tip">
             ${icon('alert')}
             <div>
               <strong>关于翻译质量</strong><br>
               用的是本地小模型（opus-mt-en-zh，117MB，完全离线）。日常英文够用，
               但<strong>学术术语与数字经常出错</strong>——实测会把 ablation study 译成「通膨研究」、
               把 63.8 写成 638。所以这里始终逐句给出原文对照，
               上方的「句中术语」来自词典，那部分译名是可信的。
             </div>
           </div>`
        : ''
    }
  </div>`;
})(window.Lx);
