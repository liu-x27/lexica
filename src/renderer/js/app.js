'use strict';
/* Lexica 主控制器：搜索、路由、键盘、生词本、复习、设置。 */
(function (Lx) {
  const { $, $$, icon, debounce, toast, tts } = Lx;
  const api = window.lexica;

  const state = {
    view: 'dict',
    settings: {},
    stats: { meta: {} },
    entry: null,
    saved: false,
    history: [],
    hist: -1,
    sug: { flat: [], cursor: -1, open: false },
    wb: { rows: [], counts: {}, filter: 'all', editor: null },
    review: { queue: [], index: 0, revealed: false, counts: {} },
    recordingHotkey: false,
  };

  const stage = () => $('#stage');
  const viewEl = (v) => $(`#view-${v}`);

  /* ==================================================================== */
  /*  启动                                                                */
  /* ==================================================================== */

  async function boot() {
    paintIcons();
    tts.init();

    state.stats = await api.stats();
    state.mt = await api.mtStatus().catch(() => ({ available: false }));
    state.settings = state.stats.settings || {};
    // 实时字幕页要读 lectureFormats / asrModel 之类做展示，给它一个引用
    Lx.settings = state.settings;
    state.wb.counts = state.stats.counts || {};
    applyTheme(state.settings.theme || 'paper');
    applyFontScale();
    tts.rate = Number(state.settings.ttsRate) || 0.95;

    if (!state.stats.ready) {
      viewEl('dict').innerHTML = renderNoDb(state.stats);
    } else {
      await renderHome();
    }
    refreshBadge();

    wireSearch();
    wireGlobalKeys();
    wireDelegation();
    // 实时字幕是桌面独有功能，安卓包里不带 lecture.js，这里要容许缺失
    Lx.lectureWire?.();

    api.onLookup(({ word }) => { switchView('dict'); go(word); });
    api.onView(({ view }) => switchView(view));
    api.onTheme(({ theme }) => applyTheme(theme));
    api.onWordbookChanged((counts) => { state.wb.counts = counts; refreshBadge(); });

    /* 整段翻译的逐句进度。一段话要好几秒，没有进度就只能干等；
       token 用来区分是哪一次请求，用户可能连着发起两次。 */
    api.onMtProgress(({ token, done, total }) => {
      const t = TR();
      if (t.token === token) {
        t.done = done;
        t.total = total;
        if (state.view === 'translate') {
          const box = $('#trResult');
          if (box) box.innerHTML = Lx.renderMtLoading(done, total);
        }
        return;
      }
      if (state.sentToken === token) {
        const box = $('#mtBox');
        if (box?.isConnected) box.innerHTML = Lx.renderMtLoading(done, total);
      }
    });

    // 语音列表是异步填充的，到了再刷新一下设置页
    setTimeout(() => { if (state.view === 'settings') renderSettings(); }, 800);
  }

  function paintIcons() {
    const map = {
      '[data-view="dict"]': 'book',
      '[data-view="translate"]': 'translate',
      '[data-view="lecture"]': 'mic',
      '[data-view="drill"]': 'target',
      '[data-view="wordbook"]': 'layers',
      '[data-view="review"]': 'cards',
      '[data-view="custom"]': 'wand',
      '[data-view="settings"]': 'cog',
      '[data-act="back"]': 'left',
      '[data-act="forward"]': 'right',
      '[data-act="random"]': 'shuffle',
      '#searchIcon': 'search',
      '#clearBtn': 'x',
    };
    for (const [sel, name] of Object.entries(map)) {
      const el = $(sel);
      if (el) el.innerHTML = icon(name);
    }
    paintThemeIcon();
  }

  function paintThemeIcon() {
    const el = $('[data-act="toggle-theme"]');
    if (el) el.innerHTML = icon(state.settings.theme === 'glass' ? 'sun' : 'moon');
  }

  function renderNoDb(stats) {
    return `<div class="page"><div class="blank"><div>
      <div class="blank-mark">!</div>
      <div class="blank-title">词库还没有准备好</div>
      <div class="blank-text">
        Lexica 需要先在本地构建离线词库（约 1.2 GB）。<br>
        在项目目录依次执行：<br><br>
        <span class="mono">npm run fetch</span> — 下载 ECDICT / WordNet / Tatoeba<br>
        <span class="mono">npm run build:db</span> — 合并成 dict.db<br><br>
        <span class="faint">${Lx.esc(stats.error || '')}</span>
      </div>
      <div class="blank-tips">
        <button class="btn btn-outline" data-act="open-data">${icon('folder')} 打开数据目录</button>
        <button class="btn btn-outline" data-act="relaunch">${icon('corner')} 重启应用</button>
      </div>
    </div></div></div>`;
  }

  /* ==================================================================== */
  /*  主题                                                                */
  /* ==================================================================== */

  /**
   * 跑机器翻译并把结果填进 #mtBox。
   * 结果永远排在逐词拆解之后并明确标注——模型在术语上会自信地译错，
   * 可靠信息必须在前面。
   */
  async function runMachineTranslation(text) {
    const box = $('#mtBox');
    if (!box || !text) return;
    box.innerHTML = '<span class="dc-mt-note">正在翻译…</span>';
    const r = await api.mtTranslate(text);
    if (!box.isConnected) return; // 期间用户可能已经查了别的词
    box.innerHTML = r?.ok
      ? `<div class="mt-result">
           <div class="mt-label">机器翻译${r.ms ? ` · ${r.ms}ms` : ''}</div>
           <div class="mt-text">${Lx.esc(r.text)}</div>
           <div class="dc-mt-note">本地模型输出，专业术语常有偏差，请以上面的逐词释义为准</div>
         </div>`
      : `<span class="dc-mt-note">${Lx.esc(r?.reason || '翻译失败')}</span>`;
  }

  /** 正文字号：只改根字号变量，界面骨架尺寸不受影响 */
  function applyFontScale() {
    const v = Number(state.settings.fontScale) || 1;
    document.documentElement.style.setProperty('--font-scale', String(v));
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    state.settings.theme = theme;
    paintThemeIcon();
  }

  async function toggleTheme() {
    const next = state.settings.theme === 'glass' ? 'paper' : 'glass';
    applyTheme(next);
    await api.putSettings({ theme: next });
  }

  /* ==================================================================== */
  /*  路由与视图                                                          */
  /* ==================================================================== */

  function switchView(v) {
    state.view = v;
    $$('.view').forEach((el) => el.classList.remove('is-active'));
    viewEl(v)?.classList.add('is-active');
    $$('.nav-btn[data-view]').forEach((b) => b.classList.toggle('is-active', b.dataset.view === v));
    stage().scrollTop = 0;

    if (v === 'custom') loadCustom();
    if (v === 'wordbook') loadWordbook();
    if (v === 'review') loadReview();
    if (v === 'drill') loadDrill();
    if (v === 'translate') paintTranslate();
    if (v === 'lecture') Lx.lectureEnter?.();
    if (v === 'settings') renderSettings();
  }

  /* ==================================================================== */
  /*  整段翻译                                                            */
  /* ==================================================================== */

  const TR = () => (state.tr ||= { draft: '', busy: false, done: 0, total: 0, result: null, terms: [] });

  function paintTranslate() {
    viewEl('translate').innerHTML = Lx.renderTranslate(TR());
  }

  /** 重绘会换掉 textarea，正在输入的内容要先收回 state */
  function captureTrDraft() {
    const el = $('#trInput');
    if (el) TR().draft = el.value;
  }

  async function runTranslateText(text, { into = '#trResult', terms = true } = {}) {
    const src = String(text || '').trim();
    if (!src) return;
    const t = TR();
    if (t.busy) return toast('还在翻译上一段，稍等一下');

    t.busy = true;
    t.done = 0;
    t.total = 0;
    t.result = null;
    // 术语来自词库，不用等模型，可以先显示
    if (terms) t.terms = (await api.sentenceTerms(src)) || [];
    paintTranslate();

    // 进度事件靠 token 对上是哪一次请求：用户可能连着点两次
    const token = `tr-${Date.now()}`;
    t.token = token;

    const r = await api.mtTranslateLong(src, token);
    if (t.token !== token) return; // 已经有更新的请求了

    t.busy = false;
    t.result = r;
    if (state.view === 'translate') paintTranslate();
    else {
      const box = $(into);
      if (box) box.innerHTML = Lx.renderMtResult(r);
    }
  }

  /** 长句结果页里的翻译（不在翻译页，所以只更新 #mtBox） */
  async function runSentenceTranslation(text) {
    const box = $('#mtBox');
    if (!box || !text) return;
    const token = `sent-${Date.now()}`;
    state.sentToken = token;
    box.innerHTML = Lx.renderMtLoading(0, 0);
    state.sentProgress = { token, box };

    const r = await api.mtTranslateLong(text, token);
    if (state.sentToken !== token || !box.isConnected) return;
    box.innerHTML = Lx.renderMtResult(r);
  }

  /* ==================================================================== */
  /*  考纲练习                                                            */
  /* ==================================================================== */

  const D = () => Lx.drill.state;
  const paintDrill = () => {
    viewEl('drill').innerHTML = Lx.renderDrill();
    // 拼写题渲染完立刻聚焦输入框，省得每题都要先点一下
    const spell = $('#spellInput');
    if (spell && !spell.disabled) {
      spell.focus();
      spell.setSelectionRange(spell.value.length, spell.value.length);
    }
  };

  async function loadDrill() {
    const d = D();
    if (!d.scopes.length) {
      d.loading = true;
      paintDrill();
      const [scopes, labels, heat, goals] = await Promise.all([
        api.drillScopes(),
        api.drillLabels(),
        api.heatmap(365),
        api.goalProgress(),
      ]);
      d.scopes = Array.isArray(scopes) ? scopes : [];
      Lx.drill.kindLabels = labels?.kinds || {};
      d.heat = Array.isArray(heat) ? heat : [];
      d.goals = goals && !goals.__error ? goals : null;
      d.loading = false;
    } else {
      // 目标进度每次进页面都要刷新，不能跟着 scopes 一起缓存
      const goals = await api.goalProgress();
      d.goals = goals && !goals.__error ? goals : null;
    }
    paintDrill();
  }

  async function drillPickScope(scope) {
    const d = D();
    d.scope = scope;
    d.scopeLabel = d.scopes.find((s) => s.scope === scope)?.label || scope;
    d.progress = await api.drillProgress(scope);
    d.stage = 'menu';
    await api.putSettings({ drillScope: scope });
    paintDrill();
    stage().scrollTop = 0;
  }

  async function drillStart(mode, count) {
    const d = D();
    d.loading = true;
    paintDrill();

    if (mode === 'study') {
      const list = await api.drillStudy(d.scope, 20);
      d.study = { list: Array.isArray(list) ? list : [], i: 0, revealed: false, marks: {} };
      d.stage = 'study';
    } else {
      let questions = [];
      let bands = [];
      if (mode === 'assess') {
        const r = await api.drillAssess(d.scope, count || 30);
        questions = r?.questions || [];
        bands = r?.bands || [];
      } else if (mode === 'weak') {
        questions = (await api.drillWeakQuiz(d.scope, count || 15)) || [];
      } else {
        questions = (await api.drillQuiz(d.scope, count || 10, d.kinds)) || [];
      }
      if (!Array.isArray(questions) || !questions.length) {
        d.loading = false;
        d.stage = 'menu';
        paintDrill();
        toast('这个范围出不了题，换一个范围或题型试试');
        return;
      }
      d.quiz = { mode, questions, i: 0, picked: null, locked: false, answers: [], bands };
      d.stage = 'quiz';
    }

    d.loading = false;
    paintDrill();
    stage().scrollTop = 0;

    // 听音题一进来就自动播一遍
    autoSpeakIfAudio();
  }

  function autoSpeakIfAudio() {
    const d = D();
    if (d.stage !== 'quiz') return;
    const cur = d.quiz.questions[d.quiz.i];
    if (cur?.kind === 'audio' && cur.speak) setTimeout(() => tts.speak(cur.speak, 'us'), 260);
  }

  /* ==================================================================== */
  /*  自定义词表与词条                                                    */
  /* ==================================================================== */

  const CU = () => (state.custom ||= {
    tab: 'lists', lists: [], entries: [], terms: [], draft: {}, gDraft: {}, preview: null,
  });
  const paintCustom = () => {
    /* 术语表只在装了翻译模型时才有意义——它修的就是机器翻译的输出。
       这一条同时挡掉安卓版（没内置模型）和桌面版没跑 fetch:model 的情况。 */
    viewEl('custom').innerHTML = Lx.renderCustom({ ...CU(), mt: !!state.mt?.available });
  };

  async function loadCustom() {
    const cu = CU();
    const [lists, entries, terms] = await Promise.all([
      api.lists(), api.customAll(300),
      state.mt?.available ? api.glossAll() : Promise.resolve([]),
    ]);
    cu.lists = Array.isArray(lists) ? lists : [];
    cu.entries = Array.isArray(entries) ? entries : [];
    cu.terms = Array.isArray(terms) ? terms : [];
    // 补上每个词表能出题的词数
    const scopes = await api.drillScopes();
    if (Array.isArray(scopes)) {
      const byScope = new Map(scopes.map((s) => [s.scope, s]));
      for (const l of cu.lists) l.quizzable = byScope.get(l.scope)?.quizzable;
    }
    paintCustom();
  }

  /**
   * 只重拉术语表再重绘。
   *
   * 探测是后台跑的，结果要等一两秒才进库；这里给界面一次追上的机会，
   * 又不能把用户正在输入的内容冲掉，所以先 capture 再画。
   */
  async function refreshTerms() {
    const cu = CU();
    captureCustomDraft();
    const terms = await api.glossAll();
    cu.terms = Array.isArray(terms) ? terms : [];
    paintCustom();
  }

  /** 输入框里的值要先收回 state，否则重绘会把用户正在打的内容冲掉 */
  function captureCustomDraft() {
    const cu = CU();
    if (cu.tab === 'entries') {
      cu.draft = {
        word: $('#ceWord')?.value ?? cu.draft.word ?? '',
        phonetic: $('#cePhon')?.value ?? '',
        translation: $('#ceTr')?.value ?? '',
        note: $('#ceNote')?.value ?? '',
      };
    } else if (cu.tab === 'gloss') {
      cu.gDraft = {
        term: $('#glTerm')?.value ?? cu.gDraft?.term ?? '',
        zh: $('#glZh')?.value ?? '',
        note: $('#glNote')?.value ?? '',
        editing: cu.gDraft?.editing || false,
      };
      cu.gText = $('#glText')?.value ?? cu.gText ?? '';
    } else {
      cu.draftName = $('#clName')?.value ?? cu.draftName ?? '';
      cu.draftText = $('#clText')?.value ?? cu.draftText ?? '';
    }
  }

  /** 提交拼写题。判分放在主进程，容错规则与出题引擎在同一处维护 */
  async function drillSpell() {
    const d = D();
    const q = d.quiz;
    const cur = q.questions[q.i];
    if (!cur || q.locked || !cur.input) return;

    const input = $('#spellInput');
    const value = (input?.value || '').trim();
    if (!value) {
      input?.focus();
      return;
    }

    q.spellValue = value;
    const r = await api.drillCheckSpell(value, cur.solution);
    q.spellResult = r;
    q.locked = true;
    q.answers.push({ word: cur.word, correct: !!r.correct, band: cur.band, kind: cur.kind, zh: null });
    await api.drillAnswer({ scope: d.scope, kind: cur.kind, word: cur.word, correct: !!r.correct });
    paintDrill();
    if (r.correct) setTimeout(() => drillNext(), 900);
  }

  async function drillPick(i) {
    const d = D();
    const q = d.quiz;
    const cur = q.questions[q.i];
    if (!cur || q.locked) return;

    q.picked = i;
    const correct = i === cur.answer;

    if (q.mode === 'assess') {
      // 检测模式先记下来，不判对错、不反馈
      paintDrill();
      return;
    }

    q.locked = true;
    q.answers.push({
      word: cur.word,
      correct,
      band: cur.band,
      kind: cur.kind,
      zh: cur.kind === 'en2zh' ? cur.options[cur.answer].text : null,
    });
    await api.drillAnswer({ scope: d.scope, kind: cur.kind, word: cur.word, correct });
    paintDrill();
    if (correct) setTimeout(() => drillNext(), 750);
  }

  async function drillNext() {
    const d = D();
    const q = d.quiz;
    const cur = q.questions[q.i];

    // 检测模式在离开当前题时才结算
    if (q.mode === 'assess' && cur && q.picked != null) {
      const correct = q.picked === cur.answer;
      q.answers.push({
        word: cur.word,
        correct,
        band: cur.band,
        kind: cur.kind,
        zh: cur.options[cur.answer].text,
      });
      await api.drillAnswer({ scope: d.scope, kind: cur.kind, word: cur.word, correct });
    }

    q.i++;
    q.picked = null;
    q.locked = false;

    if (q.i >= q.questions.length) return drillFinish();
    paintDrill();
    autoSpeakIfAudio();
  }

  async function drillFinish() {
    const d = D();
    const q = d.quiz;
    const right = q.answers.filter((a) => a.correct).length;
    const summary = Lx.summarizeDrill(q.answers, q.bands);

    d.result = {
      mode: q.mode,
      total: q.answers.length,
      right,
      rate: q.answers.length ? right / q.answers.length : 0,
      answers: q.answers,
      summary,
    };
    d.stage = 'result';
    paintDrill();
    stage().scrollTop = 0;

    d.progress = await api.drillFinish({
      scope: d.scope,
      mode: q.mode === 'assess' ? 'assess' : 'quiz',
      total: d.result.total,
      hit: right,
      detail: q.mode === 'assess' ? summary : null,
    });
    // 刷新范围列表里的进度
    const scopes = await api.drillScopes();
    if (Array.isArray(scopes)) d.scopes = scopes;
  }

  async function drillMark(known) {
    const d = D();
    const s = d.study;
    const e = s.list[s.i];
    if (!e) return;
    s.marks[s.i] = known ? 1 : 0;
    await api.drillMark(e.word, d.scope, known);
    s.i++;
    s.revealed = false;
    paintDrill();
    if (!known) toast(`${e.word} 已加入生词本`, 1200);
  }

  async function renderHome() {
    const recent = await api.recent(10);
    viewEl('dict').innerHTML = Lx.renderHome(recent, state.wb.counts, state.stats.meta || {});
  }

  /** 查词并渲染 */
  async function go(word, { push = true } = {}) {
    if (!word) return;
    if (!state.stats.ready) return;
    switchView('dict');

    const res = await api.lookup(word);
    if (res.__error) { toast('查询出错：' + res.__error); return; }

    if (res.status === 'ok') {
      state.entry = res.entry;
      state.saved = !!res.saved;
      viewEl('dict').innerHTML = Lx.renderEntry(res.entry, {
        saved: res.saved,
        via: res.via,
        corrections: res.corrections,
        weak: res.weak,
        mine: res.mine,     // 生词本上写的释义与笔记
      });
      if (push) pushHistory(res.entry.word);
      $('#searchInput').value = res.entry.word;
    } else if (res.status === 'sentence') {
      /* 长句：术语对照 + 双语译文。
         以前这类输入会落到「没找到」页面，本地模型压根用不上。 */
      state.entry = null;
      viewEl('dict').innerHTML = Lx.renderSentence(res, {
        mtAvailable: state.mt?.available,
        mtAuto: state.settings.mtAuto !== false,
      });
      if (state.mt?.available && state.settings.mtAuto !== false) {
        runSentenceTranslation(res.query);
      }
      if (push) pushHistory(res.query);
      $('#searchInput').value = res.query;
    } else if (res.status === 'list') {
      // 中文反查或多词释义检索：落到结果列表页，词组另附逐词拆解
      state.entry = null;
      viewEl('dict').innerHTML = Lx.renderResultList(res.query, res.items, res.kind, {
        decomposed: res.decomposed,
        mtAvailable: state.mt?.available,
        mtAuto: state.settings.mtAuto !== false,
      });
      // 词典给不出整体释义时自动补一条机器翻译，不必再点一下
      if (state.mt?.available && state.settings.mtAuto !== false && res.decomposed) {
        runMachineTranslation(res.query);
      }
      if (push) pushHistory(res.query);
      $('#searchInput').value = res.query;
    } else {
      state.entry = null;
      viewEl('dict').innerHTML = Lx.renderMiss(word, res.suggestions?.map((s) => ({
        word: s.row?.word ?? s.word,
        brief: s.row?.translation ? '' : s.brief,
      })) || []);
      if (push) pushHistory(word);
    }
    stage().scrollTop = 0;
    closeSuggest();
  }

  function pushHistory(word) {
    if (state.history[state.hist] === word) return;
    state.history = state.history.slice(0, state.hist + 1);
    state.history.push(word);
    state.hist = state.history.length - 1;
    paintNavArrows();
  }

  function paintNavArrows() {
    const b = $('[data-act="back"]');
    const f = $('[data-act="forward"]');
    if (b) b.disabled = state.hist <= 0;
    if (f) f.disabled = state.hist >= state.history.length - 1;
  }

  function navBack() {
    if (state.hist <= 0) return;
    state.hist--;
    go(state.history[state.hist], { push: false });
    paintNavArrows();
  }

  function navForward() {
    if (state.hist >= state.history.length - 1) return;
    state.hist++;
    go(state.history[state.hist], { push: false });
    paintNavArrows();
  }

  /* ==================================================================== */
  /*  搜索框与建议                                                        */
  /* ==================================================================== */

  function wireSearch() {
    const input = $('#searchInput');
    const box = $('#search');

    input.addEventListener('focus', () => box.classList.add('is-focus'));
    input.addEventListener('blur', () => {
      box.classList.remove('is-focus');
      // 留一点时间让点击建议项的 mousedown 先触发
      setTimeout(closeSuggest, 140);
    });

    const ask = debounce(async (q) => {
      if (!q.trim() || !state.stats.ready) return closeSuggest();
      const res = await api.suggest(q, 10);
      if (res.__error) return closeSuggest();
      paintSuggest(res.groups || []);
    }, 90);

    input.addEventListener('input', () => {
      $('#clearBtn').classList.toggle('hidden', !input.value);
      ask(input.value);
    });

    input.addEventListener('keydown', (e) => {
      const { flat, cursor, open } = state.sug;
      if (e.key === 'ArrowDown' && open) {
        e.preventDefault();
        moveCursor(Math.min(cursor + 1, flat.length - 1));
      } else if (e.key === 'ArrowUp' && open) {
        e.preventDefault();
        moveCursor(Math.max(cursor - 1, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = open && cursor >= 0 ? flat[cursor] : null;
        go(pick ? pick.word : input.value.trim());
      } else if (e.key === 'Escape') {
        if (open) closeSuggest();
        else input.blur();
      }
    });
  }

  function paintSuggest(groups) {
    const host = $('#suggest');
    const flat = [];
    let html = '';

    for (const g of groups) {
      html += `<div class="suggest-group"><div class="suggest-head">${Lx.esc(g.title)}</div>`;
      for (const it of g.items) {
        const i = flat.length;
        flat.push(it);
        html += `<div class="suggest-item" data-idx="${i}" data-act="goto" data-word="${Lx.esc(it.word)}">
          <span class="suggest-word">${Lx.esc(it.word)}</span>
          ${it.phonetic ? `<span class="suggest-ph">/${Lx.esc(it.phonetic)}/</span>` : ''}
          <span class="suggest-tr">${Lx.esc(it.brief || '')}</span>
          <span class="suggest-badges">${Lx.badges(it.tags, it.oxford)}</span>
        </div>`;
      }
      html += '</div>';
    }

    if (!flat.length) return closeSuggest();
    host.innerHTML = html;
    host.classList.remove('hidden');
    state.sug = { flat, cursor: -1, open: true };
  }

  function moveCursor(i) {
    state.sug.cursor = i;
    $$('.suggest-item').forEach((el) => el.classList.toggle('is-cursor', Number(el.dataset.idx) === i));
    if (i >= 0) $(`.suggest-item[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function closeSuggest() {
    $('#suggest')?.classList.add('hidden');
    state.sug = { flat: [], cursor: -1, open: false };
  }

  /* ==================================================================== */
  /*  生词本                                                              */
  /* ==================================================================== */

  /** 生词本行高，必须与 CSS 里的 .wb-item 高度一致 */
  const WB_ROW_H = 76;
  let wbVList = null;

  async function loadWordbook() {
    captureWbDraft();
    const [rows, counts] = await Promise.all([api.wbList({ limit: 20000 }), api.wbCounts()]);
    state.wb.rows = Array.isArray(rows) ? rows : [];
    state.wb.counts = counts;
    paintWordbook();
  }

  function paintWordbook() {
    const f = state.wb.filter;
    const now = Date.now();
    const rows = state.wb.rows.filter((r) => {
      if (f === 'all') return true;
      if (f === 'due') return r.due <= now;
      if (f === 'fresh') return r.reps === 0;
      if (f === 'mature') return r.ivl >= 21;
      if (f === 'noted') return !!(r.note || r.myDef);
      return (r.tags || []).includes(f);
    });

    // 重新渲染会换掉挂载节点，旧的虚拟列表要先解绑
    if (wbVList) { wbVList.destroy(); wbVList = null; }
    viewEl('wordbook').innerHTML = Lx.renderWordbook(rows, state.wb.counts, f, state.wb.editor);

    const mount = $('#wbList');
    if (mount) {
      wbVList = new Lx.VirtualList({
        mount,
        scroller: stage(),
        rowHeight: WB_ROW_H,
        render: (r) => Lx.wordbookRow(r),
      });
      wbVList.setItems(rows);
    }
  }

  /**
   * 打开生词本编辑框。
   *
   * 从三个地方进来：生词本行内的按钮、词条页的「写笔记」、
   * 以及「查不到 / 逐词拆解」页上的「加进生词本」。后两种情况
   * 词可能还不在生词本里，也可能词库里压根没有——都要能编。
   */
  async function openWbEditor(word, { lockWord = false } = {}) {
    const w = String(word || '').trim();
    const info = w ? await api.wbGet(w) : null;
    state.wb.editor = {
      open: true,
      word: w,
      lockWord: lockWord && !!w,
      saved: !!info?.saved,
      inDict: !!info?.inDict,
      dictBrief: info?.dictBrief || '',
      phonetic: info?.phonetic || '',
      myDef: info?.row?.my_def || '',
      note: info?.row?.note || '',
    };
    // 从别的页面点进来的要先切到生词本，否则表单在看不见的视图里
    if (state.view !== 'wordbook') { switchView('wordbook'); await loadWordbook(); }
    else paintWordbook();
    // 新词聚焦到单词框，已有的词直接聚焦释义
    ($(state.wb.editor.word ? '#wbDef' : '#wbWord'))?.focus();
  }

  function closeWbEditor() {
    state.wb.editor = null;
    paintWordbook();
  }

  /**
   * 重绘会换掉整块 DOM，正在输入的内容必须先收回 state。
   *
   * 只有当页面上那块表单确实是给当前这个词渲染的时候才回收——
   * 从别的页面点「编辑另一个词」进来时，生词本视图里还留着上一个词的
   * 旧表单，不比对 data-for 就会把旧词的输入写进新词的草稿。
   */
  function captureWbDraft() {
    const ed = state.wb.editor;
    const form = $('#wbForm');
    if (!ed || !form) return;
    if (form.dataset.for !== (ed.word || '')) return;
    ed.word = $('#wbWord')?.value ?? ed.word;
    ed.myDef = $('#wbDef')?.value ?? ed.myDef;
    ed.note = $('#wbNote')?.value ?? ed.note;
  }

  async function saveWbEditor() {
    captureWbDraft();
    const ed = state.wb.editor;
    if (!ed) return;
    const word = String(ed.word || '').trim();
    if (!word) { toast('先填单词或词组'); $('#wbWord')?.focus(); return; }

    /* 走 wb:add 而不是 wb:annotate：前者对已存在的词是「保持并改注释」，
       语义上正好覆盖「新加」和「编辑」两种情况。 */
    const r = await api.wbAdd({ word, note: ed.note || '', myDef: ed.myDef || '' });
    if (!r?.ok) { toast(r?.reason || '保存失败'); return; }
    toast(ed.saved ? `已保存：${word}` : `已加入生词本：${word}`);
    state.wb.editor = null;
    await loadWordbook();
    // 词条页可能正显示这个词，刷一下才能看到新写的内容
    /* 词条页可能正显示这个词，重查一次才能看到新写的内容。
       比对用 state.entry.word——state.word 这个字段不存在。 */
    if (state.entry?.word && state.entry.word.toLowerCase() === word.toLowerCase()) {
      go(word, { push: false });
    }
  }

  async function toggleBookmark(word) {
    if (!word) return;
    const r = await api.wbToggle(word);
    state.saved = r.saved;
    const btn = $('[data-act="bookmark"]');
    if (btn) {
      btn.classList.toggle('is-on', r.saved);
      btn.title = r.saved ? '从生词本移除' : '加入生词本';
    }
    toast(r.saved ? `已加入生词本：${word}` : `已移出生词本：${word}`);
    if (state.view === 'wordbook') loadWordbook();
  }

  function refreshBadge() {
    const btn = $('.nav-btn[data-view="review"]');
    if (!btn) return;
    btn.querySelector('.dot')?.remove();
    const due = state.wb.counts?.due || 0;
    if (due > 0) {
      const d = document.createElement('span');
      d.className = 'dot';
      d.textContent = due > 99 ? '99+' : String(due);
      btn.appendChild(d);
    }
  }

  /* ==================================================================== */
  /*  复习                                                                */
  /* ==================================================================== */

  async function loadReview() {
    const [queue, counts, heat] = await Promise.all([api.wbDue(40), api.wbCounts(), api.heatmap(365)]);
    state.review = {
      queue: Array.isArray(queue) ? queue : [],
      index: 0,
      revealed: false,
      counts,
      heat: Array.isArray(heat) ? heat : [],
    };
    paintReview();
  }

  function paintReview() {
    const { queue, counts, heat } = state.review;
    if (state.review.index >= queue.length) {
      viewEl('review').innerHTML = Lx.renderReview([], counts, state.review, heat);
      return;
    }
    viewEl('review').innerHTML = Lx.renderReview(queue, counts, state.review, heat);
  }

  async function gradeCard(grade) {
    const cur = state.review.queue[state.review.index];
    if (!cur) return;
    const r = await api.wbGrade(cur.card.word, grade);
    if (r && !r.__error) {
      const when = r.ivl >= 30 ? `${Math.round(r.ivl / 30)} 个月后` : r.ivl >= 1 ? `${r.ivl} 天后` : '10 分钟后';
      toast(`${cur.card.word} · 下次 ${when}`, 1400);
    }
    state.review.index++;
    state.review.revealed = false;
    state.review.counts = await api.wbCounts();
    refreshBadge();
    paintReview();
  }

  /* ==================================================================== */
  /*  设置                                                                */
  /* ==================================================================== */

  function renderSettings() {
    viewEl('settings').innerHTML = Lx.renderSettings(state.settings, state.stats, tts.voices);
  }

  async function putSetting(patch) {
    const r = await api.putSettings(patch);
    if (r && r.settings) state.settings = r.settings;
    if (r?.hotkey && r.hotkey.registered === false && state.settings.hotkeyEnabled) {
      toast(`热键注册失败：${r.hotkey.reason || '未知原因'}`, 3200);
    }
    return r;
  }

  /** 把键盘事件转成 Electron 加速键字符串 */
  function accelFrom(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');

    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (/^[a-z]$/.test(key)) key = key.toUpperCase();
    else if (key === 'ArrowUp') key = 'Up';
    else if (key === 'ArrowDown') key = 'Down';
    else if (key === 'ArrowLeft') key = 'Left';
    else if (key === 'ArrowRight') key = 'Right';
    else if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;

    if (!mods.length) return null; // 全局热键必须带修饰键
    return [...mods, key].join('+');
  }

  function startHotkeyRecording() {
    // 值同时充当「是否在录制」与「录给哪个设置项」
    state.recordingHotkey = 'hotkey';
    const btn = $('#hotkeyBtn');
    if (btn) { btn.textContent = '请按下组合键…'; btn.classList.add('btn-accent'); }
  }

  async function finishHotkeyRecording(accel) {
    const target = state.recordingHotkey;
    state.recordingHotkey = false;
    if (accel && target === 'selectionHotkey') {
      await putSetting({ selectionHotkey: accel });
      toast(`划词热键已设为 ${accel}`);
    } else if (accel && target === 'subtitleHotkey') {
      await putSetting({ subtitleHotkey: accel });
      toast(`字幕悬浮窗热键已设为 ${accel}`);
    } else if (accel) {
      const r = await putSetting({ hotkey: accel, hotkeyEnabled: true });
      if (r?.hotkey?.registered) toast(`热键已设为 ${accel}`);
    }
    renderSettings();
  }

  /* ==================================================================== */
  /*  全局键盘                                                            */
  /* ==================================================================== */

  function wireGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      // 录制热键时吞掉所有按键
      if (state.recordingHotkey) {
        e.preventDefault();
        if (e.key === 'Escape') return finishHotkeyRecording(null);
        const a = accelFrom(e);
        if (a) finishHotkeyRecording(a);
        return;
      }

      const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const el = $('#searchInput');
        el.focus();
        el.select();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (state.entry) toggleBookmark(state.entry.word);
        return;
      }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return navBack(); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return navForward(); }

      // 翻译页的多行输入框：Ctrl+Enter 开始翻译（回车要留给换行）
      if (document.activeElement?.id === 'trInput') {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          captureTrDraft();
          runTranslateText(TR().draft);
        }
        return;
      }

      // 拼写题的输入框：回车提交，答完回车进入下一题
      if (inInput && document.activeElement?.id === 'spellInput') {
        if (e.key === 'Enter') {
          e.preventDefault();
          const q = D().quiz;
          if (q?.locked) drillNext();
          else drillSpell();
        }
        return;
      }

      if (inInput) return;

      // 练习视图的快捷键
      if (state.view === 'drill') {
        const d = D();
        if (d.stage === 'study') {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (!d.study.revealed) { d.study.revealed = true; paintDrill(); }
            return;
          }
          if (d.study.revealed && (e.key === '1' || e.key === '2')) {
            e.preventDefault();
            return drillMark(e.key === '2');
          }
          if (e.key.toLowerCase() === 'l') {
            const cur = d.study.list[d.study.i];
            if (cur) { e.preventDefault(); return go(cur.word); }
          }
        }
        if (d.stage === 'quiz') {
          const idx = '1234'.indexOf(e.key) >= 0 ? Number(e.key) - 1 : 'abcd'.indexOf(e.key.toLowerCase());
          if (idx >= 0 && idx < 4) { e.preventDefault(); return drillPick(idx); }
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (d.quiz.locked || (d.quiz.mode === 'assess' && d.quiz.picked != null)) return drillNext();
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          d.stage = d.stage === 'scopes' ? 'scopes' : d.stage === 'menu' ? 'scopes' : 'menu';
          return paintDrill();
        }
      }

      // 复习视图的快捷评分
      if (state.view === 'review') {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          if (!state.review.revealed) { state.review.revealed = true; paintReview(); }
          else gradeCard('good');
          return;
        }
        const map = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
        if (map[e.key] && state.review.revealed) { e.preventDefault(); return gradeCard(map[e.key]); }
      }

      // 单个可打印字符：直接进搜索框，像浏览器的快速查找
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && /[a-zA-Z一-鿿]/.test(e.key)) {
        const el = $('#searchInput');
        el.focus();
        el.value = e.key;
        el.dispatchEvent(new Event('input'));
        e.preventDefault();
      }
    });
  }

  /* ==================================================================== */
  /*  事件委托                                                            */
  /* ==================================================================== */

  function wireDelegation() {
    // 建议项用 mousedown，避免 input 的 blur 先把面板关掉
    document.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.suggest-item');
      if (item) { e.preventDefault(); go(item.dataset.word); }
    });

    document.addEventListener('click', async (e) => {
      const navBtn = e.target.closest('.nav-btn[data-view], [data-view]');
      const actEl = e.target.closest('[data-act]');

      if (actEl) {
        const act = actEl.dataset.act;

        /* 实时字幕的动作都在 Lx.lectureActions 里，别往这个 switch 里堆——
           那边有自己的状态机，混进来只会让两边都难改。 */
        if (Lx.lectureActions?.[act]) return Lx.lectureActions[act](actEl, e);

        switch (act) {
          case 'goto':
            if (actEl.closest('.suggest-item')) return; // 已由 mousedown 处理
            return go(actEl.dataset.word);

          case 'speak': {
            e.stopPropagation();
            return tts.speak(actEl.dataset.text, actEl.dataset.accent || 'us', actEl);
          }

          case 'bookmark':
            return toggleBookmark(state.entry?.word);

          case 'copy':
            if (state.entry) {
              await navigator.clipboard.writeText(state.entry.word);
              toast('已复制：' + state.entry.word);
            }
            return;

          case 'back': return navBack();
          case 'forward': return navForward();
          case 'toggle-theme': return toggleTheme();

          case 'random': {
            const w = await api.random();
            if (w) go(w);
            return;
          }

          case 'unfold': {
            // 展开该词性分组里被折叠的义项，然后把按钮自己移除
            const group = actEl.closest('.pos-group');
            if (group) {
              $$('.sense.is-folded', group).forEach((el) => el.classList.remove('is-folded'));
              actEl.remove();
            }
            return;
          }

          case 'jump-pos': {
            const target = $(`.pos-group[data-pos-group="${actEl.dataset.pos}"]`);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
              target.classList.remove('is-target');
              // 强制重排以便重复点击时动画能再次触发
              void target.offsetWidth;
              target.classList.add('is-target');
            }
            return;
          }

          /* ---- 考纲练习 ---- */
          case 'drill-scope': return drillPickScope(actEl.dataset.scope);
          case 'drill-back': {
            D().stage = 'scopes';
            return paintDrill();
          }
          case 'drill-menu': {
            const d = D();
            d.stage = d.scope ? 'menu' : 'scopes';
            d.progress = d.scope ? await api.drillProgress(d.scope) : null;
            return paintDrill();
          }
          case 'drill-kind': {
            const d = D();
            const k = actEl.dataset.kind;
            if (d.kinds.includes(k)) {
              if (d.kinds.length > 1) d.kinds = d.kinds.filter((x) => x !== k);
              else return toast('至少要留一种题型');
            } else d.kinds.push(k);
            return paintDrill();
          }
          case 'drill-start':
            if (actEl.classList.contains('is-disabled')) return;
            return drillStart(actEl.dataset.mode, Number(actEl.dataset.count) || undefined);
          case 'drill-reveal':
            D().study.revealed = true;
            return paintDrill();
          case 'drill-mark': return drillMark(actEl.dataset.known === '1');
          case 'drill-pick': return drillPick(Number(actEl.dataset.i));
          case 'drill-spell': return drillSpell();
          case 'drill-next': return drillNext();

          /* ---- 自定义词表 ---- */
          case 'cu-tab': {
            captureCustomDraft();
            CU().tab = actEl.dataset.tab;
            return paintCustom();
          }

          case 'cl-preview': {
            captureCustomDraft();
            CU().preview = await api.listPreview(CU().draftText || '');
            return paintCustom();
          }

          case 'cl-file': {
            const r = await api.listImportFile();
            if (!r?.ok) { if (r?.reason && r.reason !== '已取消') toast(r.reason); return; }
            const cu = CU();
            cu.draftText = r.text;
            cu.draftName = cu.draftName || r.name;
            cu.preview = await api.listPreview(r.text);
            return paintCustom();
          }

          case 'cl-create': {
            captureCustomDraft();
            const cu = CU();
            const r = await api.listCreate(cu.draftName || '未命名词表', cu.draftText || '');
            if (!r?.ok) { toast(r?.reason || '创建失败'); return; }
            toast(`已创建词表，收录 ${r.count} 个词`);
            cu.draftName = '';
            cu.draftText = '';
            cu.preview = null;
            D().scopes = []; // 练习页的范围列表要重新拉
            return loadCustom();
          }

          case 'cl-del': {
            const r = await api.listDelete(Number(actEl.dataset.id));
            if (r?.ok) { toast('词表已删除'); D().scopes = []; }
            return loadCustom();
          }

          /* ---- 自定义词条 ---- */
          case 'ce-save': {
            captureCustomDraft();
            const r = await api.customPut(CU().draft);
            if (!r?.ok) { toast(r?.reason || '保存失败'); return; }
            toast(`已保存：${r.word}`);
            CU().draft = {};
            return loadCustom();
          }

          case 'ce-edit': {
            const e = CU().entries.find((x) => x.word === actEl.dataset.word);
            if (e) CU().draft = { ...e };
            return paintCustom();
          }

          case 'ce-cancel':
            CU().draft = {};
            return paintCustom();

          case 'ce-del': {
            await api.customDelete(actEl.dataset.word);
            toast('已删除');
            return loadCustom();
          }

          /* ---- 术语表 ---- */
          case 'gl-save': {
            captureCustomDraft();
            const r = await api.glossPut(CU().gDraft);
            if (!r?.ok) { toast(r?.reason || '保存失败'); return; }
            /* 探测在主进程后台跑（要问一次模型，一秒多），这里不等它。
               所以刚加完那条的「模型会译成」是空的，稍后自己会填上。 */
            toast('已加入术语表，正在问模型它会怎么错译…');
            CU().gDraft = {};
            await loadCustom();
            // 给探测留点时间再刷一次，用户就能看到错译写法出现
            setTimeout(() => { if (CU().tab === 'gloss') refreshTerms(); }, 2500);
            return;
          }

          case 'gl-edit': {
            const t = CU().terms.find((x) => x.term === actEl.dataset.term);
            if (t) CU().gDraft = { term: t.surface || t.term, zh: t.zh, note: t.note || '', editing: true };
            return paintCustom();
          }

          case 'gl-cancel':
            CU().gDraft = {};
            return paintCustom();

          case 'gl-del': {
            await api.glossDelete(actEl.dataset.term);
            toast('已删除');
            return loadCustom();
          }

          case 'gl-import':
          case 'gl-import-replace': {
            captureCustomDraft();
            const replace = act === 'gl-import-replace';
            const r = await api.glossImport(CU().gText || '', replace);
            // 覆盖导入会弹原生对话框确认，取消时走这里
            if (!r?.ok) { if (r?.reason !== '已取消') toast(r?.reason || '导入失败'); return; }
            toast(`已导入 ${r.count} 条${r.skipped ? `，跳过 ${r.skipped} 行` : ''}`);
            CU().gText = '';
            await loadCustom();
            // 几十条要探几十秒，隔一会儿刷一次让进度可见
            setTimeout(() => { if (CU().tab === 'gloss') refreshTerms(); }, 5000);
            return;
          }

          case 'gl-reprobe': {
            toast('正在重新问模型，条目多的话要等一会儿…');
            const r = await api.glossReprobe();
            if (!r?.ok) { toast(r?.reason || '探测失败'); return; }
            toast('探测完成');
            return loadCustom();
          }

          case 'drill-scope': {
            switchView('drill');
            await loadDrill();
            return drillPickScope(actEl.dataset.scope);
          }

          /* ---- 翻译 ---- */
          case 'mt-run': return runMachineTranslation(actEl.dataset.text);
          case 'mt-long': return runSentenceTranslation(actEl.dataset.text);

          case 'tr-run': {
            captureTrDraft();
            return runTranslateText(TR().draft);
          }

          case 'tr-clear': {
            const t = TR();
            t.draft = '';
            t.result = null;
            t.terms = [];
            paintTranslate();
            $('#trInput')?.focus();
            return;
          }

          case 'tr-copy': {
            // 只复制译文：想要双语对照的话页面上就有，复制过去多半是要贴进笔记
            const out = $$('.tr-out').map((el) => el.textContent.trim()).join('');
            if (!out) return;
            await navigator.clipboard.writeText(out);
            return toast('译文已复制');
          }

          /* ---- 设置 ---- */

          case 'sel-mode':
            await putSetting({ selectionMode: actEl.dataset.v });
            return renderSettings();

          case 'record-sel-hotkey':
            state.recordingHotkey = 'selectionHotkey';
            actEl.textContent = '请按下组合键…';
            actEl.classList.add('btn-accent');
            return;

          case 'asr-model':
            await putSetting({ asrModel: actEl.dataset.v });
            return renderSettings();

          case 'mt-model':
            await putSetting({ mtModel: actEl.dataset.v });
            // 换了模型要重新问一次可用性，长句页那边靠它决定给不给入口
            state.mt = await api.mtStatus().catch(() => state.mt);
            state.stats = await api.stats();
            return renderSettings();

          case 'lec-format': {
            /* 多选：点一下切换。至少留一种，否则一节课下来什么都没有
               （流水账还在，但用户得自己去点「恢复」才能拿到成品）。 */
            const k = actEl.dataset.v;
            const cur = [...(state.settings.lectureFormats || [])];
            const at = cur.indexOf(k);
            if (at >= 0) {
              if (cur.length === 1) return toast('至少要留一种记录格式');
              cur.splice(at, 1);
            } else cur.push(k);
            await putSetting({ lectureFormats: cur });
            return renderSettings();
          }

          case 'sub-open':
            await api.subToggle(true);
            return;

          case 'sub-lines':
            await putSetting({ subtitleLines: Number(actEl.dataset.v) });
            return renderSettings();

          case 'record-sub-hotkey':
            state.recordingHotkey = 'subtitleHotkey';
            actEl.textContent = '请按下组合键…';
            actEl.classList.add('btn-accent');
            return;

          case 'lec-mt-model':
            await putSetting({ lectureMtModel: actEl.dataset.v });
            return renderSettings();

          case 'lec-silence':
            await putSetting({ lectureSilenceMs: Number(actEl.dataset.v) });
            return renderSettings();

          case 'tts-test':
            return tts.speak('Lexica, your offline dictionary.', 'us', actEl);

          case 'font-scale':
            await putSetting({ fontScale: Number(actEl.dataset.v) });
            applyFontScale();
            return renderSettings();

          case 'goal-step': {
            const key = actEl.dataset.key;
            const next = Math.max(0, Math.min(500, (Number(state.settings[key]) || 0) + Number(actEl.dataset.d)));
            await putSetting({ [key]: next });
            return renderSettings();
          }

          case 'backup-export': {
            const r = await api.backupExport();
            if (r?.ok) {
              toast(`已备份 ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
              api.wbRevealExport(r.filePath);
            } else if (r?.reason && r.reason !== '已取消') toast(r.reason);
            return;
          }

          case 'backup-import': {
            const r = await api.backupImport();
            if (!r?.ok && r?.reason && r.reason !== '已取消') toast(r.reason);
            return;
          }

          case 'custom-open': return switchView('custom');
          case 'open-log': return api.openLog();

          case 'drill-export': {
            const r = await api.drillExport(actEl.dataset.scope || null);
            if (r?.ok) {
              toast(`已导出 ${r.scopes} 个范围、${r.weak} 条错题`);
              api.wbRevealExport(r.filePath);
            } else if (r?.reason && r.reason !== '已取消') {
              toast(r.reason);
            }
            return;
          }

          case 'wb-filter':
            captureWbDraft();
            state.wb.filter = actEl.dataset.filter;
            return paintWordbook();

          case 'wb-remove': {
            e.stopPropagation();
            const w = actEl.dataset.word;
            await api.wbRemove(w);
            toast('已移出生词本：' + w);
            return loadWordbook();
          }

          /* ---- 生词本的自有释义与笔记 ---- */
          case 'wb-edit':
            e.stopPropagation();   // 行本身是「跳转到词条」，别一起触发
            return openWbEditor(actEl.dataset.word, { lockWord: true });

          case 'wb-new':
            return openWbEditor('', { lockWord: false });

          case 'wb-save': return saveWbEditor();
          case 'wb-cancel': return closeWbEditor();

          case 'wb-drop': {
            const w = actEl.dataset.word;
            await api.wbRemove(w);
            toast('已移出生词本：' + w);
            state.wb.editor = null;
            return loadWordbook();
          }

          case 'reveal':
            state.review.revealed = true;
            return paintReview();

          case 'grade':
            return gradeCard(actEl.dataset.grade);

          case 'theme':
            applyTheme(actEl.dataset.theme);
            await putSetting({ theme: actEl.dataset.theme });
            return renderSettings();

          case 'toggle': {
            const key = actEl.dataset.key;
            await putSetting({ [key]: !state.settings[key] });
            return renderSettings();
          }

          case 'record-hotkey':
            return startHotkeyRecording();

          case 'export-csv':
          case 'export-anki': {
            const r = await api.wbExport(act === 'export-anki' ? 'anki' : 'csv');
            if (r?.ok) {
              toast(`已导出 ${r.count} 个词`);
              api.wbRevealExport(r.filePath);
            } else if (r?.reason && r.reason !== '已取消') {
              toast(r.reason);
            }
            return;
          }

          case 'clear-history':
            await api.clearHistory();
            toast('查询历史已清空');
            return;

          case 'open-data': return api.openDataFolder();
          case 'relaunch': return api.relaunch();
        }
      }

      if (navBtn?.dataset.view) return switchView(navBtn.dataset.view);

      if (e.target.closest('#clearBtn')) {
        const el = $('#searchInput');
        el.value = '';
        $('#clearBtn').classList.add('hidden');
        closeSuggest();
        el.focus();
        return renderHome();
      }
    });

    /* 翻译页的字数统计。只改那一行文字，不重绘——
       重绘会换掉 textarea，光标位置和输入法状态都会丢。 */
    document.addEventListener('input', (e) => {
      if (e.target.id === 'lecTitle') {
        Lx.lectureActions?.['lec-title']?.(e.target);
        return;
      }
      if (e.target.id !== 'trInput') return;
      TR().draft = e.target.value;
      const c = $('#trCount');
      if (c) c.textContent = `${e.target.value.length} 字符`;
    });

    // 设置页的滑块与下拉
    document.addEventListener('change', async (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      if (el.dataset.act === 'rate') {
        tts.rate = Number(el.value);
        await putSetting({ ttsRate: tts.rate });
        const desc = el.closest('.set-row')?.querySelector('.set-desc');
        if (desc) desc.textContent = `当前 ${tts.rate.toFixed(2)} 倍`;
      }
      if (el.dataset.act === 'asr-prompt') {
        /* 用 change 而不是 input：改提示词要重启识别服务，
           每敲一个字重启一次显然不行，失焦时保存一次就够。 */
        await putSetting({ asrPrompt: el.value });
        return;
      }
      if (el.dataset.act === 'voice') {
        await putSetting({ ttsVoice: el.value || null });
        tts.speak('This is the selected voice.', 'us');
      }
    });
  }

  /* ==================================================================== */

  /* 截图脚本用的钩子，只在主进程设了 LEXICA_SHOT 时才有意义；
     正常运行时挂着也无害，不暴露任何越权能力。 */
  window.__lexicaShot = {
    /* 词库就绪没有？go() 在 state.stats.ready 为假时直接 return，
       shot 流程原先固定等 1600ms 就去查词，机器慢一点就会静默落空——
       第一张截图是首页、第一条布局断言跟着误报。 */
    ready: () => !!state.stats?.ready,

    async startSpellQuiz() {
      switchView('drill');
      await loadDrill();
      await drillPickScope('toefl');
      const d = D();
      const kinds = d.kinds;
      d.kinds = ['spell'];
      await drillStart('quiz', 10);
      /* 用完就还回去。kinds 只在出题那一刻用得到，题已经出好了。
         留着不还的话，这个筛选此后一直是「只考拼写」——后面截图里的自测
         全会变成输入题，.q-opt 根本不存在。 */
      d.kinds = kinds;
    },
  };

  window.addEventListener('DOMContentLoaded', boot);
})(window.Lx);
