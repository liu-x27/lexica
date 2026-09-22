'use strict';
/* 自定义词表与自定义词条的界面。两者都放在「自定义」视图里。 */
(function (Lx) {
  const { esc, icon } = Lx;

  /* ==================================================================== */
  /*  自定义词条                                                          */
  /* ==================================================================== */

  /**
   * @param st.entries 已有词条
   * @param st.draft   正在编辑的词条 {word, phonetic, translation, note}
   */
  function entriesPanel(st) {
    const d = st.draft || {};
    const editing = !!d.word && st.entries.some((e) => e.word === d.word);

    const list = st.entries.length
      ? st.entries
          .map(
            (e) => `<div class="ce-row">
              <div class="ce-main">
                <div class="row row-gap-3">
                  <span class="ce-word">${esc(e.word)}</span>
                  ${e.phonetic ? `<span class="phonetic-text" style="font-size:var(--fs-2xs)">/${esc(e.phonetic)}/</span>` : ''}
                </div>
                <div class="ce-zh">${esc(e.translation)}</div>
                ${e.note ? `<div class="ce-note">${esc(e.note)}</div>` : ''}
              </div>
              <div class="row row-gap-2">
                <button class="icon-btn" data-act="ce-edit" data-word="${esc(e.word)}" title="编辑">${icon('wand')}</button>
                <button class="icon-btn" data-act="ce-del" data-word="${esc(e.word)}" title="删除">${icon('trash')}</button>
              </div>
            </div>`,
          )
          .join('')
      : `<div class="cu-empty">还没有自定义词条。词库停在 2019 年前后，
           像「充电宝」「扫码」这类新词查不到，可以在这里自己补上。</div>`;

    return `<div class="cu-panel">
      <div class="cu-form">
        <div class="cu-form-row">
          <input class="cu-input" id="ceWord" placeholder="单词，如 power bank"
                 value="${esc(d.word || '')}" ${editing ? 'readonly' : ''} spellcheck="false">
          <input class="cu-input" id="cePhon" placeholder="音标（可留空）"
                 value="${esc(d.phonetic || '')}" spellcheck="false" style="max-width:200px">
        </div>
        <input class="cu-input" id="ceTr" placeholder="中文释义，如 n. 充电宝，移动电源"
               value="${esc(d.translation || '')}">
        <input class="cu-input" id="ceNote" placeholder="备注（可留空）" value="${esc(d.note || '')}">
        <div class="row row-gap-2">
          <button class="btn btn-accent" data-act="ce-save">${editing ? '保存修改' : '添加词条'}</button>
          ${d.word ? '<button class="btn btn-outline" data-act="ce-cancel">取消</button>' : ''}
          <span class="spacer"></span>
          <span class="set-desc">自定义词条会出现在查词结果与搜索建议里</span>
        </div>
      </div>
      <div class="ce-list">${list}</div>
    </div>`;
  }

  /* ==================================================================== */
  /*  自定义词表                                                          */
  /* ==================================================================== */

  function listsPanel(st) {
    const pv = st.preview;

    const items = st.lists.length
      ? st.lists
          .map(
            (l) => `<div class="cl-row">
              <div class="cl-main" data-act="drill-scope" data-scope="${esc(l.scope)}">
                <div class="cl-name">${esc(l.name)}</div>
                <div class="cl-meta">${l.n} 词 · 可出题 ${l.quizzable ?? '—'} 词
                  · ${new Date(l.created_at).toLocaleDateString('zh-CN')}</div>
              </div>
              <div class="row row-gap-2">
                <button class="btn btn-outline" data-act="drill-scope" data-scope="${esc(l.scope)}">去练习</button>
                <button class="icon-btn" data-act="cl-del" data-id="${l.id}" title="删除词表">${icon('trash')}</button>
              </div>
            </div>`,
          )
          .join('')
      : '<div class="cu-empty">还没有自定义词表。把一份单词表粘进下面的框里就能当成练习范围。</div>';

    return `<div class="cu-panel">
      <div class="cl-list">${items}</div>

      <div class="cu-form">
        <div class="cu-form-row">
          <input class="cu-input" id="clName" placeholder="词表名称，如「新概念三 Unit 1-5」"
                 value="${esc(st.draftName || '')}">
          <button class="btn btn-outline" data-act="cl-file">${icon('folder')} 从文件导入</button>
        </div>
        <textarea class="cu-textarea" id="clText" rows="8" spellcheck="false"
          placeholder="每行一个单词。也支持「单词, 释义」或「单词\t释义」这种格式，只取第一列。
以 # 开头的行会被忽略。">${esc(st.draftText || '')}</textarea>
        <div class="row row-gap-2">
          <button class="btn btn-outline" data-act="cl-preview">检查一下</button>
          <button class="btn btn-accent" data-act="cl-create">创建词表</button>
          ${
            pv
              ? `<span class="cl-preview">
                   解析出 <strong>${pv.total}</strong> 个词，词库里能查到 <strong>${pv.known}</strong> 个
                   ${
                     pv.total - pv.known > 0
                       ? `· 查不到 ${pv.total - pv.known} 个${
                           pv.missing?.length ? `（${pv.missing.slice(0, 6).map(esc).join('、')}…）` : ''
                         }`
                       : ''
                   }
                 </span>`
              : ''
          }
        </div>
      </div>
    </div>`;
  }

  /* ==================================================================== */
  /*  术语表                                                              */
  /* ==================================================================== */

  /**
   * @param st.terms 已有术语 [{term, surface, zh, wrong, note, hits}]
   * @param st.gDraft 正在编辑的 {term, zh, note}
   */
  /**
   * 起步包：按课程方向预置的常见术语。
   * 收了日常常见词的包（强化学习包的 policy、agent…）把适用范围标成警示色——
   * 导入之后，别的课上含这些词的句子也会被改，这件事必须在按下导入之前看到。
   */
  function packsBlock(packs) {
    if (!packs?.length) return '';
    return `<div class="cu-form gl-packs">
      <div class="set-label">起步包
        <span class="faint">按课程方向预置的常见术语，你已经有的词条不会被覆盖</span></div>
      ${packs.map((p) => {
        const done = p.have >= p.count;
        return `<div class="gl-pack">
          <div class="gl-pack-main">
            <div class="gl-pack-name">${esc(p.name)}
              <span class="faint">${p.count} 条${p.have && !done ? ` · 已有 ${p.have}` : ''}</span></div>
            <div class="gl-pack-scope${p.caution ? ' is-caution' : ''}">${esc(p.scope)}</div>
            <div class="gl-pack-sample">${p.sample.map(esc).join('　')}　…</div>
          </div>
          <button class="btn ${done ? 'btn-outline' : 'btn-accent'}" data-act="gl-pack" data-id="${esc(p.id)}"
                  ${done ? 'disabled' : ''}>${done ? '已导入' : '导入'}</button>
        </div>`;
      }).join('')}
    </div>`;
  }

  function glossPanel(st) {
    const d = st.gDraft || {};
    const terms = st.terms || [];

    const rows = terms.length
      ? terms
          .map(
            (t) => `<div class="gl-row">
              <div class="gl-main">
                <div class="row row-gap-3">
                  <span class="gl-en">${esc(t.surface || t.term)}</span>
                  <span class="gl-arrow">${icon('arrowRight')}</span>
                  <span class="gl-zh">${esc(t.zh)}</span>
                  ${t.hits > 0 ? `<span class="gl-hits" title="已经修正过 ${t.hits} 次">${t.hits}</span>` : ''}
                </div>
                ${
                  /* 把模型的错译写法显示出来，这条术语到底在防什么一眼可见；
                     空的说明还没探测到（或者模型本来就译对了）。 */
                  t.wrong?.length
                    ? `<div class="gl-wrong">模型会译成：${t.wrong.map(esc).join('、')}</div>`
                    : '<div class="gl-wrong gl-pending">尚未探测到模型的错译写法</div>'
                }
                ${t.note ? `<div class="ce-note">${esc(t.note)}</div>` : ''}
              </div>
              <div class="row row-gap-2">
                <button class="icon-btn" data-act="gl-edit" data-term="${esc(t.term)}" title="编辑">${icon('wand')}</button>
                <button class="icon-btn" data-act="gl-del" data-term="${esc(t.term)}" title="删除">${icon('trash')}</button>
              </div>
            </div>`,
          )
          .join('')
      : `<div class="cu-empty">还没有术语。本地翻译模型在专业词上错得很稳定——
           policy 译成「政策」、value function 译成「价值功能」、
           replay buffer 译成「重弹缓冲」。在这里写下正确译名，
           实时字幕和整段翻译都会自动改过来。</div>`;

    return `<div class="cu-panel">
      <div class="cu-form">
        <div class="cu-form-row">
          <input class="cu-input" id="glTerm" placeholder="英文术语，如 value function"
                 value="${esc(d.term || '')}" spellcheck="false">
          <input class="cu-input" id="glZh" placeholder="你要的译名，如 价值函数"
                 value="${esc(d.zh || '')}">
        </div>
        <input class="cu-input" id="glNote" placeholder="备注（可留空）" value="${esc(d.note || '')}">
        <div class="row row-gap-2">
          <button class="btn btn-accent" data-act="gl-save">${d.editing ? '保存修改' : '添加术语'}</button>
          ${d.term ? '<button class="btn btn-outline" data-act="gl-cancel">取消</button>' : ''}
          <span class="spacer"></span>
          <span class="set-desc">只在英文原文里出现该术语、且译文命中已知错法时才替换</span>
        </div>
      </div>

      <div class="gl-list">${rows}</div>

      ${packsBlock(st.packs)}

      <div class="cu-form">
        <div class="set-label">批量粘贴</div>
        <textarea class="cu-textarea" id="glText" rows="6" spellcheck="false"
          placeholder="每行一条，英文在左、中文在右。分隔符用 =、:、｜、逗号、制表符或两个以上空格都行：
policy = 策略
value function: 价值函数
replay buffer    经验回放缓冲
以 # 开头的行会被忽略。">${esc(st.gText || '')}</textarea>
        <div class="row row-gap-2">
          <button class="btn btn-accent" data-act="gl-import">追加导入</button>
          <button class="btn btn-outline" data-act="gl-import-replace">覆盖导入</button>
          <span class="spacer"></span>
          <button class="btn btn-outline" data-act="gl-reprobe"
                  title="换过翻译模型之后用：重新问一遍模型对每个术语的错译写法">
            重新探测
          </button>
        </div>
      </div>
    </div>`;
  }

  /* ==================================================================== */

  Lx.renderCustom = (st) => `
    <div class="page">
      <div>
        <div class="wb-head">
          <div class="wb-title">自定义</div>
          <div class="spacer"></div>
          <div class="seg">
            <button class="seg-btn ${st.tab === 'lists' ? 'is-on' : ''}" data-act="cu-tab" data-tab="lists">
              词表 ${st.lists.length ? `· ${st.lists.length}` : ''}
            </button>
            <button class="seg-btn ${st.tab === 'entries' ? 'is-on' : ''}" data-act="cu-tab" data-tab="entries">
              词条 ${st.entries.length ? `· ${st.entries.length}` : ''}
            </button>
            ${
              st.mt
                ? `<button class="seg-btn ${st.tab === 'gloss' ? 'is-on' : ''}" data-act="cu-tab" data-tab="gloss">
                     术语表 ${st.terms?.length ? `· ${st.terms.length}` : ''}
                   </button>`
                : ''
            }
          </div>
        </div>
        ${st.tab === 'entries' ? entriesPanel(st) : st.tab === 'gloss' && st.mt ? glossPanel(st) : listsPanel(st)}
      </div>
    </div>`;
})(window.Lx);
