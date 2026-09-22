'use strict';
/**
 * 点词查词卡片：在字幕、整段翻译、历史转写稿里点一个英文词（或拖选一个词组），
 * 就地弹出释义，一键收进生词本，并把那一句话记成语境。
 *
 * 这个应用一半是词典、一半是字幕，原先两边完全不通——
 * 上课时一个词没听懂，只能自己记下来再去搜。这个文件就是那座桥。
 *
 * 哪些地方能点，由容器上的 data-ctx-src 决定（值是出处，存进语境里）：
 *   #lecList（本节课）、转写稿查看页、翻译页的双语对照。
 * 容器里的 .lec-en / .tr-src 是可点的英文。新增一处可点的地方，
 * 只要给容器加 data-ctx-src，不用改这里。
 *
 * 只在桌面版加载。安卓没有字幕页和翻译页，也就没有可点的地方。
 */
(function (Lx) {
  const api = window.lexica;
  const WA = window.LexicaWordAt;
  if (!WA) return;   // word-at.js 没加载就整个不启用，别让点击报错

  /** 可点的英文所在的元素 */
  const TEXT_SEL = '.lec-en, .tr-src';

  let box = null;       // 卡片 DOM
  let token = 0;        // 区分是哪一次查询的结果：连点两个词时，慢的那次不该覆盖快的
  let current = null;   // { query, headword, saved, ctx }

  /* ------------------------------------------------------------ 取词 */

  /** 这个元素在不在可点的范围里；在就返回它的容器 */
  function scopeOf(el) {
    const text = el?.closest?.(TEXT_SEL);
    if (!text) return null;
    const scope = text.closest('[data-ctx-src]');
    return scope ? { text, scope } : null;
  }

  /**
   * 这一句的语境：英文是被点的那一行，中文从同一行里找。
   * 中文还在「翻译中…」或者没译出时不带——把占位文字存进生词本是垃圾数据。
   */
  function contextOf(text, scope) {
    const row = text.closest('.lec-texts, .tr-pair');
    const zhEl = row?.querySelector('.lec-zh:not(.is-pending):not(.is-empty), .tr-out');
    const zh = zhEl?.textContent?.trim() || null;
    return {
      en: text.textContent.trim(),
      zh: zh && !/^[（(]未译出[)）]$/.test(zh) ? zh : null,
      src: scope.dataset.ctxSrc || null,
    };
  }

  /** 单击：鼠标下的那个词，连同它在屏幕上的位置（用来摆卡片） */
  function wordUnder(e, text) {
    const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return null;
    if (!text.contains(r.startContainer)) return null;
    const hit = WA.wordAt(r.startContainer.textContent, r.startOffset);
    if (!hit) return null;

    // 用词本身的范围算位置，而不是鼠标点——卡片要贴着词，不是贴着光标
    const range = document.createRange();
    range.setStart(r.startContainer, hit.start);
    range.setEnd(r.startContainer, hit.end);
    return { query: hit.word, rect: range.getBoundingClientRect() };
  }

  /* ------------------------------------------------------------ 卡片 */

  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.className = 'wp';
    box.setAttribute('role', 'dialog');
    box.addEventListener('click', onBoxClick);
    document.body.appendChild(box);
    return box;
  }

  /** 摆在词的下方；下面放不下就翻到上方，左右夹在窗口里 */
  function place(rect) {
    const b = ensureBox();
    const W = b.offsetWidth || 320;
    const H = b.offsetHeight || 160;
    const gap = 8;
    let x = rect.left;
    let y = rect.bottom + gap;
    if (y + H > window.innerHeight - 8) y = Math.max(8, rect.top - H - gap);
    x = Math.max(8, Math.min(x, window.innerWidth - W - 8));
    b.style.left = `${Math.round(x)}px`;
    b.style.top = `${Math.round(y)}px`;
  }

  function saveLabel(saved) {
    return saved ? `${Lx.icon('check')} 已在生词本 · 记下这句` : `${Lx.icon('bookmark')} 收进生词本`;
  }

  function paint(state) {
    const { esc } = Lx;
    const b = ensureBox();
    const ctxLine = current?.ctx?.en
      ? `<div class="wp-ctx" title="收藏时会一起记下这句话">${esc(current.ctx.en)}</div>`
      : '';

    if (state.loading) {
      b.innerHTML = `<div class="wp-head"><span class="wp-word">${esc(state.query)}</span></div>
        <div class="wp-wait">查询中…</div>`;
      return;
    }

    const head = state.found
      ? `<div class="wp-head">
           <span class="wp-word">${esc(state.headword)}</span>
           ${state.phonetic ? `<span class="wp-ph">/${esc(state.phonetic)}/</span>` : ''}
           <button class="icon-btn wp-speak" data-act="speak" data-accent="us"
                   data-text="${esc(state.headword)}" title="朗读">${Lx.icon('volume')}</button>
         </div>
         ${state.via ? `<div class="wp-via">${esc(state.query)} → ${esc(state.headword)}</div>` : ''}`
      : `<div class="wp-head"><span class="wp-word">${esc(state.query)}</span></div>`;

    const mine = state.myDef ? `<div class="wp-mine">${esc(state.myDef)}</div>` : '';
    const senses = state.found
      ? state.senses.map((t) => `<div class="wp-sense">${t.pos ? `<span class="wp-pos">${esc(t.pos)}.</span>` : ''}${esc(t.text)}</div>`).join('')
      : `<div class="wp-miss">词库里没有「${esc(state.query)}」${state.mt ? '' : '，可以先收进生词本，之后自己写释义'}</div>`;
    const mt = state.mt ? `<div class="wp-mt"><span class="wp-mt-tag">机器翻译</span>${esc(state.mt)}</div>` : '';

    b.innerHTML = `${head}
      <div class="wp-body">${mine}${senses}${mt}</div>
      ${ctxLine}
      <div class="wp-foot">
        <button class="btn btn-accent wp-save" data-wp="save">${saveLabel(state.saved)}</button>
        ${state.found ? `<button class="btn btn-outline" data-act="goto" data-word="${esc(state.headword)}"
                          data-wp="goto">完整词条</button>` : ''}
      </div>`;
  }

  async function open(query, rect, ctx) {
    const my = ++token;
    current = { query, headword: query, saved: false, ctx };
    ensureBox().classList.add('is-open');
    Lx.wordPopoverOpen = true;
    paint({ loading: true, query });
    place(rect);

    const res = await api.lookup(query, { noHistory: true }).catch(() => null);
    if (my !== token) return;   // 已经点了别的词

    if (res?.status === 'ok') {
      const e = res.entry;
      current.headword = e.word;
      current.saved = !!res.saved;
      paint({
        found: true,
        query,
        headword: e.word,
        phonetic: e.phonetic,
        // 词形还原过的（networks → network）要让人看出来，不然会以为查错了
        via: e.word.toLowerCase() !== query.toLowerCase(),
        senses: (e.translation || []).slice(0, 4),
        myDef: res.mine?.my_def || null,
        saved: current.saved,
      });
      place(rect);
      return;
    }

    /* 词库查不到：多是词组（replay buffer）或识别错的词。
       词组值得补一条机器翻译；单个词查不到多半是识别错了，机翻它没意义。 */
    const state = { found: false, query, saved: !!res?.saved };
    paint(state);
    place(rect);
    if (/\s/.test(query)) {
      // 没装模型也没开在线时 mtTranslate 会返回 ok:false，这里什么都不显示
      const tr = await api.mtTranslate(query).catch(() => null);
      if (my !== token || !tr?.ok) return;
      paint({ ...state, mt: tr.text });
      place(rect);
    }
  }

  function close() {
    token += 1;
    current = null;
    Lx.wordPopoverOpen = false;
    box?.classList.remove('is-open');
  }

  async function onBoxClick(e) {
    const btn = e.target.closest('[data-wp]');
    if (!btn) return;
    if (btn.dataset.wp === 'goto') { close(); return; }   // 跳转交给全局的 data-act="goto"
    if (btn.dataset.wp !== 'save' || !current) return;

    btn.disabled = true;
    const r = await api.wbAddContext({
      word: current.headword,
      en: current.ctx?.en || '',
      zh: current.ctx?.zh || null,
      src: current.ctx?.src || null,
    }).catch((err) => ({ ok: false, reason: err.message }));
    btn.disabled = false;
    if (!r?.ok) { Lx.toast(r?.reason || '收藏失败'); return; }

    current.saved = true;
    btn.innerHTML = saveLabel(true);
    Lx.toast(r.added
      ? `已收进生词本：${current.headword}${current.ctx?.en ? '，并记下这句话' : ''}`
      : `记下了这句话（${current.headword} 已有 ${r.contexts.length} 条语境）`);
  }

  /* ------------------------------------------------------------ 接线 */

  /* 拖选词组：mouseup 时看有没有选中东西。
     太长的不弹——那是在选句子复制，卡片挡着反而碍事（phraseOf 会返回 null）。 */
  document.addEventListener('mouseup', (e) => {
    if (box?.contains(e.target)) return;
    const hit = scopeOf(e.target);
    if (!hit) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !hit.text.contains(sel.anchorNode)) return;
    const phrase = WA.phraseOf(sel.toString());
    if (!phrase) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    open(phrase, rect, contextOf(hit.text, hit.scope));
  });

  document.addEventListener('click', (e) => {
    if (box?.contains(e.target)) return;   // 卡片里的按钮自己处理

    const hit = scopeOf(e.target);
    const sel = window.getSelection();
    // 刚拖选完（mouseup 已经弹过卡片了），这次 click 不再处理
    if (hit && sel && !sel.isCollapsed) return;

    if (hit) {
      const w = wordUnder(e, hit.text);
      if (w) { open(w.query, w.rect, contextOf(hit.text, hit.scope)); return; }
    }
    if (box?.classList.contains('is-open')) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && box?.classList.contains('is-open')) close();
  });

  /* 用户自己一滚动，卡片就和它指着的那个词对不上了，直接收起。
   *
   * 只认用户的滚动（滚轮 / 触控板），不认程序滚动：本节课的列表每来一句字幕
   * 都会自动滚到底，用 scroll 事件的话卡片一出来就被收掉。
   * 另外卡片开着时自动滚动会暂停（lecture.js 看 Lx.wordPopoverOpen），
   * 免得你点的那一句被新字幕顶上去。 */
  document.addEventListener('wheel', (e) => {
    if (box?.classList.contains('is-open') && !box.contains(e.target)) close();
  }, { passive: true, capture: true });

  Lx.wordPopover = { open, close, isOpen: () => !!box?.classList.contains('is-open') };
})(window.Lx);
