'use strict';
/**
 * window.lexica 的安卓实现。
 *
 * 桌面版这层是 preload + 主进程 IPC；这里把同样的接口在 WebView 里就地实现，
 * 底下压的是同一份 DictDB / UserDB / Quiz。渲染层（app.js、views.js…）因此
 * 完全不需要知道自己跑在哪个平台上。
 *
 * 与桌面版的差异集中在两处，都是平台本身的限制：
 *   - 没有全局热键 / 托盘 / 悬浮窗：手机上取词靠「分享 / 处理文本」的系统菜单
 *   - 文件读写要走系统的分享与文档选择器，不能直接给路径
 */
(function (g) {
  const { DictDB, setDatabaseOpener } = g.__cjs.require('dict-db');
  const { UserDB } = g.__cjs.require('user-db');
  const { Quiz, SCOPE_LABELS, KIND_LABELS, checkSpelling } = g.__cjs.require('quiz');
  const { parseTranslation } = g.__cjs.require('dict-db');

  const App = g.AndroidApp;

  /* 词库连接由 Activity 建好，这里只是把同一个桥包一层 */
  setDatabaseOpener((file) => new g.AndroidSQLite.DatabaseSync(file));

  const DEFAULTS = {
    theme: 'paper',
    ttsRate: 0.95,
    ttsVoice: null,
    showAside: true,
    fontScale: 1,
    dailyNew: 10,
    dailyReviews: 30,
    dailyQuiz: 20,
    mtAuto: true,
    drillScope: 'cet4',
  };

  const dict = new DictDB('dict.db');
  const user = new UserDB('');
  const quiz = new Quiz(dict);
  quiz.setCustomSource({
    lists: () => user.lists(),
    words: (id) => user.listWords(id),
  });

  const opened = dict.open();
  const settings = user.allSettings(DEFAULTS);

  if (!opened) console.error('[dict] 打开失败：', dict.error);

  /* ==================================================================== */
  /*  事件                                                                */
  /* ==================================================================== */

  const listeners = Object.create(null);
  const on = (name, fn) => {
    (listeners[name] ||= new Set()).add(fn);
    return () => listeners[name].delete(fn);
  };
  const emit = (name, payload) => {
    for (const fn of listeners[name] || []) {
      try { fn(payload); } catch (e) { console.error(`[emit:${name}]`, e); }
    }
  };

  /* ==================================================================== */
  /*  词条包装                                                            */
  /* ==================================================================== */

  /** 把用户自建词条包装成和内置词条一样的结构，渲染层就不用写第二套逻辑 */
  const customAsEntry = (row) => ({
    id: -1,
    word: row.word,
    wkey: row.word,
    isCustom: true,
    note: row.note || null,
    lemmaOf: null,
    weak: false,
    phon: row.phonetic ? { main: row.phonetic, variants: [], us: null } : null,
    phonetic: row.phonetic || null,
    translation: parseTranslation(row.translation),
    translationRaw: row.translation,
    definition: [],
    posRatio: [],
    forms: [],
    tags: [],
    collins: 0,
    oxford: false,
    bnc: 0,
    frq: 0,
    rank: 999999,
    senses: [],
    examples: [],
    examplesByPos: {},
    relations: { synonyms: [], antonyms: [], hypernyms: [], hyponyms: [] },
    etym: null,
    quotes: [],
    confusables: [],
  });

  /* ==================================================================== */
  /*  导出：手机上没有「保存对话框」，一律交给系统分享                    */
  /* ==================================================================== */

  const stamp = () => new Date().toISOString().slice(0, 10);

  /** @returns {{ok:boolean, filePath?:string, reason?:string}} */
  function shareText(filename, content) {
    const r = JSON.parse(App.saveAndShare(filename, content));
    return r.ok ? { ok: true, filePath: r.path } : { ok: false, reason: r.error };
  }

  function buildWordbookExport(words, isAnki) {
    const brief = dict.briefMany(words.map((w) => w.word));
    const esc = (s) => {
      const v = String(s ?? '');
      return isAnki ? v.replace(/[\t\n\r]+/g, ' ') : `"${v.replace(/"/g, '""')}"`;
    };
    const sep = isAnki ? '\t' : ',';
    const lines = [];
    if (!isAnki) {
      lines.push(['单词', '音标', '释义', '难度标签', '加入时间', '复习次数'].map(esc).join(sep));
    }
    for (const w of words) {
      const b = brief.get(String(w.word).toLowerCase());
      lines.push([
        w.word,
        b?.phonetic || '',
        b?.brief || '',
        (b?.tags || []).map((t) => t.label).join(' '),
        new Date(w.added_at).toISOString().slice(0, 10),
        w.reps,
      ].map(esc).join(sep));
    }
    // Excel 打开 CSV 需要 BOM 才认得出 UTF-8
    return (isAnki ? '' : '﻿') + lines.join('\r\n');
  }

  /* ==================================================================== */
  /*  接口表                                                              */
  /* ==================================================================== */

  /* 每个方法都是同步实现，最后统一包成 Promise：渲染层写的是 await，
     而且 app.js 里有 `api.mtStatus().catch(...)`，必须真的返回 Promise。 */
  const impl = {
    /* ---- 词典 ---- */
    stats: () => ({
      ...dict.stats(),
      counts: user.counts(),
      settings,
      customCount: user.customCount(),
      mtAvailable: false,
      platform: 'android',
      appVersion: App.version(),
    }),

    lookup: (word, opts) => {
      const custom = user.customEntry(word);
      if (custom) {
        if (!opts?.noHistory) user.pushHistory(custom.word);
        const built = dict.lookup(word);
        return {
          status: 'ok',
          entry: customAsEntry(custom),
          alsoBuiltin: built.status === 'ok' ? built.entry.word : null,
          saved: user.isSaved(custom.word),
          mine: user.entry(custom.word),
          corrections: [],
          weak: false,
        };
      }
      const res = dict.lookup(word);
      if (res.status === 'ok') {
        if (!opts?.noHistory) user.pushHistory(res.entry.word);
        res.saved = user.isSaved(res.entry.word);
        // 生词本上的笔记与自有释义，词条页要单独排一块
        res.mine = user.entry(res.entry.word);
      }
      return res;
    },

    suggest: (q, limit) => {
      const res = dict.suggest(q, limit);
      const mine = user.customPrefix(q, 5);
      if (mine.length) {
        res.groups.unshift({
          kind: 'custom',
          title: '我的词条',
          items: mine.map((r) => ({
            word: r.word,
            phonetic: r.phonetic,
            brief: r.translation.slice(0, 60),
            tags: [],
            collins: 0,
            oxford: false,
          })),
        });
      }
      return res;
    },

    search: (q, limit) => dict.search(q, limit),
    random: () => dict.randomWord(),
    /* 句中术语抽取是纯 SQL，安卓上照样能用——长句查不出释义时，
       这份术语表就是唯一能给的可靠信息（翻译模型没打进包）。 */
    sentenceTerms: (text) => dict.termsIn(text),

    /* ---- 生词本 ---- */
    wbToggle: (word) => {
      const r = user.toggle(word);
      emit('wb:changed', user.counts());
      return r;
    },
    wbIsSaved: (word) => user.isSaved(word),
    wbList: (opts) => {
      const rows = user.list(opts);
      const brief = dict.briefMany(rows.map((r) => r.word));
      return rows.map((row) => {
        const b = brief.get(String(row.word).toLowerCase());
        const mine = user.customEntry(row.word);
        return {
          ...row,
          myDef: row.my_def || null,
          phonetic: b?.phonetic || mine?.phonetic || null,
          // 列表只有一行，优先显示自己写的（和桌面版一致）
          brief: row.my_def || b?.brief || mine?.translation || '',
          inDict: !!b,
          tags: b?.tags.map((t) => t.code) || [],
          collins: b?.collins || 0,
        };
      });
    },

    /* ---- 生词本的自有释义与笔记 ----
       安卓用的是同一个 UserDB，所以这几个接口是真实现，不是桩。 */
    wbGet: (word) => {
      const row = user.entry(word);
      const b = dict.briefMany([word]).get(String(word || '').toLowerCase());
      return {
        row: row || null,
        saved: !!row,
        dictBrief: b?.brief || null,
        phonetic: b?.phonetic || null,
        inDict: !!b,
      };
    },
    wbAdd: (payload) => {
      const r = user.addWord(payload?.word, { note: payload?.note, myDef: payload?.myDef });
      if (r.ok) emit('wb:changed', user.counts());
      return r;
    },
    wbAnnotate: (payload) => {
      const r = user.annotate(payload?.word, { note: payload?.note, myDef: payload?.myDef });
      if (r.ok) emit('wb:changed', user.counts());
      return r;
    },
    wbRemove: (word) => {
      const r = user.remove(word);
      emit('wb:changed', user.counts());
      return r;
    },

    wbCounts: () => user.counts(),
    wbDue: (limit) => user.dueQueue(limit).map((row) => {
      const r = dict.lookup(row.word, { noHistory: true });
      // 自己加的词组词库里查不到，用自建词条兜一层，否则复习卡是空的
      let entry = r.status === 'ok' ? r.entry : null;
      if (!entry) {
        const mine = user.customEntry(row.word);
        if (mine) entry = customAsEntry(mine);
      }
      return { card: row, entry, myDef: row.my_def || null, note: row.note || null };
    }),
    wbGrade: (word, grade) => {
      const r = user.grade(word, grade);
      emit('wb:changed', user.counts());
      return r;
    },
    wbExport: (format) => {
      const words = user.allWords();
      if (!words.length) return { ok: false, reason: '生词本还是空的' };
      const isAnki = format === 'anki';
      const r = shareText(
        `lexica-wordbook-${stamp()}.${isAnki ? 'tsv' : 'csv'}`,
        buildWordbookExport(words, isAnki),
      );
      return r.ok ? { ...r, count: words.length } : r;
    },
    // 桌面版这里是「在资源管理器里定位文件」；手机上分享面板已经弹过了，无事可做
    wbRevealExport: () => {},

    /* ---- 考纲练习 ---- */
    drillScopes: () => quiz.scopes().map((s) => ({ ...s, progress: user.scopeProgress(s.scope) })),
    drillProgress: (scope) => user.scopeProgress(scope),
    drillStudy: (scope, count) => quiz.studyBatch(scope, count),
    drillQuiz: (scope, count, kinds) => quiz.batch(scope, count, { kinds }),
    drillAssess: (scope, count) => quiz.assessmentBatch(scope, count),
    drillAnswer: (payload) => { user.recordAnswer(payload); return { ok: true }; },
    drillFinish: (payload) => { user.saveSession(payload); return user.scopeProgress(payload.scope); },
    drillMark: (word, scope, known) => {
      user.markWord(word, scope, known);
      if (!known && !user.isSaved(word)) {
        user.toggle(word);
        emit('wb:changed', user.counts());
      }
      return { ok: true, saved: user.isSaved(word) };
    },
    drillWeak: (scope, limit) => user.weakWords(scope, limit).map((r) => {
      const res = dict.lookup(r.word, { noHistory: true });
      return { ...r, entry: res.status === 'ok' ? res.entry : null };
    }),
    drillWeakQuiz: (scope, count) => {
      const rows = user.weakWords(scope, count * 3);
      const out = [];
      for (const r of rows) {
        if (out.length >= count) break;
        const row = dict.q.exact.get(String(r.word).toLowerCase());
        if (!row) continue;
        for (const kind of ['en2zh', 'zh2en', 'cloze']) {
          const q = quiz.makeQuestion(scope, row, kind);
          if (q) { out.push(q); break; }
        }
      }
      return out;
    },
    drillLabels: () => ({ scopes: SCOPE_LABELS, kinds: KIND_LABELS }),
    drillCheckSpell: (input, answer) => checkSpelling(input, answer),

    drillExport: (onlyScope) => {
      const scopes = quiz.scopes().filter((s) => !onlyScope || s.scope === onlyScope);
      if (!scopes.length) return { ok: false, reason: '没有可导出的范围' };

      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [];
      let weakTotal = 0;

      lines.push('# 范围汇总');
      lines.push(['范围', '可练词量', '已掌握', '待巩固', '累计答题', '正确率', '上次检测掌握率', '检测时间']
        .map(esc).join(','));
      for (const s of scopes) {
        const p = user.scopeProgress(s.scope);
        lines.push([
          s.label, s.quizzable, p.mastered, p.shaky, p.answered,
          p.accuracy == null ? '' : `${Math.round(p.accuracy * 100)}%`,
          p.lastAssessment ? `${Math.round(p.lastAssessment.rate * 100)}%` : '',
          p.lastAssessment ? new Date(p.lastAssessment.at).toLocaleString('zh-CN') : '',
        ].map(esc).join(','));
      }

      lines.push('');
      lines.push('# 错题明细');
      lines.push(['范围', '单词', '音标', '释义', '答题次数', '答对', '答错', '难度标签'].map(esc).join(','));
      for (const s of scopes) {
        const weak = user.weakWords(s.scope, 500);
        const brief = dict.briefMany(weak.map((w) => w.word));
        for (const w of weak) {
          const b = brief.get(String(w.word).toLowerCase());
          lines.push([
            s.label, w.word, b?.phonetic || '', b?.brief || '',
            w.seen, w.hit, w.miss, (b?.tags || []).map((t) => t.label).join(' '),
          ].map(esc).join(','));
          weakTotal++;
        }
      }

      const name = onlyScope ? `lexica-${onlyScope}` : 'lexica-练习进度';
      const r = shareText(`${name}-${stamp()}.csv`, `﻿${lines.join('\r\n')}`);
      return r.ok ? { ...r, scopes: scopes.length, weak: weakTotal } : r;
    },

    /* ---- 自定义词表与词条 ---- */
    lists: () => user.lists(),
    listCreate: (name, text, note) => {
      const r = user.createList(name, text, note);
      if (r.ok) quiz.invalidateCustom();
      return r;
    },
    listDelete: (id) => {
      const r = user.deleteList(id);
      if (r.ok) quiz.invalidateCustom();
      return r;
    },
    listPreview: (text) => {
      // 导入前先告诉用户：解析出多少词、词库里能查到多少
      const words = [];
      const seen = new Set();
      for (const line of String(text || '').split(/\r?\n/)) {
        const w = line.split(/[\t,，;；]/)[0].trim().replace(/^[-*•\d.、)\s]+/, '').trim();
        if (!w || w.startsWith('#') || w.length > 64) continue;
        const k = w.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        words.push(k);
      }
      /* 先用一次批量查把绝大多数词判掉，剩下的才逐个走 lookup()。
         lookup() 能处理变形与拼写纠错，但每个词都要查十几张表——
         导入几千行的词表时，全走 lookup 会卡住整个界面。 */
      const brief = dict.briefMany(words);
      let known = 0;
      const missing = [];
      for (const w of words) {
        if (brief.has(w) || dict.lookup(w, { noHistory: true }).status === 'ok') known++;
        else if (missing.length < 12) missing.push(w);
      }
      return { total: words.length, known, missing };
    },
    listImportFile: () => ({ ok: false, reason: '__pick__' }), // 见下面的异步覆写

    customAll: (limit) => user.customEntries(limit || 500),
    customGet: (word) => user.customEntry(word),
    customPut: (entry) => user.putCustomEntry(entry),
    customDelete: (word) => user.deleteCustomEntry(word),

    /* ---- 术语表：安卓版没有翻译模型，这套接口也就没有对象可修 ----
       界面那边按 mtStatus().available 把这个 tab 藏了，正常不会走到这里。
       接口仍要留全：渲染层是同一份源码，preload 少一个方法就会抛。 */
    glossAll: () => [],
    glossPut: () => ({ ok: false, reason: '安卓版未内置翻译模型' }),
    glossDelete: () => ({ ok: true }),
    glossImport: () => ({ ok: false, reason: '安卓版未内置翻译模型' }),
    glossReprobe: () => ({ ok: false, reason: '安卓版未内置翻译模型' }),

    /* ---- 机器翻译 ---- */
    mtStatus: () => ({
      available: false,
      caveat: '机器翻译，专业术语可能不准',
      reason: '安卓版未内置翻译模型（模型约 90MB，且手机上 WASM 推理很慢）。查不到的词组会给出逐词拆解。',
    }),
    mtTranslate: () => ({ ok: false, reason: '安卓版未内置翻译模型' }),
    mtTranslateLong: () => ({ ok: false, reason: '安卓版未内置翻译模型' }),

    /* ---- 实时字幕：安卓版没有 ----
       whisper.cpp 要换成 Android 的 ABI 重新编，而且手机 CPU 上
       base 模型跑不到实时。接口留着并明确回不支持，渲染层就不会崩。 */
    asrStatus: () => ({ available: false, models: [], mtModels: [], recording: false,
      reason: '安卓版没有内置语音识别' }),
    lecStart: () => ({ ok: false, reason: '安卓版没有内置语音识别' }),
    lecFeed: () => {},
    // 滚动字幕也依赖识别，安卓上没有
    lecPartial: () => {},
    lecStop: () => ({ ok: false, reason: '安卓版没有内置语音识别' }),
    lecList: () => [],
    lecOpen: () => {},
    lecReveal: () => {},
    lecRecover: () => ({ ok: false, reason: '安卓版没有内置语音识别' }),
    lecPickAudio: () => ({ ok: false, reason: '安卓版没有内置语音识别' }),
    lecTranscribeFile: () => ({ ok: false, reason: '安卓版没有内置语音识别' }),
    lecSelfTestFeed: () => ({ error: '安卓版没有内置语音识别' }),
    // 视频字幕悬浮窗是桌面独有的（安卓上没有置顶悬浮窗这套东西）
    subStart: () => ({ ok: false, reason: '安卓版没有这个功能' }),
    subStop: () => ({ ok: true }),
    subHide: () => {},
    subToggle: () => false,
    subSetLocked: () => false,

    /* ---- 目标、统计、历史 ---- */
    goalProgress: () => user.goalProgress(settings),
    heatmap: (days) => user.heatmap(days),
    recent: (limit) => user.recent(limit),
    clearHistory: () => { user.clearHistory(); return { ok: true }; },

    /* ---- 备份 ---- */
    backupExport: () => {
      const r = JSON.parse(App.backupUserDb(`lexica-backup-${stamp()}.db`));
      return r.ok ? { ok: true, filePath: r.path, bytes: r.bytes } : { ok: false, reason: r.error };
    },
    backupImport: () => ({ ok: false, reason: '__pick__' }), // 见下面的异步覆写

    /* ---- 设置 ---- */
    getSettings: () => settings,
    putSettings: (patch) => {
      const before = { ...settings };
      Object.assign(settings, patch);
      for (const [k, v] of Object.entries(patch)) user.setSetting(k, v);
      if (patch.theme && patch.theme !== before.theme) {
        App.setTheme(patch.theme);          // 同步系统栏配色
        emit('set:theme', { theme: patch.theme });
      }
      return { settings, hotkey: null };
    },

    /* ---- 平台相关：桌面版是打开文件夹 / 重启，手机上给等价行为 ---- */
    openDataFolder: () => { App.toast(`数据目录：${App.dataDir()}`); },
    openLog: () => {
      const r = JSON.parse(App.shareLog());
      if (!r.ok) App.toast(r.error || '暂时没有日志');
    },
    relaunch: () => App.restart(),

    /* ---- 悬浮窗：手机上没有，留空实现让渲染层不必分支 ---- */
    quickHide: () => {},
    quickToMain: (word) => { emit('nav:lookup', { word }); },

    /* ---- 事件订阅 ---- */
    onLookup: (fn) => on('nav:lookup', fn),
    onView: (fn) => on('nav:view', fn),
    onTheme: (fn) => on('set:theme', fn),
    onWordbookChanged: (fn) => on('wb:changed', fn),
    onQuickOpen: (fn) => on('quick:open', fn),
    // 没有翻译模型就没有进度可报，但订阅必须存在，否则渲染层启动就崩
    onMtProgress: (fn) => on('mt:progress', fn),
    onSubToggle: (fn) => on('sub:toggle', fn),
    onLecSegment: (fn) => on('lec:segment', fn),
    onLecPartial: (fn) => on('lec:partial', fn),
    onLecTranslated: (fn) => on('lec:translated', fn),
    onLecWarn: (fn) => on('lec:warn', fn),
    onLecImportProgress: (fn) => on('lec:importProgress', fn),
  };

  /* ==================================================================== */
  /*  包装成 Promise + 错误兜底                                            */
  /* ==================================================================== */

  const ON = /^on[A-Z]/;
  const api = {};
  for (const [name, fn] of Object.entries(impl)) {
    if (ON.test(name)) { api[name] = fn; continue; }  // 订阅函数要同步返回退订器
    api[name] = async (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        console.error(`[api:${name}]`, err);
        App.appendLog(`[api:${name}] ${err && err.stack ? err.stack : err}`);
        // 与桌面版的 IPC 包装保持一致：渲染层统一检查 __error
        return { __error: err.message || String(err) };
      }
    };
  }

  /* ---- 需要系统文档选择器的两个，只能异步 ---- */

  let pickResolve = null;
  /** Kotlin 侧选完文件后回调这里 */
  g.__lexicaFilePicked = (json) => {
    const fn = pickResolve;
    pickResolve = null;
    if (fn) fn(JSON.parse(json));
  };

  const pickFile = (mode) => new Promise((resolve) => {
    if (pickResolve) return resolve({ ok: false, reason: '已有一个选择器在等待' });
    pickResolve = resolve;
    App.pickFile(mode);
  });

  api.listImportFile = async () => {
    const r = await pickFile('text');
    if (!r.ok) return { ok: false, reason: r.error || '已取消' };
    return { ok: true, text: r.text, name: (r.name || '').replace(/\.[^.]+$/, '') };
  };

  api.backupImport = async () => {
    const r = await pickFile('db');
    if (!r.ok) return { ok: false, reason: r.error || '已取消' };
    // 恢复要整库替换，替换完必须重启才能重新打开连接
    const done = JSON.parse(App.restoreUserDb(r.uri));
    if (!done.ok) return { ok: false, reason: done.error };
    App.toast('已恢复，正在重启…');
    setTimeout(() => App.restart(), 600);
    return { ok: true };
  };

  g.lexica = api;

  /* ==================================================================== */
  /*  Activity 调进来的入口                                               */
  /* ==================================================================== */

  /** 别的应用「分享到 Lexica」或用「处理文本」菜单进来 */
  g.__lexicaLookup = (word) => emit('nav:lookup', { word });

  /* 启动时先把可能已经排队的取词请求取走：Activity 可能在页面加载完成前就收到了 intent */
  g.addEventListener('DOMContentLoaded', () => {
    const pending = App.takePendingText();
    if (pending) setTimeout(() => emit('nav:lookup', { word: pending }), 60);
  });

  console.log(`[lexica] SQLite ${g.AndroidSQLite.sqliteVersion()}，词库 ${opened ? '已加载' : '未就绪'}`);
})(globalThis);
