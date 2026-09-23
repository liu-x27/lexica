'use strict';
/**
 * window.lexica 的安卓实现。
 *
 * 桌面版这层是 preload + 主进程 IPC；这里把同样的接口在 WebView 里就地实现，
 * 底下压的是同一份 DictDB / UserDB / Quiz。渲染层（app.js、views.js…）因此
 * 完全不需要知道自己跑在哪个平台上。
 *
 * 查词、生词本、练习、自定义词表这些业务逻辑不在这里：它们在 app-core.js，
 * 桌面版的 IPC 处理函数用的是同一份。这个文件只管平台本身不同的部分。
 *
 * 与桌面版的差异集中在三处，都是平台本身的限制：
 *   - 没有全局热键 / 托盘 / 悬浮窗：手机上取词靠「分享 / 处理文本」的系统菜单
 *   - 文件读写要走系统的分享与文档选择器，不能直接给路径
 *   - 机器翻译只有在线这一条路（本地模型 90MB、手机上 WASM 推理太慢），默认关
 */
(function (g) {
  const { DictDB, setDatabaseOpener } = g.__cjs.require('dict-db');
  const { UserDB } = g.__cjs.require('user-db');
  const { Quiz } = g.__cjs.require('quiz');
  const { createCore } = g.__cjs.require('app-core');
  const { OnlineTranslator } = g.__cjs.require('translate-online');
  const { splitSentences, MAX_CHARS, MAX_SENTENCES } = g.__cjs.require('sentence-split');

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
    /* 在线翻译默认关：开了之后查不到的词组、分享进来的句子会发给 Google。
       安卓版原本一条网络权限都没有，这是它唯一会联网的地方。 */
    mtOnline: false,
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

  /* 在线翻译。WebView 的 fetch 就是 Chromium 的网络栈，直接用——
     桌面那个「全局 fetch 拿到 429」是 Electron 主进程特有的，这里没有那一层。
     手机网络比桌面慢，超时给得比桌面宽（桌面是 2.5s / 8s）。 */
  const online = new OnlineTranslator({
    enabled: !!settings.mtOnline,
    fetchImpl: (...a) => g.fetch(...a),
  });
  const ONLINE_TIMEOUT = { lookup: 5000, batch: 12000 };

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

  /* 与桌面共用的业务层（见 app-core.js） */
  const core = createCore({ dict, user, quiz, emit });

  /* ==================================================================== */
  /*  导出：手机上没有「保存对话框」，一律交给系统分享                    */
  /* ==================================================================== */

  const stamp = () => new Date().toISOString().slice(0, 10);

  /** @returns {{ok:boolean, filePath?:string, reason?:string}} */
  function shareText(filename, content) {
    const r = JSON.parse(App.saveAndShare(filename, content));
    return r.ok ? { ok: true, filePath: r.path } : { ok: false, reason: r.error };
  }

  /** app-core 生成的导出文件交给系统分享 */
  function shareFile(file, extra) {
    if (!file.ok) return file;
    const r = shareText(file.filename, file.content);
    return r.ok ? { ...r, ...extra(file) } : r;
  }

  /* ==================================================================== */
  /*  接口表                                                              */
  /* ==================================================================== */

  /* 每个方法都是同步实现，最后统一包成 Promise：渲染层写的是 await，
     而且 app.js 里有 `api.mtStatus().catch(...)`，必须真的返回 Promise。 */
  const impl = {
    ...core.api,

    /* ---- 词典 ---- */
    stats: () => ({
      ...dict.stats(),
      counts: user.counts(),
      settings,
      customCount: user.customCount(),
      mtAvailable: online.available,
      mtOnline: online.stats(),
      platform: 'android',
      appVersion: App.version(),
    }),

    wbExport: (format) => shareFile(core.wordbookFile(format), (f) => ({ count: f.count })),
    // 桌面版这里是「在资源管理器里定位文件」；手机上分享面板已经弹过了，无事可做
    wbRevealExport: () => {},

    drillExport: (onlyScope) =>
      shareFile(core.drillFile(onlyScope), (f) => ({ scopes: f.scopes, weak: f.weak })),

    listImportFile: () => ({ ok: false, reason: '__pick__' }), // 见下面的异步覆写

    /* ---- 术语表：安卓版不接 ----
       术语表要先问模型「它会怎么错译这个词」再去替换，那套探测在桌面主进程里；
       而在线翻译本身对术语已经比较准（policy → 策略、scalar → 标量都对）。
       mtStatus() 回 glossary:false，界面据此把这个 tab 藏起来，正常不会走到这里。
       接口仍要留全：渲染层是同一份源码，preload 少一个方法就会抛。 */
    glossAll: () => [],
    glossPut: () => ({ ok: false, reason: '安卓版未内置翻译模型' }),
    glossDelete: () => ({ ok: true }),
    glossImport: () => ({ ok: false, reason: '安卓版未内置翻译模型' }),
    glossReprobe: () => ({ ok: false, reason: '安卓版未内置翻译模型' }),
    glossPacks: () => [],
    glossImportPack: () => ({ ok: false, reason: '安卓版不接术语表' }),

    /* ---- 机器翻译：只有在线这一条路 ---- */
    mtStatus: () => ({
      available: online.available,
      localAvailable: false,
      online: online.stats(),
      onlineProviders: OnlineTranslator.providers(),
      // 安卓不接术语表（见上）；渲染层看到 false 就不显示那个 tab
      glossary: false,
      caveat: '在线翻译，断网时不可用',
      reason: online.enabled
        ? '在线翻译暂时不可用（网络断了，或者连续失败后在歇一分钟）'
        : '安卓版没有内置翻译模型。可以在设置里开启在线翻译。',
    }),

    mtTranslate: async (text) => {
      const src = String(text || '').trim();
      if (!online.available) return { ok: false, reason: online.enabled ? '在线翻译暂时不可用' : '未开启在线翻译' };
      // 超过单次请求上限的转给整段通道，和桌面版一致，别让调用方自己去切
      if (src.length > 1500) {
        const r = await impl.mtTranslateLong(src);
        return r.ok ? { ok: true, text: r.text, ms: r.ms, via: 'online' } : r;
      }
      const r = await online.translate(src, { timeoutMs: ONLINE_TIMEOUT.lookup });
      return r.ok ? { ok: true, text: r.text, ms: r.ms, via: 'online' } : r;
    },

    /* 整段翻译。切句用和桌面版同一套规则（sentence-split），
       一次请求翻好几句；逐句进度照样推给渲染层，长句结果页才会动。 */
    mtTranslateLong: async (text, token) => {
      const src = String(text || '').trim();
      if (!online.available) return { ok: false, reason: online.enabled ? '在线翻译暂时不可用' : '未开启在线翻译' };
      const clipped = src.length > MAX_CHARS;
      let parts = splitSentences(clipped ? src.slice(0, MAX_CHARS) : src);
      if (!parts.length) return { ok: false, reason: '没有可翻译的句子' };
      const tooMany = parts.length > MAX_SENTENCES;
      if (tooMany) parts = parts.slice(0, MAX_SENTENCES);

      emit('mt:progress', { token, done: 0, total: parts.length });
      const r = await online.translateLines(parts, { timeoutMs: ONLINE_TIMEOUT.batch });
      if (!r.ok) return r;
      emit('mt:progress', { token, done: parts.length, total: parts.length });
      const sentences = parts.map((s0, i) => ({ src: s0, out: r.texts[i] || '' }));
      return {
        ok: true,
        ms: r.ms,
        via: 'online',
        text: sentences.map((x) => x.out).join(''),
        sentences,
        truncated: clipped || tooMany ? `原文过长，只翻译了前 ${parts.length} 句` : null,
      };
    },

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
    // 安卓没有课堂记录，自然也没什么可搜、可看的
    lecSearch: () => ({ hits: [], total: 0, truncated: false, tokens: [] }),
    lecRead: () => null,
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
    subLookup: () => false,

    /* ---- 目标、统计、历史 ---- */
    goalProgress: () => user.goalProgress(settings),

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
      if (patch.mtOnline !== undefined) settings.mtOnline = online.setEnabled(patch.mtOnline);
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
        /* 必须 await：return 一个 Promise 的话，它 reject 时已经跳出了这个 try，
           错误会直接甩给渲染层而不是变成 __error。在线翻译是第一批异步实现。 */
        return await fn(...args);
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
