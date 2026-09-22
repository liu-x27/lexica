'use strict';
/* 悬浮查词窗：输入即查，Enter 送到主窗口，Esc 关闭。 */
(function (Lx) {
  const { $, esc, icon, debounce, badges, stars, highlight } = Lx;
  const api = window.lexica;

  let current = null;
  /* 当前这个词在不在生词本里，以及从悬浮字幕带进来的语境（那一句字幕）。
     原先这个窗口根本没有收藏按钮，只能「在主窗口打开」再去点书签。 */
  let currentSaved = false;
  let context = null;
  let mtReady = false;
  let settings = { mtAuto: true };
  /** 区分翻译结果是哪一次请求的：用户改输入的速度比模型快 */
  let mtToken = null;

  function paintChrome() {
    $('#qIcon').innerHTML = icon('search');
    $('#qSave').innerHTML = icon('bookmark');
    $('#qExpand').innerHTML = icon('corner');
    $('#qClose').innerHTML = icon('x');
  }

  function blank(text) {
    return `<div class="q-blank"><div>
      <div class="q-blank-mark">Aa</div>
      <div class="q-blank-text">${text}</div>
    </div></div>`;
  }

  /** 逐词拆解（悬浮窗的紧凑版） */
  function decomposedHtml(d) {
    const parts = d.parts
      .map(
        (p) => `<div class="q-dc-part${p.stop ? ' is-stop' : ''}" ${p.found ? `data-word="${esc(p.word)}"` : ''}>
            <span class="q-dc-word">${esc(p.word)}</span>
            <span class="q-dc-zh">${p.found ? esc(p.brief) : '词库中没有'}</span>
          </div>`,
      )
      .join('');
    return `<div class="q-sec-label">逐词拆解</div><div class="q-dc">${parts}</div>`;
  }

  /**
   * 机器翻译兜底。
   *
   * 划词场景下不再要求用户手动点——查不到时还让人多点一次就违背了划词的意义。
   * 但结果放在拆解之后、用虚线框和「机器翻译」标签区分：
   * 实测这个模型在术语上会自信地译错（ablation study → 通货膨胀研究），
   * 可靠信息必须排在它前面。
   */
  async function maybeTranslate(text, force) {
    if (!mtReady || !settings.mtAuto) return;
    const src = String(text || '').trim();
    if (!src) return;
    // 单个已收录的词不需要机翻，只在词典给不出整体释义时才补
    if (!force && !/[\s-]/.test(src)) return;

    const body = $('#qBody');
    const box = document.createElement('div');
    box.className = 'q-mt';
    box.innerHTML = '<div class="q-sec-label">机器翻译</div><div class="q-mt-wait">翻译中…</div>';
    body.appendChild(box);

    const r = await api.mtTranslate(src);
    // 用户可能已经改了输入，结果回来时页面已换，就别塞进去了
    if (!box.isConnected) return;
    box.innerHTML = r?.ok
      ? `<div class="q-sec-label">机器翻译 · 仅供参考</div>
         <div class="q-mt-text">${esc(r.text)}</div>
         <div class="q-mt-note">本地模型输出，专业术语常有偏差</div>`
      : `<div class="q-sec-label">机器翻译</div><div class="q-mt-note">${esc(r?.reason || '翻译失败')}</div>`;
  }

  /** 句中术语（悬浮窗的紧凑版）。来自词库，译名可信，所以摆在译文前面 */
  function termsHtml(terms) {
    if (!terms?.length) return '';
    return `<div class="q-sec-label">句中术语</div>
      <div class="q-terms">${terms
        .map((t) => `<div class="q-term" data-word="${esc(t.word)}">
            <span class="q-term-w">${esc(t.surface)}</span>
            <span class="q-term-zh">${esc(t.brief)}</span>
          </div>`)
        .join('')}</div>`;
  }

  /**
   * 划到整句时的处理。
   *
   * 以前长句会一路落到「没有找到」——decompose 超过 8 个词就放弃，
   * 而在论文里划的往往正是一整句。这里直接给双语对照。
   * 原文必须留在译文旁边：模型会把数字改错（实测 63.8 → 638），
   * 只给译文的话没人能发现。
   */
  async function renderSentence(res, query) {
    const body = $('#qBody');
    body.innerHTML = `${termsHtml(res.terms)}
      <div class="q-sec-label">机器翻译 · 仅供参考</div>
      <div id="qMt" class="q-mt-wait">正在翻译…</div>`;
    body.scrollTop = 0;

    if (!mtReady) {
      $('#qMt').outerHTML = '<div class="q-mt-note">未安装翻译模型</div>';
      return;
    }

    const token = `q-${Date.now()}`;
    mtToken = token;
    const r = await api.mtTranslateLong(query, token);
    const box = $('#qMt');
    if (mtToken !== token || !box) return;

    box.outerHTML = r?.ok
      ? `<div class="q-pairs">${r.sentences
          .map((p) => `<div class="q-pair">
              <div class="q-pair-src">${esc(p.src)}</div>
              <div class="q-pair-out">${esc(p.out || '（未译出）')}</div>
            </div>`)
          .join('')}</div>
         <div class="q-mt-note">本地模型逐句翻译，术语与数字常有偏差，请对照原文</div>`
      : `<div class="q-mt-note">${esc(r?.reason || '翻译失败')}</div>`;
  }

  function render(res, query) {
    const body = $('#qBody');

    if (res.status === 'sentence') {
      current = null;
      renderSentence(res, query);
      return;
    }

    // 中文反查 / 多词检索：拆解 + 候选列表
    if (res.status === 'list') {
      current = null;
      const parts = [];

      /* 逐词拆解放在最前面：这是可靠信息，机器翻译只是补充。
         划词划到的学术词组多半查不到整体，拆开往往就够用了。 */
      if (res.decomposed) parts.push(decomposedHtml(res.decomposed));

      if (res.items.length) {
        parts.push(`
          <div class="q-sec-label">${res.kind === 'zh' ? '中文反查' : '释义检索'} · ${res.items.length} 个结果</div>
          <div class="q-list">
            ${res.items
              .slice(0, 20)
              .map(
                (r) => `<div class="q-list-item" data-word="${esc(r.word)}">
                          <span class="q-list-word">${esc(r.word)}</span>
                          <span class="q-list-brief">${esc(r.brief || '')}</span>
                        </div>`,
              )
              .join('')}
          </div>`);
      }

      if (!parts.length) {
        body.innerHTML = `<div class="q-blank"><div>
          <div class="q-blank-mark">∅</div>
          <div class="q-blank-text">「${esc(query)}」没有匹配结果</div>
        </div></div>`;
      } else {
        body.innerHTML = parts.join('');
      }

      // 词典给不出整体释义时补一条机器翻译，标注清楚
      maybeTranslate(query, !res.items.length);
      body.scrollTop = 0;
      return;
    }

    if (res.status !== 'ok') {
      const sug = (res.suggestions || [])
        .slice(0, 6)
        .map((s) => {
          const w = s.row?.word ?? s.word;
          return `<button class="chip" data-word="${esc(w)}">${esc(w)}</button>`;
        })
        .join('');
      body.innerHTML = `<div class="q-blank"><div>
        <div class="q-blank-mark">?</div>
        <div class="q-blank-text">没有找到「${esc(query)}」</div>
        ${sug ? `<div class="q-sug">${sug}</div>` : ''}
      </div></div>`;
      current = null;
      // 拼写建议之外，多词内容也给一条机器翻译
      maybeTranslate(query, true);
      return;
    }

    const e = res.entry;
    current = e.word;
    currentSaved = !!res.saved;
    paintSave();

    const via = res.via
      ? `<div class="faint" style="font-size:var(--fs-2xs);margin-bottom:var(--sp-2)">
           ${esc(res.via.from)} → ${esc(res.via.lemma)}（${esc(res.via.label)}）
         </div>`
      : '';

    const senses = e.translation
      .slice(0, 6)
      .map(
        (t) => `<div class="q-sense">
                  <span class="q-pos">${t.pos ? esc(t.pos) + '.' : ''}</span>
                  <span>${esc(t.text)}</span>
                </div>`,
      )
      .join('');

    const forms = e.forms.length
      ? `<div class="q-forms">${e.forms
          .map(
            (f) => `<span class="capsule">
                      <span class="capsule-key">${esc(f.label)}</span>
                      <span class="capsule-val">${esc(f.words[0])}</span>
                    </span>`,
          )
          .join('')}</div>`
      : '';

    const ex = e.examples.length
      ? `<div class="q-ex">${e.examples
          .slice(0, 2)
          .map(
            (x) => `<div class="ex">
                      <div class="ex-en">${highlight(x.en, e.word, e.forms.flatMap((f) => f.words))}</div>
                      ${x.zh ? `<div class="ex-zh">${esc(x.zh)}</div>` : ''}
                    </div>`,
          )
          .join('')}</div>`
      : '';

    body.innerHTML = `
      ${via}
      <div class="q-head">
        <span class="q-word">${esc(e.word)}</span>
        ${e.phonetic ? `<span class="q-ph">/${esc(e.phonetic)}/</span>` : ''}
        <button class="speak-btn" data-speak="${esc(e.word)}" title="朗读">${icon('volume')}</button>
      </div>
      <div class="q-meta">
        <span class="badge-set">${badges(e.tags.map((t) => t.code), e.oxford)}</span>
        ${stars(e.collins)}
      </div>
      <div class="q-rule"></div>
      <div class="q-senses">${senses || '<span class="faint">该词条没有中文释义</span>'}</div>
      ${forms}
      ${ex}`;
    body.scrollTop = 0;
  }

  /** 收藏按钮：查到了词才出现；已在生词本里就高亮 */
  function paintSave() {
    const b = $('#qSave');
    if (!b) return;
    b.classList.toggle('hidden', !current);
    b.classList.toggle('is-on', !!currentSaved);
    b.title = currentSaved
      ? (context ? '已在生词本 · 再记下这句字幕' : '已在生词本')
      : (context ? '收进生词本，并记下这句字幕' : '收进生词本');
  }

  async function lookup(q) {
    const query = String(q || '').trim();
    current = null;
    paintSave();
    if (!query) {
      $('#qBody').innerHTML = blank('输入单词开始查询<br>也可以直接输入中文反查');
      return;
    }
    const res = await api.lookup(query, { noHistory: true });
    if (res.__error) return;
    render(res, query);
  }

  const ask = debounce(lookup, 110);

  function wire() {
    const input = $('#qInput');

    input.addEventListener('input', () => ask(input.value));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); api.quickHide(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        api.quickToMain(current || input.value.trim());
      }
    });

    $('#qClose').addEventListener('click', () => api.quickHide());

    /* 收藏：从悬浮字幕点进来的带着那句字幕当语境；
       划词进来的没有语境，就只收词。已经收过的再点，是「再记一句语境」而不是删除——
       这里不做删除，删词在生词本里做，免得误点把词弄丢。 */
    $('#qSave').addEventListener('click', async () => {
      if (!current) return;
      if (currentSaved && !context) return Lx.toast('已经在生词本里了');
      const r = await api.wbAddContext({
        word: current,
        en: context?.en || '',
        zh: context?.zh || null,
        src: context?.src || null,
      }).catch((err) => ({ ok: false, reason: err.message }));
      if (!r?.ok) return Lx.toast(r?.reason || '收藏失败');
      currentSaved = true;
      paintSave();
      Lx.toast(r.added
        ? `已收进生词本：${current}${context ? '，并记下这句字幕' : ''}`
        : '记下了这句字幕');
    });
    $('#qExpand').addEventListener('click', () => api.quickToMain(current || input.value.trim()));

    $('#qBody').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-word]');
      if (chip) {
        input.value = chip.dataset.word;
        return lookup(chip.dataset.word);
      }
      const sp = e.target.closest('[data-speak]');
      if (sp) return Lx.tts.speak(sp.dataset.speak, 'us', sp);
    });

    // 主进程每次唤起时重置内容并聚焦
    api.onQuickOpen(({ seed, context: ctx }) => {
      // 每次唤起都重置：上一次从悬浮字幕带来的语境不能串到这次的划词上
      context = ctx || null;
      input.value = seed || '';
      input.focus();
      input.select();
      lookup(seed);
    });

    api.onTheme(({ theme }) => document.documentElement.setAttribute('data-theme', theme));

    // 整段翻译的逐句进度：小窗里也要能看出在动，否则像卡住了
    api.onMtProgress(({ token, done, total }) => {
      if (token !== mtToken) return;
      const box = $('#qMt');
      if (box) box.textContent = `正在翻译 ${done} / ${total} 句…`;
    });
  }

  window.addEventListener('DOMContentLoaded', async () => {
    paintChrome();
    Lx.tts.init();
    const s = await api.getSettings();
    settings = s;
    document.documentElement.setAttribute('data-theme', s.theme || 'paper');
    Lx.tts.rate = Number(s.ttsRate) || 0.95;
    const mt = await api.mtStatus().catch(() => null);
    mtReady = !!mt?.available;
    wire();
    lookup('');
  });
})(window.Lx);
