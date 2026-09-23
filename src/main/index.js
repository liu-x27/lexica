'use strict';
/**
 * Lexica 主进程：窗口、托盘、全局热键、IPC。
 * 词典库只读打开一次，主窗口与悬浮查词窗共用同一个连接。
 */
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const {
  app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu,
  nativeImage, shell, dialog, screen, clipboard,
} = require('electron');

const { DictDB } = require('./dict-db');
const { UserDB } = require('./user-db');
const { Quiz, SCOPE_LABELS, KIND_LABELS, checkSpelling } = require('./quiz');
const logger = require('./logger');
const { SelectionWatcher } = require('./selection');
const { Translator } = require('./translate');
const { OnlineTranslator } = require('./translate-online');
const {
  matchTerms, applyGlossary, needProbe, cleanProbe, diffMiddle, frameDiffOk,
  PROBE_FRAME, PROBE_CONTROL,
} = require('./glossary');
const { AsrEngine } = require('./asr');
const { LectureRecorder } = require('./lecture');

/* 单实例：第二次启动只唤起已有窗口。
 *
 * 截图模式例外。打包版 Lexica 常驻托盘，这个锁会让 `LEXICA_SHOT=... electron .`
 * 在 requestSingleInstanceLock 这一行就 exit(0) 退出——没有窗口、没有输出、退出码还是 0，
 * 看起来完全像是「这台机器起不了 GUI」，实际只是被自己那个正在跑的实例挡住了。
 * 截图模式本来就用独立的临时 userData（见文件末尾 LEXICA_SHOT_PROFILE 那段），
 * 和正式实例并存不会碰到真实生词本，所以直接跳过这个锁。 */
if (!process.env.LEXICA_SHOT && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/* 截图模式要保证抓到的是这一步真实的画面，做三件事。
 *
 * 1. 窗口不做后台节流。窗口被盖住或最小化时 Chromium 把页面当成 hidden，停掉 rAF
 *    和出帧，capturePage 照样立刻返回，给的却是之前的画面，而且往往只落后一步，
 *    和上一张比字节抓不出来。探针实测（每种 12 步 × 3 轮）：被置顶窗口盖住时错
 *    2~5 张，最小化时错 7~8 张；关掉节流后全部 0 错。只关原生遮挡计算
 *    （CalculateNativeWinOcclusion）治得了盖住、治不了最小化。
 * 2. 最小化了立刻还原。光关节流在探针里够了，在真实应用里不够：外部脚本每 4 秒
 *    把窗口最小化一次、跑完整轮，rAF 还是停了 16 次，复习卡片还拍成了空白——
 *    入场动画停在 opacity:0 的第一帧，rAF 检查照样放行。
 * 3. 强制「减弱动效」。应用本来就支持 prefers-reduced-motion（tokens.css 把时长
 *    归零），入场动画一出来就是终态，截图不再取决于合成器有没有把动画推完。
 *
 * 正式运行一样都不做：常驻托盘时该节流就节流，动效照常。 */
const SHOT_MODE = !!process.env.LEXICA_SHOT;
const BG_THROTTLE = !SHOT_MODE;
if (SHOT_MODE) {
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
  app.on('browser-window-created', (_e, win) => {
    win.on('minimize', () => setImmediate(() => { if (!win.isDestroyed()) win.restore(); }));
  });
}

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

/** 词典库位置：开发时在 data/，打包后在 resources/data/ */
function resolveDictPath() {
  const candidates = [
    path.join(ROOT, 'data', 'dict.db'),
    path.join(process.resourcesPath || '', 'data', 'dict.db'),
    path.join(path.dirname(app.getPath('exe')), 'data', 'dict.db'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || candidates[0];
}

/**
 * 默认热键不用 Alt+Space —— 那是 Windows 打开窗口系统菜单的固定快捷键，
 * 注册一定失败（实测报「热键已被其它程序占用」）。
 */
const HOTKEY_FALLBACKS = ['Ctrl+Alt+Space', 'Ctrl+Shift+Space', 'Ctrl+Alt+D', 'Ctrl+Shift+F12'];

/**
 * 实时字幕里单段音频的上限（秒）。
 *
 * 这个值同时喂给两处，必须一致，否则会出静默故障：
 *   - 渲染层的 VadChunker.maxMs —— 决定最长攒多久就强切；
 *   - AsrEngine 的 --audio-ctx  —— 决定 whisper 编码器能看多长。
 * 前者大于后者时，超出部分不是被丢掉，而是让模型退化成重复循环
 * （实测 ac=512 喂 14 秒音频会反复吐同一句）。
 */
const LECTURE_MAX_CHUNK_SEC = 9;

const DEFAULTS = {
  theme: 'paper',
  hotkey: HOTKEY_FALLBACKS[0],
  hotkeyEnabled: true,
  autoLaunch: false,
  minimizeToTray: true,
  ttsRate: 0.95,
  ttsVoice: null,
  showAside: true,
  fontScale: 1, // 正文字号倍率，0.9 / 1 / 1.1 / 1.2
  // 每日目标，0 表示不设目标
  dailyNew: 10,
  dailyReviews: 30,
  dailyQuiz: 20,
  // 窗口状态：{ x, y, width, height, maximized }
  windowState: null,
  clipboardLookup: false, // 剪贴板取词（复制即查）
  // 划词取词：off 关闭 / hotkey 按热键取当前选区 / auto 松开鼠标即取词
  selectionMode: 'off',
  selectionHotkey: 'Ctrl+Alt+X',
  // UIA 读不到时是否允许模拟 Ctrl+C 兜底（会短暂占用剪贴板，用完还原）
  selectionCopyFallback: true,
  // 词典给不出整体释义时自动跑机器翻译。划词场景下再要求手动点就违背了初衷，
  // 所以默认开；结果始终标注为机器翻译，且排在逐词拆解之后。
  mtAuto: true,
  drillScope: 'cet4',

  /* ---- 实时字幕 ---- */
  /**
   * 翻译模型。查词、划词、整段翻译都用它，默认 nllb——
   * 实测 opus 会把数字改错（63.8 → 638），读论文时这比慢几秒危险得多。
   * 没装 nllb 时 Translator 会自动回落到已装的那个。
   */
  mtModel: 'nllb',
  /* 在线翻译：默认关。开启后识别出的英文会发给第三方服务，
     界面上写明了这点。失败一律自动退回本地模型。 */
  mtOnline: false,
  mtOnlineProvider: 'google',
  /**
   * 实时字幕单独用一个更快的模型，默认 opus。
   *
   * 理由是实测出来的：nllb 和 whisper 在同一颗 CPU 上会互相抢核，
   * 两边一起变慢——一节课的字幕只识别出四分之一，识别队列 25 秒都排不完。
   * 而实时场景本来就是英中对照显示，英文原文一直在旁边；
   * 转写文件里也留着英文，课后想要更准的译文可以用翻译页重译。
   */
  lectureMtModel: 'opus',
  /* 识别模型。实测 WER：tiny 未测 / base 4.7% / small + beam + 提示词 0.8%。
     small 在常驻服务 + audio-ctx 下有 3.7 倍实时余量，所以默认用它——
     早先「small 跑不动」是拿旧配置测出来的错结论。 */
  asrModel: 'small',
  /**
   * 识别用的领域提示词。
   *
   * 这是单项收益最大的一项：whisper 把它当已转写的上文，于是更倾向于
   * 输出里面出现过的写法。实测 base 的 WER 从 4.7% 降到 3.1%，
   * small 从 4.7% 降到 1.6%——能把 "twinning" 这种同音错词拉回 "training"。
   *
   * 默认给一段通用学术词汇；每门课的专有名词由「课程名」和这里的自定义内容补。
   */
  asrPrompt: 'Lecture transcript. Terms: algorithm, hypothesis, parameter, variance, '
    + 'coefficient, derivative, matrix, neural network, gradient descent, distribution, '
    + 'regression, significance, correlation, dataset, benchmark, framework, analysis.',
  // 音频来源：mic 麦克风（线下课）/ system 系统声音（网课）
  lectureSource: 'mic',
  // 每次记录要生成哪几种文件
  lectureFormats: ['md', 'txt', 'srt', 'json'],
  // 多长的停顿算一句话说完。教室回声大时可以调大
  lectureSilenceMs: 420,
  /* 滚动字幕：边说边出临时稿，说完再定稿。
     实测字幕延迟里翻译只占 300ms，大头是等说话人停顿（约 5 秒），
     这一项才是治延迟的。默认开。 */
  lectureRolling: true,
  lectureRollingModel: 'base',
  lectureRollingMs: 1500,

  /* ---- 电影字幕悬浮窗 ---- */
  subtitleHotkey: 'Ctrl+Alt+S',
  subtitleFontScale: 1,
  // 同时显示几条字幕。看电影一般两条够（当前 + 上一条）
  subtitleLines: 2,
  // 窗口位置与尺寸，{ x, y, width, height }
  subtitleBounds: null,
};

const THEME_CHROME = {
  paper: { color: '#f4efe5', symbolColor: '#5a534a' },
  glass: { color: '#0e1219', symbolColor: '#9aa7ba' },
};

let dict = null;
let user = null;
let quiz = null;
let clipTimer = null;
let lastClip = '';
let selection = null;
let translator = null;
let asr = null;
let lectures = null;
let online = null;
let rollAsr = null;   // 滚动字幕的临时稿服务，与主服务分开
let mainWin = null;
let quickWin = null;
let subWin = null;
let tray = null;
let settings = { ...DEFAULTS };
let quitting = false;

/* ========================================================================== */
/*  窗口                                                                       */
/* ========================================================================== */

/**
 * 校验上次保存的窗口位置在当前显示器布局下是否还可见。
 * 外接屏拔掉后，原来的坐标会把窗口放到屏幕外，用户会以为程序没启动。
 */
function sanitizeBounds(saved) {
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return null;
  const width = Math.max(880, Math.round(saved.width));
  const height = Math.max(600, Math.round(saved.height));
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return { width, height };

  const x = Math.round(saved.x);
  const y = Math.round(saved.y);
  // 只要标题栏还有一块落在某个显示器的工作区内就认为可见
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x + width > a.x + 80 && x < a.x + a.width - 80 && y + 40 > a.y && y < a.y + a.height - 40;
  });
  return visible ? { x, y, width, height } : { width, height };
}

/** 记住窗口大小/位置/最大化状态；节流写入，避免拖动过程中反复落库 */
function trackWindowState(win) {
  let timer = null;
  const save = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    // 最大化时 getBounds 返回的是最大化后的尺寸，要存还原后的
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    settings.windowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
    user.setSetting('windowState', settings.windowState);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    clearTimeout(timer);
    save();
  });
}

function createMainWindow() {
  const chrome = THEME_CHROME[settings.theme] || THEME_CHROME.paper;
  const saved = sanitizeBounds(settings.windowState);
  mainWin = new BrowserWindow({
    width: saved?.width ?? 1220,
    height: saved?.height ?? 820,
    ...(saved?.x != null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: settings.theme === 'glass' ? '#0a0d12' : '#faf7f1',
    icon: assetPath('icon.ico') || undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...chrome, height: 60 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: BG_THROTTLE,
    },
  });

  mainWin.loadFile(path.join(RENDERER, 'index.html'));
  mainWin.once('ready-to-show', () => {
    if (settings.windowState?.maximized) mainWin.maximize();
    mainWin.show();
  });
  trackWindowState(mainWin);

  mainWin.on('close', (e) => {
    if (!quitting && settings.minimizeToTray) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => { mainWin = null; });

  // 外链走系统浏览器，不在应用内打开
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWin;
}

function createQuickWindow() {
  quickWin = new BrowserWindow({
    width: 580,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    icon: assetPath('icon.ico') || undefined,
    backgroundColor: settings.theme === 'glass' ? '#0a0d12' : '#faf7f1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: BG_THROTTLE,
    },
  });

  quickWin.loadFile(path.join(RENDERER, 'quick.html'));
  quickWin.setVisibleOnAllWorkspaces(true);

  // 失焦即隐藏，像系统级取词工具
  quickWin.on('blur', () => {
    if (quickWin && quickWin.isVisible() && !quickWin.webContents.isDevToolsOpened()) quickWin.hide();
  });
  quickWin.on('closed', () => { quickWin = null; });
  return quickWin;
}

/**
 * 电影字幕悬浮窗。
 *
 * 无边框 + 透明 + 置顶，像播放器自带字幕那样摆在画面下方。
 * 与悬浮查词窗的区别：它**不能失焦即隐藏**——看电影时焦点一定在播放器上，
 * 那样会刚打开就消失。所以只能手动关或按热键关。
 */
function createSubtitleWindow() {
  const saved = settings.subtitleBounds;
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(area.width - 80, Math.max(480, saved?.width || 900));
  const height = Math.max(120, Math.min(420, saved?.height || 170));

  subWin = new BrowserWindow({
    width,
    height,
    // 默认摆在主屏底部居中，像字幕条
    x: saved?.x ?? Math.round(area.x + (area.width - width) / 2),
    y: saved?.y ?? Math.round(area.y + area.height - height - 60),
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 360,
    minHeight: 110,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 全屏看视频时也要浮在上面。'screen-saver' 这一级才压得住全屏播放器
    fullscreenable: false,
    hasShadow: false,
    icon: assetPath('icon.ico') || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: BG_THROTTLE,
    },
  });

  subWin.loadFile(path.join(RENDERER, 'subtitle.html'));
  subWin.setAlwaysOnTop(true, 'screen-saver');
  subWin.setVisibleOnAllWorkspaces(true);

  // 记住位置和大小，下次还摆在同一处
  let saveTimer = null;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!subWin || subWin.isDestroyed()) return;
      const b = subWin.getBounds();
      settings.subtitleBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      user.setSetting('subtitleBounds', settings.subtitleBounds);
    }, 400);
  };
  subWin.on('move', saveBounds);
  subWin.on('resize', saveBounds);
  subWin.on('closed', () => { subWin = null; });

  return subWin;
}

/** 开/关字幕悬浮窗。热键与界面按钮都走这里 */
function toggleSubtitleWindow(force = null) {
  const want = force === null ? !(subWin && subWin.isVisible()) : force;

  if (!want) {
    if (subWin && !subWin.isDestroyed()) {
      // 通知渲染层停掉采音，否则关了窗识别还在后台跑
      subWin.webContents.send('sub:toggle', { on: false });
      subWin.hide();
    }
    return false;
  }

  if (!subWin || subWin.isDestroyed()) createSubtitleWindow();
  subWin.showInactive();   // 不抢焦点：看视频时焦点该留在播放器上
  subWin.setAlwaysOnTop(true, 'screen-saver');
  subWin.webContents.send('sub:toggle', { on: true, locked: false });
  return true;
}

/**
 * 显示悬浮查词窗。
 * @param seen 初始查询词
 * @param near 传了坐标就贴着鼠标弹（划词场景），否则摆在屏幕偏上方居中
 */
function showQuickWindow(seed, near = null, extra = null) {
  if (!quickWin) createQuickWindow();
  const cursor = near && Number.isFinite(near.x) ? near : screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(cursor);
  const [w, h] = quickWin.getSize();
  const area = disp.workArea;

  let x;
  let y;
  if (near) {
    // 贴着选区右下方弹，超出屏幕就翻到另一侧
    x = cursor.x + 16;
    y = cursor.y + 20;
    if (x + w > area.x + area.width) x = cursor.x - w - 16;
    if (y + h > area.y + area.height) y = cursor.y - h - 20;
    x = Math.max(area.x, Math.min(x, area.x + area.width - w));
    y = Math.max(area.y, Math.min(y, area.y + area.height - h));
  } else {
    x = Math.round(area.x + (area.width - w) / 2);
    y = Math.round(area.y + area.height * 0.22);
  }

  quickWin.setPosition(Math.round(x), Math.round(y));
  quickWin.show();
  quickWin.focus();
  // 没有语境时显式给 null：上一次从悬浮字幕带进来的语境不能串到这次的划词上
  quickWin.webContents.send('quick:open', { seed: seed || '', context: extra?.context || null });
}

function toggleQuickWindow() {
  if (quickWin && quickWin.isVisible()) {
    quickWin.hide();
    return;
  }
  // 剪贴板里若是一个英文单词，直接作为初始查询
  let seed = '';
  try {
    const t = clipboard.readText().trim();
    if (t && t.length <= 40 && /^[A-Za-z][A-Za-z '-]*$/.test(t)) seed = t;
  } catch { /* 忽略 */ }
  showQuickWindow(seed);
}

function focusMain(word) {
  if (!mainWin) createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  if (word) mainWin.webContents.send('nav:lookup', { word });
}

/* ========================================================================== */
/*  托盘                                                                       */
/* ========================================================================== */

/**
 * 图标资源查找。开发时在 assets/，打包后在 resources/app/assets/。
 *
 * 注意不能用 SVG data URL：nativeImage 不支持 SVG，createFromDataURL 会返回空图，
 * 之前托盘图标就是因此一直空白。图标由 scripts/make-icon.js 预先栅格化成
 * assets/tray.png 与 assets/icon.ico。
 */
function assetPath(name) {
  const candidates = [
    path.join(ROOT, 'assets', name),
    path.join(__dirname, '..', '..', 'assets', name),
    path.join(process.resourcesPath || '', 'app', 'assets', name),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function loadIcon(name) {
  const p = assetPath(name);
  if (!p) return null;
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? null : img;
}

function trayIcon() {
  const img = loadIcon('tray.png') || loadIcon('icon.ico');
  if (img) return img;
  // 兜底：画一个纯色方块，至少不是空白（空图会让托盘图标不可见）
  console.warn('[tray] 找不到图标资源，使用纯色兜底；请运行 npm run icon');
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 0x2f; // B
    buf[i * 4 + 1] = 0x40; // G
    buf[i * 4 + 2] = 0xb3; // R
    buf[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

/**
 * 重建托盘菜单。热键可能在启动时被自动更换（见 registerHotkey），
 * 所以菜单要在热键确定之后再刷一次，否则菜单里写的是旧热键。
 */
function refreshTrayMenu() {
  if (!tray) return;
  const label = settings.hotkeyEnabled && settings.hotkey
    ? `悬浮查词（${settings.hotkey}）`
    : '悬浮查词';
  tray.setToolTip(`Lexica 离线词典 · ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => focusMain() },
    { label, click: () => showQuickWindow() },
    { type: 'separator' },
    { label: '今日待复习', click: () => { focusMain(); mainWin?.webContents.send('nav:view', { view: 'review' }); } },
    { label: '生词本', click: () => { focusMain(); mainWin?.webContents.send('nav:view', { view: 'wordbook' }); } },
    { type: 'separator' },
    {
      label: `视频字幕悬浮窗　${settings.subtitleHotkey || ''}`,
      type: 'checkbox',
      checked: !!(subWin && !subWin.isDestroyed() && subWin.isVisible()),
      click: () => { toggleSubtitleWindow(); refreshTrayMenu(); },
    },
    { type: 'separator' },
    { label: '退出 Lexica', click: () => { quitting = true; app.quit(); } },
  ]));
}

function buildTray() {
  tray = new Tray(trayIcon());
  refreshTrayMenu();
  tray.on('click', () => (mainWin && mainWin.isVisible() ? mainWin.hide() : focusMain()));
}

/* ========================================================================== */
/*  全局热键                                                                   */
/* ========================================================================== */

/**
 * 注册全局热键。用户明确设过就只试那一个（失败要如实告知），
 * 若用的还是默认值，则在候选表里顺序找一个能用的。
 */
function registerHotkey({ allowFallback = false } = {}) {
  globalShortcut.unregisterAll();
  if (!settings.hotkeyEnabled || !settings.hotkey) return { ok: true, registered: false };

  const tryOne = (accel) => {
    try {
      return globalShortcut.register(accel, toggleQuickWindow);
    } catch {
      return false;
    }
  };

  /* 附属热键必须在主热键之前注册。
     以前这段写在 `if (tryOne(主热键)) return` 的**后面**，
     而主热键正常都能注册成功，于是这段是死代码——
     「按热键划词」模式一直没生效过。 */
  const registerExtra = (accel, fn) => {
    if (!accel) return;
    try { globalShortcut.register(accel, fn); } catch { /* 被占用就算了，不影响主热键 */ }
  };

  // 划词热键：按下就抓当前选区
  if (settings.selectionMode === 'hotkey') {
    registerExtra(settings.selectionHotkey, () => {
      setupSelection();
      selection.setCopyFallback(settings.selectionCopyFallback !== false);
      selection.capture();
    });
  }

  /* 视频字幕热键。这个尤其需要全局热键：字幕锁定成鼠标穿透后，
     窗口自己点不到了，只能靠热键关。 */
  registerExtra(settings.subtitleHotkey, () => toggleSubtitleWindow());

  if (tryOne(settings.hotkey)) return { ok: true, registered: true, hotkey: settings.hotkey };

  if (allowFallback) {
    for (const alt of HOTKEY_FALLBACKS) {
      if (alt === settings.hotkey) continue;
      if (tryOne(alt)) {
        settings.hotkey = alt;
        user.setSetting('hotkey', alt);
        return { ok: true, registered: true, hotkey: alt, fellBack: true };
      }
    }
  }

  return { ok: false, registered: false, reason: '热键已被其它程序占用', hotkey: settings.hotkey };
}

/* ========================================================================== */
/*  剪贴板取词                                                                 */
/* ========================================================================== */

/**
 * 轮询剪贴板，内容变成英文单词/短语时自动弹出悬浮查词窗。
 *
 * 真正的鼠标悬停划词需要 UI Automation / 无障碍接口，得编原生模块，
 * 本机没有 MSVC 编不了，所以走剪贴板这条路：用户按 Ctrl+C 就能取词。
 */
/* 这里的四词上限是刻意保留的，不是漏改。
   划词取词是用户主动按热键，长句照样受理（见 selection.js）；
   而剪贴板监听是「复制即弹窗」，复制一整段就自动弹出词典会非常扰人。 */
function looksLikeLookupText(t) {
  if (!t || t.length > 48) return false;
  if (!/^[A-Za-z][A-Za-z '’\-]*$/.test(t)) return false;
  return t.split(/\s+/).length <= 4;
}

function startClipboardWatch() {
  stopClipboardWatch();
  try { lastClip = clipboard.readText(); } catch { lastClip = ''; }
  clipTimer = setInterval(() => {
    let t;
    try { t = clipboard.readText().trim(); } catch { return; }
    if (!t || t === lastClip) return;
    lastClip = t;
    if (!looksLikeLookupText(t)) return;
    // 主窗口正在前台时不打扰，用户本来就能直接查
    if (mainWin && !mainWin.isMinimized() && mainWin.isFocused()) return;
    showQuickWindow(t);
  }, 600);
}

function stopClipboardWatch() {
  if (clipTimer) clearInterval(clipTimer);
  clipTimer = null;
}

/* ========================================================================== */
/*  划词取词                                                                   */
/* ========================================================================== */

/** 自己的窗口在前台时不取词，否则在应用里选个词就会自弹 */
function ourWindowFocused() {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
}

function setupSelection() {
  if (selection) return;
  selection = new SelectionWatcher();

  selection.on('selection', (e) => {
    // 自动模式下要避开自己的窗口；热键模式是用户主动按的，照查不误
    if (!e.requested && ourWindowFocused()) return;
    showQuickWindow(e.text, { x: e.x, y: e.y });
  });

  selection.on('empty', () => {
    // 热键按了但没选中东西：把悬浮窗开着让用户手输，比什么都不发生好
    showQuickWindow('');
  });

  selection.on('disabled', () => {
    settings.selectionMode = 'off';
    user.setSetting('selectionMode', 'off');
    broadcast('selection:disabled', {});
  });
}

function applySelectionMode() {
  const mode = settings.selectionMode || 'off';
  if (mode === 'off') {
    selection?.stop();
    return;
  }
  setupSelection();
  selection.setCopyFallback(settings.selectionCopyFallback !== false);
  selection.setWatch(mode === 'auto');
}

/* ========================================================================== */
/*  IPC                                                                        */
/* ========================================================================== */

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_e, ...args) => {
    try {
      return fn(...args);
    } catch (err) {
      console.error(`[ipc:${channel}]`, err);
      return { __error: err.message };
    }
  });

  /* ---- 词典 ---- */
  handle('dict:stats', () => ({
    ...dict.stats(),
    counts: user.counts(),
    settings,
    customCount: user.customCount(),
    mtAvailable: !!translator?.available || !!online?.available,
    // 设置页要显示在线翻译的实时统计（退回本地是静默的，得有地方看）
    mtOnline: online ? online.stats() : null,
    // 设置页要按「装了哪些模型」来渲染选项，没装的不该给出来
    mtModels: translator ? translator.installedModels() : [],
    asr: asr ? asr.status() : { available: false, models: [] },
    appVersion: app.getVersion(),
  }));

  /**
   * 把用户自建词条包装成和内置词条一样的结构，
   * 这样渲染层不用为它写第二套逻辑。
   */
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
    translation: require('./dict-db').parseTranslation(row.translation),
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

  handle('dict:lookup', (word, opts) => {
    // 自定义词条优先：用户特意补的词，说明内置词库没有或不满意
    const custom = user.customEntry(word);
    if (custom) {
      if (!opts?.noHistory) user.pushHistory(custom.word);
      const built = dict.lookup(word);
      return {
        status: 'ok',
        entry: customAsEntry(custom),
        // 内置词库里也有的话，一并告知，让用户能切过去看
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
      // 生词本上的笔记与自有释义是叠加的，词条页要单独排一块
      res.mine = user.entry(res.entry.word);
    }
    return res;
  });

  handle('dict:suggest', (q, limit) => {
    const res = dict.suggest(q, limit);
    // 自建词条排在最前面：用户自己录的，优先级最高
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
  });
  handle('dict:search', (q, limit) => dict.search(q, limit));
  handle('dict:random', () => dict.randomWord());
  handle('dict:terms', (text) => dict.termsIn(text));

  /* ---- 生词本 ---- */
  handle('wb:toggle', (word) => {
    const r = user.toggle(word);
    broadcast('wb:changed', user.counts());
    return r;
  });
  handle('wb:isSaved', (word) => user.isSaved(word));
  handle('wb:list', (opts) => {
    // 补上中文释义与难度标签，生词本列表才有内容可看。
    // 用 briefMany 一次批量取：逐个 lookup() 会连义项、例句、词源一起查出来，
    // 而列表只用得上音标和前两条释义。
    const rows = user.list(opts);
    const brief = dict.briefMany(rows.map((r) => r.word));
    return rows.map((row) => {
      const b = brief.get(String(row.word).toLowerCase());
      const mine = user.customEntry(row.word);
      return {
        ...row,
        myDef: row.my_def || null,
        phonetic: b?.phonetic || mine?.phonetic || null,
        /* 列表只有一行位置，优先给自己写的——那是用户特意记下来的，
           而词库释义在词条页随时能看到。 */
        brief: row.my_def || b?.brief || mine?.translation || '',
        /* 词库里到底有没有这个词，界面要能区分：
           自己加的词组点进去是没有词条页的，得给不同的提示。 */
        inDict: !!b,
        tags: b?.tags.map((t) => t.code) || [],
        collins: b?.collins || 0,
      };
    });
  });

  /** 单条生词本记录（编辑框要用），连词库摘要一起给 */
  handle('wb:get', (word) => {
    const row = user.entry(word);
    const b = dict.briefMany([word]).get(String(word || '').toLowerCase());
    return {
      row: row || null,
      saved: !!row,
      dictBrief: b?.brief || null,
      phonetic: b?.phonetic || null,
      inDict: !!b,
    };
  });

  /** 手动添加。词库里没有的词组只能走这条路进生词本 */
  handle('wb:add', (payload) => {
    const r = user.addWord(payload?.word, { note: payload?.note, myDef: payload?.myDef });
    if (r.ok) broadcast('wb:changed', user.counts());
    return r;
  });

  /**
   * 带语境收藏：在字幕、翻译页、历史转写稿里点词，按下「收进生词本」走这里。
   * 语境单独存（wordbook.contexts），不碰用户自己写的笔记。
   */
  handle('wb:addContext', (payload) => {
    const r = user.addContext(payload?.word, {
      en: payload?.en, zh: payload?.zh, src: payload?.src,
    });
    if (r.ok) broadcast('wb:changed', user.counts());
    return r;
  });

  handle('wb:removeContext', (payload) => user.removeContext(payload?.word, payload?.index));

  /** 写/改注释（笔记 + 我的释义） */
  handle('wb:annotate', (payload) => {
    const r = user.annotate(payload?.word, { note: payload?.note, myDef: payload?.myDef });
    if (r.ok) broadcast('wb:changed', user.counts());
    return r;
  });

  handle('wb:remove', (word) => {
    const r = user.remove(word);
    broadcast('wb:changed', user.counts());
    return r;
  });
  handle('wb:counts', () => user.counts());
  handle('wb:due', (limit) => {
    return user.dueQueue(limit).map((row) => {
      const r = dict.lookup(row.word, { noHistory: true });
      /* 自己加的词组词库里查不到，entry 会是 null。
         这时用自建词条兜一层，否则复习卡上一个字都没有，卡片没法答。 */
      let entry = r.status === 'ok' ? r.entry : null;
      if (!entry) {
        const mine = user.customEntry(row.word);
        if (mine) entry = customAsEntry(mine);
      }
      return { card: row, entry, myDef: row.my_def || null, note: row.note || null };
    });
  });
  handle('wb:grade', (word, grade) => {
    const r = user.grade(word, grade);
    broadcast('wb:changed', user.counts());
    return r;
  });

  handle('wb:export', async (format) => {
    const words = user.allWords();
    if (!words.length) return { ok: false, reason: '生词本还是空的' };

    const isAnki = format === 'anki';
    const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
      title: isAnki ? '导出为 Anki 可导入的 TSV' : '导出为 CSV',
      defaultPath: `lexica-wordbook-${new Date().toISOString().slice(0, 10)}.${isAnki ? 'tsv' : 'csv'}`,
      filters: isAnki ? [{ name: 'TSV', extensions: ['tsv'] }] : [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, reason: '已取消' };

    const esc = (s) => {
      const v = String(s ?? '');
      return isAnki ? v.replace(/[\t\n\r]+/g, ' ') : `"${v.replace(/"/g, '""')}"`;
    };
    const sep = isAnki ? '\t' : ',';
    const lines = [];
    if (!isAnki) {
      lines.push(['单词', '音标', '释义', '我的释义', '我的笔记', '出处', '例句', '难度标签', '加入时间', '复习次数']
        .map(esc).join(sep));
    }

    for (const w of words) {
      const r = dict.lookup(w.word, { noHistory: true });
      const e = r.status === 'ok' ? r.entry : null;
      const mine = e ? null : user.customEntry(w.word);
      const dictMean = e
        ? e.translation.map((t) => (t.pos ? `${t.pos}. ${t.text}` : t.text)).join(isAnki ? '<br>' : '；')
        : (mine?.translation || '');
      const ex = e?.examples?.[0] ? `${e.examples[0].en}${e.examples[0].zh ? (isAnki ? '<br>' : ' ') + e.examples[0].zh : ''}` : '';
      /* Anki 那边列数固定（正面/背面…），自己写的内容拼进背面，
         不能多加两列——多了导入时字段会错位。 */
      /* 出处：在哪句话里遇到的。只放最近一条——Anki 背面放多了反而干扰，
         CSV 里给全，一条一行。 */
      const ctxs = (w.contexts || []).map((c) => `${c.en}${c.src ? `（${c.src}）` : ''}`);
      const anki = [
        w.word,
        e?.phonetic || mine?.phonetic || '',
        [w.my_def, dictMean, w.note && `【笔记】${w.note}`, ctxs[0] && `【出处】${ctxs[0]}`]
          .filter(Boolean).join('<br>'),
        ex,
        (e?.tags || []).map((t) => t.label).join(' '),
        new Date(w.added_at).toISOString().slice(0, 10),
        w.reps,
      ];
      const csv = [
        w.word,
        e?.phonetic || mine?.phonetic || '',
        dictMean,
        w.my_def || '',
        w.note || '',
        ctxs.join(' / '),
        ex,
        (e?.tags || []).map((t) => t.label).join(' '),
        new Date(w.added_at).toISOString().slice(0, 10),
        w.reps,
      ];
      lines.push((isAnki ? anki : csv).map(esc).join(sep));
    }

    // Excel 打开 CSV 需要 BOM 才能正确识别 UTF-8
    fs.writeFileSync(filePath, (isAnki ? '' : '﻿') + lines.join('\r\n'), 'utf8');
    return { ok: true, filePath, count: words.length };
  });

  handle('wb:revealExport', (p) => { if (p) shell.showItemInFolder(p); });

  /* ---- 考纲练习 ---- */
  handle('drill:scopes', () =>
    quiz.scopes().map((s) => ({ ...s, progress: user.scopeProgress(s.scope) })),
  );
  handle('drill:progress', (scope) => user.scopeProgress(scope));
  handle('drill:study', (scope, count) => quiz.studyBatch(scope, count));
  handle('drill:quiz', (scope, count, kinds) => quiz.batch(scope, count, { kinds }));
  handle('drill:assess', (scope, count) => quiz.assessmentBatch(scope, count));

  handle('drill:answer', (payload) => {
    user.recordAnswer(payload);
    return { ok: true };
  });

  handle('drill:finish', (payload) => {
    user.saveSession(payload);
    return user.scopeProgress(payload.scope);
  });

  handle('drill:mark', (word, scope, known) => {
    user.markWord(word, scope, known);
    // 标记为不认识的词直接进生词本，省一步操作
    if (!known && !user.isSaved(word)) {
      user.toggle(word);
      broadcast('wb:changed', user.counts());
    }
    return { ok: true, saved: user.isSaved(word) };
  });

  handle('drill:weak', (scope, limit) => {
    const rows = user.weakWords(scope, limit);
    return rows.map((r) => {
      const res = dict.lookup(r.word, { noHistory: true });
      return { ...r, entry: res.status === 'ok' ? res.entry : null };
    });
  });

  /** 错题重练：拿错得最多的词现场出题 */
  handle('drill:weakQuiz', (scope, count) => {
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
  });

  handle('drill:labels', () => ({ scopes: SCOPE_LABELS, kinds: KIND_LABELS }));
  handle('drill:checkSpell', (input, answer) => checkSpelling(input, answer));

  /** 导出练习进度：范围汇总 + 错题明细，一份 CSV */
  handle('drill:export', async (onlyScope) => {
    const scopes = quiz.scopes().filter((s) => !onlyScope || s.scope === onlyScope);
    if (!scopes.length) return { ok: false, reason: '没有可导出的范围' };

    const name = onlyScope ? `lexica-${onlyScope}` : 'lexica-练习进度';
    const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
      title: '导出练习进度',
      defaultPath: `${name}-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, reason: '已取消' };

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [];
    let weakTotal = 0;

    lines.push('# 范围汇总');
    lines.push(['范围', '可练词量', '已掌握', '待巩固', '累计答题', '正确率', '上次检测掌握率', '检测时间']
      .map(esc).join(','));

    for (const s of scopes) {
      const p = user.scopeProgress(s.scope);
      lines.push([
        s.label,
        s.quizzable,
        p.mastered,
        p.shaky,
        p.answered,
        p.accuracy == null ? '' : `${Math.round(p.accuracy * 100)}%`,
        p.lastAssessment ? `${Math.round(p.lastAssessment.rate * 100)}%` : '',
        p.lastAssessment ? new Date(p.lastAssessment.at).toLocaleString('zh-CN') : '',
      ].map(esc).join(','));
    }

    lines.push('');
    lines.push('# 错题明细');
    lines.push(['范围', '单词', '音标', '释义', '答题次数', '答对', '答错', '难度标签']
      .map(esc).join(','));

    for (const s of scopes) {
      for (const w of user.weakWords(s.scope, 500)) {
        const r = dict.lookup(w.word, { noHistory: true });
        const e = r.status === 'ok' ? r.entry : null;
        lines.push([
          s.label,
          w.word,
          e?.phon?.main || '',
          e ? e.translation.map((t) => (t.pos ? `${t.pos}. ${t.text}` : t.text)).join('；') : '',
          w.seen,
          w.hit,
          w.miss,
          (e?.tags || []).map((t) => t.label).join(' '),
        ].map(esc).join(','));
        weakTotal++;
      }
    }

    // Excel 打开 CSV 需要 BOM 才能认出 UTF-8
    fs.writeFileSync(filePath, `﻿${lines.join('\r\n')}`, 'utf8');
    return { ok: true, filePath, scopes: scopes.length, weak: weakTotal };
  });

  /* ---- 学习统计 ---- */
  handle('stats:heatmap', (days) => user.heatmap(days));

  /* ---- 历史 ---- */
  handle('hist:recent', (limit) => user.recent(limit));
  handle('hist:clear', () => { user.clearHistory(); return { ok: true }; });

  /* ---- 设置 ---- */
  handle('set:all', () => settings);
  handle('set:put', (patch) => {
    const before = { ...settings };
    Object.assign(settings, patch);
    for (const [k, v] of Object.entries(patch)) user.setSetting(k, v);

    if (patch.theme && patch.theme !== before.theme) {
      const chrome = THEME_CHROME[patch.theme] || THEME_CHROME.paper;
      try { mainWin?.setTitleBarOverlay({ ...chrome, height: 60 }); } catch { /* 忽略 */ }
      broadcast('set:theme', { theme: patch.theme });
    }

    let hk = null;
    if (patch.hotkey !== undefined || patch.hotkeyEnabled !== undefined) {
      hk = registerHotkey();
      refreshTrayMenu();
    }

    if (patch.autoLaunch !== undefined) {
      app.setLoginItemSettings({ openAtLogin: !!patch.autoLaunch, args: ['--hidden'] });
    }
    if (patch.selectionMode !== undefined || patch.selectionCopyFallback !== undefined) {
      applySelectionMode();
      // 划词热键跟着模式变，要重新注册
      if (patch.selectionMode !== undefined) registerHotkey();
    }
    if (patch.selectionHotkey !== undefined) registerHotkey();
    if (patch.subtitleHotkey !== undefined) registerHotkey();

    if (patch.subtitleFontScale !== undefined || patch.subtitleLines !== undefined) {
      // 悬浮窗自己读设置，通知它重绘一次
      if (subWin && !subWin.isDestroyed()) subWin.webContents.send('sub:toggle', { on: true });
    }

    if (patch.clipboardLookup !== undefined) {
      if (patch.clipboardLookup) startClipboardWatch();
      else stopClipboardWatch();
    }

    if (patch.mtOnline !== undefined) {
      settings.mtOnline = online.setEnabled(patch.mtOnline);
      user.setSetting('mtOnline', settings.mtOnline);
      /* 换通道等于换模型：术语表探到的错法是上一个通道给的，
         不作废的话术语表在新通道上一条都命中不了（静默失效）。 */
      resetTermProbes();
    }
    if (patch.mtOnlineProvider !== undefined) {
      settings.mtOnlineProvider = online.setProvider(patch.mtOnlineProvider);
      user.setSetting('mtOnlineProvider', settings.mtOnlineProvider);
      resetTermProbes();
    }

    if (patch.mtModel !== undefined) {
      /* 换模型不用重启工作进程：它按 key 缓存了多个 pipeline。
         回写 settings 是因为 setModel 会拒绝没装的模型，
         不同步的话设置页会显示一个其实没生效的选项。 */
      settings.mtModel = translator.setModel(patch.mtModel);
      user.setSetting('mtModel', settings.mtModel);
      if (translator.available) translator.warmup();
      /* 术语表探到的错译写法是**上一个模型**给的，换了模型就得重探。
         不清的话新模型的错法一条都没有，术语表静默失效。
         已有的写法会保留（探测是并集），所以旧模型的配置不会丢。 */
      resetTermProbes();
    }

    if (patch.lectureRolling !== undefined) {
      /* 关掉时顺手把临时稿服务停掉，别让它白占内存和端口。
         采音层下次 asrStatus() 就不会再发快照了；记录中途改的话
         快照还会来几条，handlePartial 开头那道判断会挡掉。 */
      if (!settings.lectureRolling) stopRollAsr();
      else if (lectures.active) startRollAsr();
    }

    if ((patch.asrModel !== undefined || patch.asrPrompt !== undefined) && asr.status().running) {
      // 正在记录时换模型或改提示词：重启服务，音频队列继续往里送
      const prompt = [lectures.info()?.title ? `Lecture: ${lectures.info().title}.` : '',
        settings.asrPrompt || ''].filter(Boolean).join(' ').trim();
      asr.start(settings.asrModel, { prompt })
        .catch((e) => console.error('[asr] 重启失败：', e.message));
    }

    return { settings, hotkey: hk };
  });

  /* ================================================================== */
  /*  翻译路由：在线优先，失败退回本地                                    */
  /* ================================================================== */

  /**
   * 超时给多少。
   *
   * 实时字幕给得很短（1.2 秒）：字幕的价值随时间衰减，宁可退回本地模型
   * 拿一句差一点的译文，也不能让字幕停在那里等网络。整段翻译不着急，给足。
   */
  const ONLINE_TIMEOUT = { live: 1200, batch: 8000, lookup: 2500 };

  /**
   * 翻一句，**不过术语表**：先试在线，不行退本地。
   *
   * 「原始输出」这条通道是术语表探测必须用的——探测要问的就是
   * 「模型把这个词译成什么」，拿一份已经被术语表修正过的译文去探，
   * 探到的永远是用户自己写的译名，整个机制就空转了。
   *
   * @param kind live | batch | lookup，只决定超时
   */
  async function translateRaw(text, kind = 'lookup') {
    if (online?.available) {
      const r = await online.translate(text, { timeoutMs: ONLINE_TIMEOUT[kind] });
      if (r.ok) return { ok: true, text: r.text, ms: r.ms, via: 'online' };
      /* 失败不报给用户：退回本地是正常的降级路径，上课途中弹一堆
         「网络不好」只是噪音。统计在设置页里能看到。 */
    }
    if (!translator?.available) {
      return { ok: false, reason: online?.enabled ? '在线翻译失败，且未安装本地模型' : '未安装翻译模型' };
    }
    const r = await translator.translate(text);
    return r?.ok ? { ...r, via: 'local' } : r;
  }

  /**
   * 翻一句并过术语表。
   *
   * 术语表在两条路上都要生效——在线模型也有自己的偏好
   * （replay buffer → 重播缓冲区），用户想统一译名就该管得住它。
   */
  async function translateOne(text, kind = 'lookup') {
    const r = await translateRaw(text, kind);
    return r?.ok ? { ...r, text: fixTerms(text, r.text) } : r;
  }

  /* ================================================================== */
  /*  术语表：在机器翻译的输出上做一层用户可控的修正                      */
  /* ================================================================== */

  /**
   * 整张术语表缓存在内存里。
   *
   * 每译一句都要拿全表来匹配，走数据库的话一节课几百句就是几百次全表扫描。
   * 条目上限 2000 条，全读出来也就几百 KB。改动走 gloss:* 那几个 handler，
   * 都会顺手把缓存清掉，所以不存在读到旧数据的窗口。
   */
  let glossCache = null;
  const glossRows = () => (glossCache ||= user.glossary());
  const glossInvalidate = () => { glossCache = null; };

  /** 这个会话里已经探测过的术语，避免模型报错时反复重试 */
  const probedThisRun = new Set();

  /** 框架句对照的译文只用算一次，整个会话复用 */
  let probeCtrlZh = null;
  async function probeControl() {
    if (probeCtrlZh !== null) return probeCtrlZh;
    const r = await translateRaw(PROBE_FRAME(PROBE_CONTROL), 'lookup');
    probeCtrlZh = r?.ok ? r.text : '';
    return probeCtrlZh;
  }

  /**
   * 问模型「它把这个术语译成什么」，结果落库。
   *
   * 三种问法全用、结果取并集，因为实测**模型对同一术语的错译不是固定的**：
   *   A 裸术语       replay buffer          → 重放缓冲    对上句子里的 2/8
   *   B 带冠词       the replay buffer      → 重放缓冲    2/8
   *   C 框架句做差   We use the X. 减对照   → 重播缓冲    5/8
   * 并集 6/8。只用 A（最初的做法）八条里只有两条真能生效。
   * 剩下两条对不上的其中一条根本修不了：scalar reward 被整段译成「一笔奖金」，
   * 术语在译文里压根没出现，任何替换都无从下手。
   * 数据出处：scripts/probe-glossary-carriers.js
   *
   * 故意不 await 在字幕链路上：探一条要三四秒，实时字幕等不起。
   * 探测期间该术语不生效，探完之后的句子才生效。
   */
  async function probeTerms(rows) {
    /* 对**当前实际在用的通道**探测。开了在线就探在线的错法，
       否则术语表在在线译文上一条都不会命中。探到的写法是并集，
       所以来回切通道只会越攒越全，不会互相冲掉。 */
    if (!translator?.available && !online?.available) return false;
    let changed = false;
    for (const r of rows) {
      if (probedThisRun.has(r.term)) continue;
      probedThisRun.add(r.term);
      const term = r.surface || r.term;
      const forms = new Set();
      try {
        for (const text of [term, `the ${term}`]) {
          const out = await translateRaw(text, 'lookup');
          const f = out?.ok ? cleanProbe(out.text) : null;
          if (f) forms.add(f);
        }
        const [frame, ctrl] = [await translateRaw(PROBE_FRAME(term), 'lookup'), await probeControl()];
        if (frame?.ok && ctrl) {
          const f = cleanProbe(diffMiddle(frame.text, ctrl));
          // 差异段里混进了框架自己的字就不能要，详见 frameDiffOk
          if (f && frameDiffOk(f, ctrl)) forms.add(f);
        }
      } catch { /* 探测失败不影响翻译本身 */ }

      /* 一个也没拿到就不写库：写了会让 needProbe 以为问过了，
         而实际上是模型那次出错，下次启动还该再问一遍。 */
      if (!forms.size) continue;
      /* 与已有的并集，不是覆盖：两个翻译模型（opus / nllb）错得不一样，
         用户在设置里换模型后会探到新写法，旧的仍然要留着。
         反正替换要过「英文原文里必须出现这个术语」那道门槛，多存不危险。 */
      const merged = [...new Set([...(r.wrong || []), ...forms])];
      user.setTermWrong(r.term, merged);
      r.wrong = merged;
      changed = true;
    }
    if (changed) glossInvalidate();
    return changed;
  }

  /**
   * 对一条「英文 → 机器译文」应用术语表。
   *
   * @returns 修正后的译文（没有术语表或没命中时原样返回）
   */
  function fixTerms(en, zh) {
    if (!zh) return zh;
    const rows = glossRows();
    if (!rows.length) return zh;

    const hits = matchTerms(en, rows);
    if (!hits.length) return zh;

    const r = applyGlossary(zh, hits);
    if (r.applied.length) {
      // 让用户能在术语表里看出哪几条真的在起作用
      const counts = {};
      for (const a of r.applied) {
        const row = hits.find((h) => (h.surface || h.term) === a.term);
        if (row) counts[row.term] = (counts[row.term] || 0) + 1;
      }
      try { user.bumpTermHits(counts); } catch { /* 计数失败无所谓 */ }
    }

    /* 还没问过模型的，后台补上，下一句就能生效。
     *
     * 但记录进行中绝不探测：探测本身要跑一次模型，而实测翻译进程和 whisper
     * 会抢 CPU（一节课只识别出四分之一那次就是这么来的）。上课时插进来几十次
     * 额外推理，代价是丢字幕——换来的只是某个术语早几分钟生效。
     * 加术语那一刻已经探过了，这里只是补漏。 */
    if (!lectures?.active) {
      const todo = needProbe(hits);
      if (todo.length) probeTerms(todo).catch(() => {});
    }

    return r.text;
  }

  handle('gloss:all', () => user.glossary());
  handle('gloss:put', (entry) => {
    const r = user.putTerm(entry);
    if (!r.ok) return r;
    glossInvalidate();
    /* 新加的条目立刻探测。这时用户在设置页，不是在等字幕，
       花一秒换来「加完就能用」，比留到第一次命中时才探要好。 */
    probedThisRun.delete(r.term);
    const row = user.glossary().find((x) => x.term === r.term);
    if (row) probeTerms([row]).catch(() => {});
    return r;
  });
  handle('gloss:delete', (term) => { const r = user.deleteTerm(term); glossInvalidate(); return r; });
  handle('gloss:import', async ({ text, replace } = {}) => {
    /* 覆盖导入会清空用户手打的全部术语，且没有撤销。
       用原生对话框而不是渲染层的 confirm：和「恢复备份」保持一致，
       而且 Electron 里 window.confirm 会阻塞渲染进程。 */
    if (replace && user.glossaryCount() > 0) {
      const { response } = await dialog.showMessageBox(mainWin, {
        type: 'warning',
        buttons: ['取消', '清空并导入'],
        defaultId: 0,
        cancelId: 0,
        title: '覆盖导入术语表',
        message: `这会先删掉现有的 ${user.glossaryCount()} 条术语`,
        detail: '删掉的条目无法恢复。如果只是想加新的，请用「追加导入」。',
      });
      if (response !== 1) return { ok: false, reason: '已取消' };
    }
    const r = user.importGlossary(text, { replace });
    if (r.ok) {
      glossInvalidate();
      resetTermProbes();
      // 导入可能是几十条，全部探完要几十秒，放后台慢慢跑
      probeTerms(user.glossary()).catch(() => {});
    }
    return r;
  });
  /** 让所有术语重新进入「待探测」状态。换翻译模型后必须调一次 */
  function resetTermProbes() {
    probedThisRun.clear();
    probeCtrlZh = null;   // 对照译文是上一个模型给的，换了模型就不能再用
  }

  /**
   * 起步包：按课程方向预置的术语。返回每个包里有多少条、你已经有了几条，
   * 界面据此显示「导入」还是「已导入」。
   */
  handle('gloss:packs', () => {
    const { listPacks, packById, COMMON_WORDS } = require('./glossary-packs');
    const { parseGlossary } = require('./glossary');
    const have = new Set(user.glossary().map((r) => r.term));
    return listPacks().map((p) => {
      const { terms } = parseGlossary(packById(p.id).text);
      return {
        ...p,
        count: terms.length,
        have: terms.filter((t) => have.has(t.term)).length,
        sample: terms.slice(0, 5).map((t) => `${t.surface} → ${t.zh}`),
        // 收了日常常见词的包要醒目地提示适用范围（见 glossary-packs.js 的选词原则）
        caution: terms.some((t) => COMMON_WORDS.has(t.term)),
      };
    });
  });

  /**
   * 导入一个起步包。已有的术语一律不动——你自己写的译名是你的课上的说法，
   * 起步包只是通行译法，不该覆盖你的。
   */
  handle('gloss:importPack', (id) => {
    const { packById } = require('./glossary-packs');
    const pack = packById(id);
    if (!pack) return { ok: false, reason: '没有这个起步包' };
    const r = user.importGlossary(pack.text, { keepExisting: true });
    if (r.ok && r.count) {
      glossInvalidate();
      /* 只探新加进来的（wrong 还是空的那些）。别 resetTermProbes：
         那是换模型时用的，会把已经探过的全部重探一遍。 */
      probeTerms(user.glossary().filter((row) => !row.wrong?.length)).catch(() => {});
    }
    return { ...r, name: pack.name };
  });

  /** 手动重探：换了翻译模型之后用得上 */
  handle('gloss:reprobe', async () => {
    if (!translator?.available && !online?.available) return { ok: false, reason: '未安装翻译模型' };
    resetTermProbes();
    await probeTerms(user.glossary());
    return { ok: true, terms: user.glossary() };
  });

  /* ---- 机器翻译兜底 ---- */
  handle('mt:status', () => ({
    available: !!translator?.available || !!online?.available,
    localAvailable: !!translator?.available,
    online: online ? online.stats() : null,
    onlineProviders: OnlineTranslator.providers(),
    /* 提示语要跟着实际用的通道变：在线服务把数字和术语都修对了，
       还挂着「专业术语可能不准」会让人不敢用。 */
    caveat: online?.available
      ? '在线翻译，质量较好；断网会自动退回本地模型'
      : '本地机器翻译，专业术语与数字可能不准',
  }));

  ipcMain.handle('mt:translate', async (_e, text) => {
    if (!translator) return { ok: false, reason: '翻译模块未初始化' };
    return translateOne(text, 'lookup');
  });

  /**
   * 整段翻译。逐句进度回推给发起请求的那个窗口——
   * 一段话要好几秒，界面得能一句句显示，不然只能干等。
   */
  ipcMain.handle('mt:translateLong', async (e, text, token) => {
    if (!translator) return { ok: false, reason: '翻译模块未初始化' };
    const wc = e.sender;
    const push = (p) => { if (!wc.isDestroyed()) wc.send('mt:progress', { token, ...p }); };

    /* 在线通道：一次请求就能翻好几句（实测 4 句 531ms），
       比本地逐句快一个数量级。切句仍用本地那套规则——缩写、小数点、
       列表标记那些坑都在里面，不该为在线再写一份。 */
    if (online?.available) {
      const { splitSentences } = require('./sentence-split');
      const parts = splitSentences(String(text || '').trim());
      if (!parts.length) return { ok: false, reason: '没有可翻译的句子' };
      push({ done: 0, total: parts.length });
      const r = await online.translateLines(parts, { timeoutMs: ONLINE_TIMEOUT.batch });
      if (r.ok) {
        const sentences = parts.map((src, i) => ({ src, out: fixTerms(src, r.texts[i] || '') }));
        push({ done: parts.length, total: parts.length });
        return {
          ok: true,
          ms: r.ms,
          via: 'online',
          text: sentences.map((x) => x.out).join(''),
          sentences,
          truncated: null,
        };
      }
      // 失败就落到下面的本地通道，用户不需要重试
    }

    const r = await translator.translateLong(text, push);
    if (!r?.ok || !r.sentences) return r;
    /* 按句修而不是对整段修：术语表的门槛是「英文原文里出现过」，
       逐句对照才能保证改的是对应那一句，否则 A 句的术语会去改 B 句的字。 */
    const sentences = r.sentences.map((x) => ({ ...x, out: fixTerms(x.src, x.out) }));
    return { ...r, sentences, via: 'local', text: sentences.map((x) => x.out).join('') };
  });

  /* ---- 每日目标 ---- */
  /* ================================================================== */
  /*  实时字幕（上课听写 + 双语记录）                                    */
  /* ================================================================== */

  /**
   * 整条流水线放在主进程，渲染层只负责采音。
   *
   * 这样做的理由：识别与翻译都是长耗时的跨进程调用，放渲染层的话
   * 界面一刷新（或者用户不小心 Ctrl+R）正在进行的一节课就断了；
   * 而且落盘要在主进程做，中间再倒一手只是多一层出错的地方。
   */
  const lec = {
    /** 待识别的音频队列。识别是串行的，堆积过多说明机器跟不上 */
    queue: [],
    busy: false,
    dropped: 0,
    lagWarned: false,
  };

  /* 字幕事件要同时发给主窗口和悬浮窗：两边都可能在显示同一条流水线的结果
     （课堂页在看历史、悬浮窗在放电影字幕），漏一个就有一边不动。 */
  const lecSend = (channel, payload) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
    if (subWin && !subWin.isDestroyed()) subWin.webContents.send(channel, payload);
  };

  handle('asr:status', () => ({
    ...asr.status(),
    mtModels: translator.installedModels(),
    mtModel: translator.model,
    maxChunkSec: LECTURE_MAX_CHUNK_SEC,
    silenceMs: settings.lectureSilenceMs,
    // 采音层要据此决定是否发「说到一半」的快照
    rolling: !!settings.lectureRolling && !!rollAsr?.available,
    rollingMs: settings.lectureRollingMs,
    recording: lectures.active,
    session: lectures.info(),
  }));

  handle('lec:start', async ({ title, source, sourceLabel } = {}) => {
    if (lectures.active) return { ok: false, reason: '已经在记录了' };
    if (!asr.available) {
      return { ok: false, reason: '没有安装语音识别组件，请先运行 npm run fetch:asr' };
    }

    const modelKey = asr.installedModels().some((m) => m.key === settings.asrModel)
      ? settings.asrModel : (asr.installedModels()[0]?.key || 'base');

    /* 课程名拼在提示词前面：课程名里往往就有最关键的领域词
       （"Reinforcement Learning"、"Organic Chemistry"），
       让 whisper 知道这节课在讲什么，同音词的选择会明显准一些。 */
    const prompt = [title ? `Lecture: ${title}.` : '', settings.asrPrompt || '']
      .filter(Boolean).join(' ').trim();

    try {
      await asr.start(modelKey, { prompt });
    } catch (e) {
      return { ok: false, reason: e.message };
    }

    lec.queue.length = 0;
    lec.busy = false;
    lec.dropped = 0;
    lec.lagWarned = false;
    startRollAsr();

    /* 记录期间临时切到实时专用的翻译模型，停止时切回来。
       两个模型在工作进程里各自缓存，来回切不会重新加载。 */
    lec.prevMtModel = translator.model;
    if (settings.lectureMtModel && settings.lectureMtModel !== translator.model) {
      translator.setModel(settings.lectureMtModel);
    }

    const info = await lectures.start({
      title,
      formats: settings.lectureFormats,
      meta: {
        sourceLabel: sourceLabel || source || '未知',
        asrModel: modelKey,
        mtModel: translator.available ? translator.model : '（未启用）',
      },
    });
    console.log(`[lecture] 开始记录「${info.title}」→ ${info.dir}`);
    return { ok: true, session: info, asrModel: modelKey, mtModel: translator.model };
  });

  /**
   * 收一段音频。故意用 on 而不是 handle：渲染层不该等识别结果，
   * 结果通过 lec:segment / lec:translated 事件回推。
   */
  ipcMain.on('lec:feed', (_e, payload) => {
    if (!lectures.active) return;
    const { pcm, startMs } = payload || {};
    if (!pcm) return;
    // 结构化克隆过来的是 ArrayBuffer，转回 Float32 视图
    const audio = new Float32Array(pcm);

    /* 队列积压说明识别跟不上（换了 small 模型、或者机器一时被别的程序占满）。
       上限给到 12 段（约一分钟音频）：base 模型有 3.6 倍余量，正常情况下压根不会积压，
       留这么多是为了扛住偶发的卡顿——一分钟的积压大约 17 秒就能追平。
       再多就只能丢最旧的：字幕的价值随时间衰减得很快，而且内存也不能无限涨。
       先警告、后丢弃，让人有机会换成「快速」模型。 */
    if (lec.queue.length >= 6 && !lec.lagWarned) {
      lec.lagWarned = true;
      lecSend('lec:warn', {
        message: '识别有些跟不上语速，字幕会延迟。可以在设置里把识别模型换成「快速」。',
      });
    }
    if (lec.queue.length >= 12) {
      lec.queue.shift();
      lec.dropped += 1;
    }
    lec.queue.push({ audio, startMs, queuedAt: Date.now() });
    drainLecture();
  });

  /* ---- 滚动字幕（临时稿）----
   *
   * 正式字幕要等一句话说完才出（VAD 切段），实测那是 5 秒左右的延迟，
   * 占了用户感受到的「卡」的绝大部分。这里拿「说到一半」的音频先识别一遍，
   * 边说边把临时稿推到界面上，说完了再被正式字幕替换掉。
   *
   * 三条纪律：
   * 1. 临时稿**绝不落盘**。文件里只能有定稿，否则转写稿会重复一堆半句。
   * 2. 正式字幕优先。有正式活儿在跑就跳过这一次临时稿。
   * 3. 过期的就丢掉，不排队。临时稿的价值在「现在」，攒起来毫无意义。
   */
  const roll = { busy: false, seq: 0, lastText: '', lastMtAt: 0 };

  /* 临时稿的译文节流。
   *
   * 临时稿每 1.5 秒出一版，而连续两版是「越来越长的前缀」，缓存一次都命不中——
   * 一节 50 分钟的课就是约 2000 次在线请求。实测这个免费端点会限流
   * （连发二十来次就吃过一次 HTTP 429），把额度花在临时稿上不划算：
   * 它几秒后就被定稿覆盖，而定稿的译文才是要留进文件的。
   * 所以临时稿的译文最多 2.5 秒给一次，定稿不受限制。 */
  const ROLL_MT_EVERY = 2500;

  async function handlePartial(pcm) {
    if (!settings.lectureRolling || !lectures.active) return;
    if (roll.busy) return;                    // 上一份还在跑，这份直接丢
    if (lec.busy || lec.queue.length) return; // 正式字幕优先
    if (!rollAsr.available) return;

    roll.busy = true;
    const myTurn = ++roll.seq;
    const t0 = Date.now();
    try {
      const r = await rollAsr.transcribe(pcm, { baseMs: 0 });
      // 跑完发现已经有更新的一轮了，这份就作废
      if (myTurn !== roll.seq || !lectures.active) return;

      const text = r.segments.map((x) => x.text.trim()).filter(Boolean).join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || /^[\s.,!?\-—[\]()]*$/.test(text) || /^\[.*\]$/.test(text)) return;
      if (text === roll.lastText) return;     // 没变化就不必刷界面
      roll.lastText = text;

      const asrMs = Date.now() - t0;
      lecSend('lec:partial', { en: text, ms: asrMs });
      console.log(`[lat] 临时稿 ${(pcm.length / 16000).toFixed(1)}s 识别 ${asrMs}ms`);

      /* 临时稿的译文只在**在线翻译可用**时才给。
         本地模型一句要 300ms 且和识别抢 CPU，每 1.5 秒来一次会把正式
         字幕拖慢——用延迟换译文，方向正好反了。在线是 40~300ms 且不占本机 CPU。 */
      if (online?.available && Date.now() - roll.lastMtAt >= ROLL_MT_EVERY) {
        roll.lastMtAt = Date.now();
        const tr = await online.translate(text, { timeoutMs: ONLINE_TIMEOUT.live });
        if (tr.ok && myTurn === roll.seq && lectures.active) {
          lecSend('lec:partial', { en: text, zh: fixTerms(text, tr.text), ms: asrMs });
        }
      }
    } catch (e) {
      const shuttingDown = !lectures.active
        || /ECONNRESET|socket hang up|ECONNREFUSED/i.test(e.message);
      if (!shuttingDown) console.error('[roll] 临时稿失败：', e.message);
    } finally {
      roll.busy = false;
    }
  }

  /**
   * 起/停临时稿服务。
   *
   * 故意**不 await**：它只影响临时稿，起得慢一点无所谓，
   * 但绝不能因为它启动失败或者慢就把整节课的录制拦住。
   */
  function startRollAsr() {
    if (!settings.lectureRolling || !rollAsr?.available) return;
    const want = rollAsr.installedModels().some((m) => m.key === settings.lectureRollingModel)
      ? settings.lectureRollingModel
      : (rollAsr.installedModels()[0]?.key || 'base');
    // 临时稿不传提示词：它只求快，提示词会让每次推理都多背一段上下文
    rollAsr.start(want, { prompt: '' })
      .catch((e) => console.error('[roll] 启动失败（不影响正式字幕）：', e.message));
  }

  function stopRollAsr() {
    roll.seq += 1;
    roll.lastText = '';
    try { rollAsr?.stop(); } catch { /* 忽略 */ }
  }

  ipcMain.on('lec:partial', (_e, payload) => {
    if (!payload?.pcm) {
      /* 采音层说「没话了」。要主动撤掉临时稿——这种情况下不会有定稿
         来覆盖它，不撤的话最后半句（甚至 whisper 在尾音上编出来的整句）
         会一直挂在屏幕上。 */
      roll.seq += 1;
      roll.lastText = '';
      if (lectures.active) lecSend('lec:partial', { en: '', zh: '' });
      return;
    }
    handlePartial(new Float32Array(payload.pcm)).catch(() => {});
  });

  async function drainLecture() {
    if (lec.busy || !lec.queue.length || !lectures.active) return;
    lec.busy = true;
    const job = lec.queue.shift();
    /* 分段计时。
     *
     * 「字幕慢」有四个来源，靠感觉分不清是哪一个：
     *   1. 等说话人停顿（VAD 要 420ms 静音才切，或攒到 9 秒强切）
     *   2. 排队（上一块还在识别）
     *   3. 识别
     *   4. 翻译
     * 只有 3 和 4 换在线服务能改善，而 1 往往是最大的一项。
     * 没有这组数字就会去优化错的东西。 */
    const tQueued = job.queuedAt || Date.now();
    const tStart = Date.now();
    try {
      const r = await asr.transcribe(job.audio, { baseMs: job.startMs });
      const asrMs = Date.now() - tStart;

      /* whisper 会把一个音频块再切成好几个 segment（按它自己的换行规则），
         这些内部切分必须合回一条——句子边界已经由 VAD 决定了。
         不合的话一句话会被劈成两条字幕，而且喂给翻译的是残句：
         实测 "...fundamentals of reinforcement" / "learning." 被分开后，
         前半句译成了「加强部队的基本内容」。 */
      const text = r.segments.map((x) => x.text.trim()).filter(Boolean).join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      // 静音块偶尔会得到 "[BLANK_AUDIO]" 或纯标点，这些不该进记录
      if (!text || /^[\s.,!?\-—[\]()]*$/.test(text) || /^\[.*\]$/.test(text)) return;
      if (!lectures.active) return;

      /* 时间用音频块自己的起止，而不是 whisper 给的段时间：
         块的时间来自采样计数，是准的；whisper 的段时间是估计值。 */
      const t0 = job.startMs;
      const t1 = job.startMs + (job.audio.length / 16000) * 1000;

      const id = lectures.addSegment({ t0, t1, en: text });
      lecSend('lec:segment', { id, t0, t1, en: text });
      // 定稿到了，临时稿该退场；同时作废在途的那一轮
      roll.seq += 1;
      roll.lastText = '';
      lecSend('lec:partial', { en: '', zh: '' });

      /* 字幕出现时，这句话已经说完多久了。
         这才是用户感受到的延迟——不是识别耗时。 */
      const audioMs = (job.audio.length / 16000) * 1000;
      lec.lastLatency = {
        chunkSec: +(audioMs / 1000).toFixed(1),
        waitMs: tStart - tQueued,      // 排队
        asrMs,
        words: text.split(/\s+/).length,
      };
      console.log(`[lat] 块 ${lec.lastLatency.chunkSec}s`
        + ` 排队 ${lec.lastLatency.waitMs}ms 识别 ${asrMs}ms`
        + ` (${lec.lastLatency.words} 词)`);

      // 翻译不阻塞下一块音频的识别，两个进程天然并行
      translateSegment(id, text);
    } catch (e) {
      /* 停止记录时会 kill 掉识别服务，在途请求必然报 ECONNRESET/socket hang up。
         那不是故障，不该当成错误报给用户。 */
      const shuttingDown = !lectures.active || /ECONNRESET|socket hang up|ECONNREFUSED/i.test(e.message);
      if (!shuttingDown) {
        console.error('[lecture] 识别失败：', e.message);
        lecSend('lec:warn', { message: `识别失败：${e.message}` });
      }
    } finally {
      lec.busy = false;
      if (lec.queue.length) setImmediate(drainLecture);
    }
  }

  async function translateSegment(id, text) {
    if (!translator.available && !online?.available) {
      // 两条路都没有也要放行，否则记录队列会永久卡在这一条
      lectures.setTranslation(id, null);
      lecSend('lec:translated', { id, zh: null, reason: '未安装翻译模型' });
      return;
    }
    const t0 = Date.now();
    const r = await translateOne(text, 'live');
    const mtMs = Date.now() - t0;
    const zh = r && r.ok ? r.text : null;
    lectures.setTranslation(id, zh);
    lecSend('lec:translated', { id, zh, reason: r && r.ok ? null : r?.reason });
    console.log(`[lat] 翻译 ${mtMs}ms (${text.split(/\s+/).length} 词,`
      + ` ${r?.via === 'online' ? online.provider : translator.model})`);
  }

  handle('lec:stop', async () => {
    if (!lectures.active) return { ok: false, reason: '没有在记录' };
    /* 先把队列里剩的音频识别完再收尾，否则最后十几秒会丢。
     *
     * 判据是「还有没有进展」，不是固定的墙钟时间。原先写死等 25 秒，
     * 结果积压时会静默丢内容——实测打包版里 13 段只落盘 7 段，
     * 剩下的正好卡在超时那一刻。真实上课不会积压（每 5 秒来一段、识别 1.4 秒），
     * 但机器偶尔卡一下就该等它追完，而不是把课丢掉。
     *
     * 只要队列在变短就一直等；连续 20 秒毫无进展才放弃（那说明识别真的挂了）。
     */
    const STALL_MS = 20_000;
    let lastLen = lec.queue.length + (lec.busy ? 1 : 0);
    let lastProgress = Date.now();
    while (lec.queue.length || lec.busy) {
      await new Promise((r) => setTimeout(r, 200));
      const len = lec.queue.length + (lec.busy ? 1 : 0);
      if (len < lastLen) {
        lastLen = len;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > STALL_MS) {
        console.warn(`[lecture] 收尾时识别停滞，放弃剩余 ${lec.queue.length} 段`);
        break;
      }
    }
    const out = await lectures.stop();
    asr.stop();
    stopRollAsr();
    if (lec.prevMtModel) {
      translator.setModel(lec.prevMtModel);
      lec.prevMtModel = null;
    }
    console.log(`[lecture] 记录结束：${out.segments} 条，${out.dir}`);
    return { ok: true, ...out, dropped: lec.dropped };
  });

  /**
   * 自测用：按真实节奏把一整段 PCM 喂进实时链路。
   *
   * 节奏必须在主进程里控制。原先放在渲染层用 setTimeout 分几百次喂，
   * 打包版跑到这步卡了 19 分钟只出 2 条——Chromium 会把不可见窗口的定时器
   * 限流到每秒一次。主进程没有这个限制。
   *
   * 这里用的是和真实采音同一个 VadChunker、同一个 lec:feed 通道，
   * 所以除「拿到麦克风音频」之外的每一环都被覆盖。
   */
  handle('lec:selfTestFeed', async ({ pcm, speed = 4 } = {}) => {
    if (!lectures.active) return { error: '没有正在进行的记录' };
    const { VadChunker } = require('./vad-chunker');
    const audio = new Float32Array(pcm);
    const vad = new VadChunker({
      rate: 16000,
      maxMs: LECTURE_MAX_CHUNK_SEC * 1000,
      silenceMs: settings.lectureSilenceMs,
    });

    const sliceMs = 100;
    const step = Math.round(16000 * (sliceMs / 1000));
    const paceMs = Math.max(1, Math.round(sliceMs / speed));
    let fed = 0;
    let partials = 0;
    let lastPartial = 0;

    for (let i = 0; i < audio.length; i += step) {
      const part = audio.subarray(i, Math.min(i + step, audio.length));
      const cuts = vad.push(part);
      for (const cut of cuts) {
        /* 走和渲染层完全一样的入队路径，包括积压丢弃逻辑。
           直接调 drainLecture 会绕开那部分，验证就不完整了。 */
        lec.queue.push({ audio: cut.pcm, startMs: cut.startMs, queuedAt: Date.now() });
        fed += 1;
        drainLecture();
      }

      /* 临时稿也要在自测里走一遍，判断逻辑照抄 audio-source.js：
         刚切过段就跳过、按倍速换算间隔。不加这一段的话滚动字幕
         在自动化里完全没被覆盖过，而它恰好是没法用麦克风验证的那部分。 */
      if (settings.lectureRolling && !cuts.length) {
        const now = Date.now();
        const every = Math.max(150, Math.round((settings.lectureRollingMs || 1500) / speed));
        if (now - lastPartial >= every) {
          lastPartial = now;
          const snap = vad.peek();
          if (snap && snap.sawSpeech) {
            partials += 1;
            handlePartial(snap.pcm).catch(() => {});
          }
        }
      } else if (cuts.length) {
        lastPartial = Date.now();
      }
      await new Promise((r) => setTimeout(r, paceMs));
    }
    const tail = vad.flush();
    if (tail) {
      lec.queue.push({ audio: tail.pcm, startMs: tail.startMs, queuedAt: Date.now() });
      fed += 1;
      drainLecture();
    }
    return { fedSeconds: audio.length / 16000, chunks: fed, partials, speed };
  });

  /* ---- 电影字幕悬浮窗 ---- */

  /**
   * 悬浮窗共用实时字幕那条流水线（识别 + 翻译），只是**不落盘**：
   * 看电影不需要留记录，要留的话去「实时字幕」页开。
   * 所以这里给 lectures 起一个 formats 为空的会话——流水账照样写，
   * 万一看到值得记的内容还能从历史里恢复出来。
   */
  handle('sub:start', async () => {
    if (lectures.active) return { ok: false, reason: '正在记录课堂字幕，先停止那边' };
    if (!asr.available) {
      return { ok: false, reason: '没有安装语音识别组件，请先运行 npm run fetch:asr' };
    }

    const modelKey = asr.installedModels().some((m) => m.key === settings.asrModel)
      ? settings.asrModel : (asr.installedModels()[0]?.key || 'base');
    try {
      /* 影视对白不是学术演讲，领域提示词只会把它往术语上带偏，
         所以这里刻意不传 prompt。 */
      await asr.start(modelKey, { prompt: '' });
    } catch (e) {
      return { ok: false, reason: e.message };
    }

    lec.queue.length = 0;
    lec.busy = false;
    lec.dropped = 0;
    lec.lagWarned = false;
    startRollAsr();
    lec.prevMtModel = translator.model;
    if (settings.lectureMtModel && settings.lectureMtModel !== translator.model) {
      translator.setModel(settings.lectureMtModel);
    }

    const info = await lectures.start({
      title: '视频字幕',
      formats: [],     // 不生成成品文件，只留流水账
      meta: { sourceLabel: '系统声音（视频）', asrModel: modelKey, mtModel: translator.model },
    });
    console.log(`[subtitle] 开始 → ${info.dir}`);
    return { ok: true, asrModel: modelKey, mtModel: translator.model };
  });

  handle('sub:stop', async () => {
    if (!lectures.active) return { ok: true };
    const out = await lectures.stop();
    asr.stop();
    stopRollAsr();
    if (lec.prevMtModel) {
      translator.setModel(lec.prevMtModel);
      lec.prevMtModel = null;
    }
    console.log(`[subtitle] 结束，${out.segments} 条`);
    return { ok: true, ...out };
  });

  handle('sub:hide', () => { toggleSubtitleWindow(false); });
  handle('sub:toggle', (on) => toggleSubtitleWindow(on ?? null));

  /**
   * 鼠标穿透。锁定后字幕不再拦鼠标，可以点到后面的播放器。
   * forward: true 让窗口仍能收到 mousemove——否则 hover 显隐的工具条
   * 永远不会出现，用户就再也解不开锁了。
   */
  handle('sub:setLocked', (locked) => {
    if (!subWin || subWin.isDestroyed()) return false;
    subWin.setIgnoreMouseEvents(!!locked, { forward: true });
    return !!locked;
  });

  /**
   * 悬浮字幕里点了一个词。
   *
   * 悬浮窗只有两行字幕那么高，塞不下查词卡片，所以借用划词那个悬浮查词窗，
   * 贴着点击位置弹出来。语境（那一句字幕）一起带过去，
   * 在查词窗里按收藏时能记下「在哪句话里遇到的」。
   */
  handle('sub:lookup', (payload) => {
    const word = String(payload?.word || '').trim();
    if (!word) return false;
    const near = Number.isFinite(payload?.x) && Number.isFinite(payload?.y)
      ? { x: Math.round(payload.x), y: Math.round(payload.y) } : null;
    showQuickWindow(word, near, {
      context: payload?.en ? { en: payload.en, zh: payload.zh || null, src: '视频字幕' } : null,
    });
    return true;
  });

  handle('lec:list', () => lectures.list());

  /** 在全部课程的转写稿里搜关键词 */
  handle('lec:search', (query) => lectures.search(query));

  /**
   * 读一节课的全部定稿，给应用内的转写稿查看页用。
   *
   * dir 从渲染层传来，必须确认它在课堂记录目录里面——
   * 否则等于开了一个「读任意目录下 journal.jsonl」的口子。
   */
  handle('lec:read', (dir) => {
    const root = path.resolve(lectures.root);
    const want = path.resolve(String(dir || ''));
    if (!want.startsWith(root + path.sep)) return null;
    return lectures.loadTranscript(want);
  });
  handle('lec:open', (dir) => { if (dir) shell.openPath(dir); });
  handle('lec:reveal', (file) => { if (file) shell.showItemInFolder(file); });
  handle('lec:recover', (dir) => lectures.recover(dir, settings.lectureFormats));

  /* ---- 导入已有录音（课后转写） ---- */

  handle('lec:pickAudio', async () => {
    /* 截图/自测模式下直接给定文件，不弹对话框——
       实时链路要靠它喂真实语音做端到端验证（麦克风在自动化里没法喂）。 */
    const shotAudio = process.env.LEXICA_SHOT_AUDIO;
    if (shotAudio && fs.existsSync(shotAudio)) {
      const buf = await fsp.readFile(shotAudio);
      return {
        ok: true,
        path: shotAudio,
        name: path.basename(shotAudio),
        bytes: buf.byteLength,
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: '选择课堂录音',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm', 'mp4'] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, reason: '已取消' };
    const f = filePaths[0];
    try {
      /* 把字节交给渲染层解码。
         这里不用 ffmpeg —— 本机没有，而 Chromium 自带 mp3/m4a/ogg 解码器，
         渲染层用 decodeAudioData 就能解，再用 OfflineAudioContext 重采样到 16k 单声道。
         省掉一个外部依赖，格式支持面还更宽。 */
      const buf = await fsp.readFile(f);
      return {
        ok: true,
        path: f,
        name: path.basename(f),
        bytes: buf.byteLength,
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });

  /**
   * 转写整段录音。渲染层已经解码重采样成 16k 单声道 Float32 送进来。
   * 走 whisper-cli 而不是常驻服务：一次性任务不在乎模型加载，
   * 而且可以用跑不动实时的 small 模型换准确率。
   */
  handle('lec:transcribeFile', async ({ pcm, title, modelKey } = {}) => {
    if (!pcm) return { ok: false, reason: '没有音频数据' };
    if (!asr.available) return { ok: false, reason: '没有安装语音识别组件' };
    if (lectures.active) return { ok: false, reason: '正在实时记录，先停止再导入' };

    const audio = new Float32Array(pcm);
    const tmp = path.join(app.getPath('temp'), `lexica-import-${Date.now()}.wav`);
    const { wrapWav, floatToPcm16 } = require('./asr');
    await fsp.writeFile(tmp, wrapWav(floatToPcm16(audio), 16000));

    const model = asr.installedModels().some((m) => m.key === modelKey)
      ? modelKey : settings.asrModel;

    try {
      lecSend('lec:importProgress', { phase: 'asr', percent: 0 });
      const r = await asr.transcribeFile(tmp, {
        modelKey: model,
        prompt: [title ? `Lecture: ${title}.` : '', settings.asrPrompt || '']
          .filter(Boolean).join(' ').trim(),
        onProgress: (p) => lecSend('lec:importProgress', { phase: 'asr', percent: p }),
      });
      if (!r.segments.length) return { ok: false, reason: '没有识别出任何内容' };

      const info = await lectures.start({
        title: title || '导入的录音',
        formats: settings.lectureFormats,
        meta: {
          sourceLabel: '导入的录音',
          asrModel: model,
          mtModel: translator.available ? translator.model : '（未启用）',
        },
      });

      // 逐条翻译并落盘，顺便回报进度——一小时的录音会有几百条
      const total = r.segments.length;
      for (const [i, seg] of r.segments.entries()) {
        const text = seg.text.trim();
        if (!text || /^\[.*\]$/.test(text)) continue;
        const id = lectures.addSegment({ t0: seg.t0, t1: seg.t1, en: text });
        lecSend('lec:segment', { id, t0: seg.t0, t1: seg.t1, en: text });
        if (translator.available || online?.available) {
          const tr = await translateOne(text, 'batch');
          const zh = tr && tr.ok ? tr.text : null;
          lectures.setTranslation(id, zh);
          lecSend('lec:translated', { id, zh });
        } else {
          lectures.setTranslation(id, null);
        }
        lecSend('lec:importProgress', { phase: 'mt', percent: Math.round(((i + 1) / total) * 100) });
      }

      const out = await lectures.stop();
      return { ok: true, ...out, session: info };
    } catch (e) {
      if (lectures.active) await lectures.stop();
      return { ok: false, reason: e.message };
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  });

  handle('goal:progress', () => user.goalProgress(settings));

  /* ---- 用户数据备份与恢复 ---- */
  handle('backup:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
      title: '备份学习数据',
      defaultPath: `lexica-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: 'Lexica 备份', extensions: ['db'] }],
    });
    if (canceled || !filePath) return { ok: false, reason: '已取消' };
    // WAL 里可能还有没落盘的事务，先 checkpoint 再复制
    user.checkpoint();
    fs.copyFileSync(user.file, filePath);
    return { ok: true, filePath, bytes: fs.statSync(filePath).size };
  });

  handle('backup:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: '恢复学习数据',
      properties: ['openFile'],
      filters: [{ name: 'Lexica 备份', extensions: ['db'] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, reason: '已取消' };
    const src = filePaths[0];

    // 先验证是不是一个合法的 Lexica 备份，别把用户现有数据换成一个坏文件
    try {
      const probe = new (require('node:sqlite').DatabaseSync)(src, { readOnly: true });
      const t = probe.prepare(
        "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN ('wordbook','settings')",
      ).get().c;
      probe.close();
      if (t < 2) return { ok: false, reason: '这不是 Lexica 的备份文件' };
    } catch (e) {
      return { ok: false, reason: `备份文件无法读取：${e.message}` };
    }

    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'warning',
      buttons: ['取消', '覆盖并重启'],
      defaultId: 0,
      cancelId: 0,
      title: '恢复学习数据',
      message: '这会用备份覆盖当前的生词本、练习进度与设置',
      detail: '当前数据会先另存为 user.db.bak。恢复后应用将重启。',
    });
    if (response !== 1) return { ok: false, reason: '已取消' };

    user.checkpoint();
    user.close();
    try {
      fs.copyFileSync(user.file, `${user.file}.bak`);
      // WAL/SHM 属于旧库，不清掉会和新文件对不上
      for (const ext of ['-wal', '-shm']) fs.rmSync(`${user.file}${ext}`, { force: true });
      fs.copyFileSync(src, user.file);
    } catch (e) {
      return { ok: false, reason: `恢复失败：${e.message}` };
    }
    quitting = true;
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  handle('app:openLog', () => {
    const p = logger.path();
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    else shell.openPath(path.join(app.getPath('userData'), 'logs'));
  });

  /* ---- 自定义词表 ---- */
  handle('list:all', () =>
    user.lists().map((l) => ({ ...l, scope: `list:${l.id}` })));

  handle('list:create', (name, text, note) => {
    const r = user.createList(name, text, note);
    if (r.ok) quiz.invalidateCustom();
    return r;
  });

  handle('list:delete', (id) => {
    const r = user.deleteList(id);
    if (r.ok) quiz.invalidateCustom();
    return r;
  });

  handle('list:preview', (text) => {
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
    let known = 0;
    const missing = [];
    for (const w of words) {
      if (dict.lookup(w, { noHistory: true }).status === 'ok') known++;
      else if (missing.length < 12) missing.push(w);
    }
    return { total: words.length, known, missing };
  });

  handle('list:importFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: '导入单词表',
      properties: ['openFile'],
      filters: [{ name: '文本 / CSV', extensions: ['txt', 'csv', 'tsv', 'md'] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, reason: '已取消' };
    try {
      const text = fs.readFileSync(filePaths[0], 'utf8');
      return { ok: true, text, name: path.basename(filePaths[0]).replace(/\.[^.]+$/, '') };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });

  /* ---- 自定义词条 ---- */
  handle('custom:all', (limit) => user.customEntries(limit || 500));
  handle('custom:get', (word) => user.customEntry(word));
  handle('custom:put', (entry) => user.putCustomEntry(entry));
  handle('custom:delete', (word) => user.deleteCustomEntry(word));

  handle('app:openDataFolder', () => {
    const p = path.dirname(resolveDictPath());
    fs.mkdirSync(p, { recursive: true });
    shell.openPath(p);
  });

  handle('app:quickHide', () => { quickWin?.hide(); });
  handle('app:quickToMain', (word) => { quickWin?.hide(); focusMain(word); });
  handle('app:relaunch', () => { quitting = true; app.relaunch(); app.exit(0); });
}

/* ========================================================================== */
/*  开发用截图                                                                 */
/* ========================================================================== */

/**
 * 设了 LEXICA_SHOT=<输出目录> 就按脚本走一遍界面、逐张截图然后退出。
 * 用来在改完样式后快速核对两套主题的实际效果，正常启动完全不受影响。
 * 这种模式下 userData 指向临时目录，不会碰到真实的生词本。
 */
async function runShotSequence(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });

  /* 把渲染层的报错转到主进程日志。
   *
   * 没有这一条时渲染层抛的异常完全不可见：界面只是「没有变化」，
   * 日志里一行都没有，截图看起来像是某个断言写错了。实际踩过一次——
   * 一个渲染函数抛异常，后面每一张截图都是同一个首页。 */
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') {
        console.error(`[renderer:${e.level}]`, e.message, e.lineNumber ? `(${e.sourceId}:${e.lineNumber})` : '');
      }
    });
  }

  /* 上一张截图的字节，用来发现旧帧（见下面 shot 的注释） */
  const lastPng = new Map();
  let badShots = 0;

  /**
   * capturePage 返回的是「最后呈现的那一帧」，不会替你等这一步画完。
   * 所以抓之前先确认页面在出帧：invalidate() 泵一帧，再等两个 rAF。
   * rAF 跑完，说明主线程已经把这一步画进了一帧（合成器上的动画不归它管，
   * 那一类靠强制减弱动效兜住，见 BG_THROTTLE）。跑不完，说明 Chromium 把窗口
   * 当成了 hidden，这时抓到的是旧画面，而且往往只落后一步（以前 18 往后每张都
   * 慢一步：19 拍成了模式页、20 拍成了题面），跟上一张比字节是抓不出来的。
   * 所以 rAF 不跑就判这一步失败、不存图，而不是超时之后照抓不误。
   *
   * 截图模式已经关了后台节流、最小化会自动还原（见 BG_THROTTLE），正常不会走到
   * 失败分支；真走到了就先救一次（还原、提到最前），还不行再报错，退出码非零。
   */
  const painted = (win) => {
    try { win.webContents.invalidate(); } catch { /* 旧版本没有这个方法 */ }
    return Promise.race([
      win.webContents.executeJavaScript(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      ).catch(() => false),
      wait(1500).then(() => false),
    ]);
  };

  const shot = async (name, win = mainWin) => {
    const file = path.join(dir, `${name}.png`);
    try {
      win.focus();
      if (!(await painted(win))) {
        if (win.isMinimized()) win.restore();
        win.moveTop();
        await wait(400);
        if (!(await painted(win))) {
          badShots++;
          fs.rmSync(file, { force: true });   // 别让上一轮留下的同名图冒充这一轮的
          console.error('[shot] ✗', name, '窗口没在出帧（rAF 不跑），抓到的会是旧画面，这张不存');
          return;
        }
        console.log('[shot]', name, '窗口一度不出帧，还原并提到最前后恢复了');
      }

      /* capturePage 偶尔一直不 resolve，加超时兜底，单张失败不影响后面的步骤 */
      const img = await Promise.race([
        win.webContents.capturePage(),
        wait(6000).then(() => null),
      ]);
      if (!img) { console.log('[shot]', name, '超时跳过'); return; }
      const png = img.toPNG();
      fs.writeFileSync(file, png);

      /* 第二道检查。主窗口每一步都换了视图或主题，连着两张一模一样只能是旧帧。
         悬浮窗不比（40-subtitle-locked 和上一张本来就该长得一样）。 */
      if (win === mainWin && lastPng.get(win.id)?.equals(png)) {
        badShots++;
        console.error('[shot] ✗', name, '与上一张字节完全相同，抓到的是旧帧');
      } else {
        console.log('[shot]', name, 'ok');
      }
      lastPng.set(win.id, png);
    } catch (e) {
      console.log('[shot]', name, '失败:', e.message);
    }
  };

  const setTheme = async (theme) => {
    settings.theme = theme;
    try { mainWin.setTitleBarOverlay({ ...THEME_CHROME[theme], height: 60 }); } catch { /* 忽略 */ }
    broadcast('set:theme', { theme });
    await wait(700);
  };

  const lookup = async (word) => {
    mainWin.webContents.send('nav:lookup', { word });
    await wait(900);
  };

  const view = async (v) => {
    mainWin.webContents.send('nav:view', { view: v });
    await wait(700);
  };

  /**
   * 布局不变式：#stage 必须是真正的滚动容器。
   *
   * 曾经因为 .app 的隐式 grid 行是 auto 尺寸、被内容撑开，导致 #stage 长到整页高度、
   * 内部不再溢出，溢出落到 body{overflow:hidden} 上——程序化 scrollIntoView 照样能滚，
   * 截图看起来完全正常，但用户的鼠标滚轮彻底失灵。这种问题会静默回归，所以每次截图
   * 都顺手断言一次。
   */
  const assertScrollable = async () => {
    const r = await mainWin.webContents.executeJavaScript(`
      (() => {
        const s = document.querySelector('#stage');
        const d = document.querySelector('#view-dict');
        return {
          stageScrollable: s.scrollHeight > s.clientHeight,
          bodyOverflows: document.body.scrollHeight > document.body.clientHeight,
          /* 出问题时要能分清「布局坏了」和「页面压根没渲染」。
             只报 scrollHeight 的话两种情况长得一模一样。 */
          stageH: s.scrollHeight,
          clientH: s.clientHeight,
          sections: d ? d.querySelectorAll('.section').length : -1,
          head: d?.querySelector('.head-text')?.textContent?.trim() || null,
        };
      })()
    `);
    if (!r.stageScrollable || r.bodyOverflows) {
      console.error('[shot] ✗ 布局异常：#stage 不是滚动容器，鼠标滚轮将失灵', r);
    } else {
      console.log('[shot] ✓ 滚动容器正常（#stage）');
    }
  };

  /**
   * 把内容区滚到指定选择器处，用来给页面下半部分（词源、引文、折叠按钮）截图。
   * 用 scrollIntoView 而不是 offsetTop —— 目标元素的定位祖先不是滚动容器，
   * offsetTop 算出来的偏移和 #stage 的 scrollTop 不在同一坐标系里。
   */
  const scrollTo = async (selector) => {
    const found = await mainWin.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        return true;
      })()
    `);
    if (!found) console.log('[shot] 未找到', selector);
    await wait(600);
  };

  /**
   * 轮询等元素出现，返回等到没等到。
   *
   * 渲染层几乎每个视图都是「先画个占位、异步拉完数据再重画」，
   * 固定 wait 多少都是在赌机器快慢（loadDrill() 要等四个 IPC，
   * drillStart() 还要再等一次出题）。要等的是 DOM，就直接等 DOM。
   */
  const waitFor = async (selector, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ok = await mainWin.webContents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      ).catch(() => false);
      if (ok) return true;
      if (Date.now() >= deadline) return false;
      await wait(120);
    }
  };

  /**
   * 等元素出现再点；等不到就抛，让整个流程以非零码退出。
   *
   * 原先是「固定 wait 之后单点一次，点不到打一行日志继续往下走」。
   * 考纲练习那一段因此长期静默失效：日志里躺着三行「点不到」，
   * 后面四张截图拍的全是上一个状态，而流程照样 exit 0。
   * 自测里「没点到」和「点了但结果不对」是一回事，都该红。
   */
  const click = async (selector, waitMs = 800, timeoutMs = 12000) => {
    if (!(await waitFor(selector, timeoutMs))) {
      throw new Error(`[shot] 等不到可点的元素：${selector}（等了 ${timeoutMs}ms）`);
    }
    await mainWin.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
    await wait(waitMs);
  };

  /* 等词库真的就绪，不要靠固定时长。
   *
   * 原先是 `await wait(1600)`。词库 1.2 GB，文件不在系统缓存里时打开更慢
   * （连着跑几个 Electron 实例就会把缓存挤掉），慢一点第一次查词就会落空：
   * go() 见 state.stats.ready 为假直接 return，界面停在首页，
   * 然后第一条布局断言报「#stage 不是滚动容器」——看着像布局坏了，
   * 其实是词库还没加载完。排查这个花了不少时间，所以改成显式等待。 */
  for (let i = 0; i < 60; i++) {
    const ok = await mainWin.webContents.executeJavaScript(
      '!!window.__lexicaShot?.ready?.()',
    ).catch(() => false);
    if (ok) break;
    await wait(500);
  }
  await wait(400);   // 首页渲染完

  await lookup('run');

  await assertScrollable();
  await shot('01-entry-paper');

  await lookup('ephemeral');
  await shot('02-entry-paper-gre');

  await setTheme('glass');
  await shot('03-entry-glass');

  await lookup('meticulous');
  await shot('04-entry-glass-2');

  await view('wordbook');
  await shot('05-wordbook-glass');

  await setTheme('paper');
  await shot('06-wordbook-paper');

  await view('review');
  await shot('07-review-paper');

  await view('settings');
  await shot('08-settings-paper');

  await view('dict');
  mainWin.webContents.send('nav:lookup', { word: 'recieve' });
  await wait(1000);
  await shot('09-misspelling-correction');

  await lookup('children');
  await shot('10-inflection-redirect');

  // 易混词区块
  await lookup('principal');
  await scrollTo('.confuse-list');
  await shot('25-confusables');

  // 中文反查
  mainWin.webContents.send('nav:lookup', { word: '光合作用' });
  await wait(900);
  await shot('11-chinese-lookup');

  // 悬浮查词窗（两套主题各来一张）
  showQuickWindow('serendipity');
  await wait(1400);
  await shot('12-quick-paper', quickWin);

  await setTheme('glass');
  await wait(500);
  await shot('13-quick-glass', quickWin);

  // 划词场景：悬浮窗里查一个词库没有的学术词组，看拆解 + 机器翻译
  await setTheme('paper');
  showQuickWindow('ablation study');
  await wait(4000); // 模型已在后台预热过，这里只等一次推理
  await shot('29-quick-phrase-fallback', quickWin);

  // 划到整句：悬浮窗里给术语对照 + 双语逐句译文
  await setTheme('paper');
  showQuickWindow('The mitochondria generate adenosine triphosphate through oxidative phosphorylation.');
  await wait(6000); // 逐句翻译，一句约 1 秒
  await shot('30-quick-sentence', quickWin);
  quickWin?.hide();

  // 页面下半部分：义项折叠按钮、词源、古典引文
  await setTheme('paper');
  quickWin?.hide();
  await lookup('run');
  await scrollTo('.fold-btn');
  await shot('14-sense-folding');

  await lookup('candid');
  await scrollTo('.etym');
  await shot('15-etymology-quotes');

  await setTheme('glass');
  await lookup('abandon');
  await scrollTo('.etym');
  await shot('16-etymology-glass');

  /* 拼写题与自定义页 */
  await setTheme('paper');
  mainWin.webContents.send('nav:view', { view: 'drill' });
  await wait(900);
  await mainWin.webContents.executeJavaScript(`
    (async () => {
      const app = window.__lexicaShot;
      if (app) await app.startSpellQuiz();
    })()
  `).catch(() => {});
  await wait(1400);
  await shot('26-spell-question');

  await mainWin.webContents.executeJavaScript(`
    (() => {
      const i = document.querySelector('#spellInput');
      if (i) { i.value = 'meticulus'; }
      const b = document.querySelector('[data-act="drill-spell"]');
      if (b) b.click();
    })()
  `).catch(() => {});
  await wait(1200);
  await shot('27-spell-feedback');

  await view('custom');
  await shot('28-custom-lists');

  /* 在线翻译默认关，而 shot 用的是每次全新的 profile，
     所以要验证在线那条链路只能靠这个开关。 */
  if (process.env.LEXICA_SHOT_ONLINE) {
    settings.mtOnline = online.setEnabled(true);
    console.log('[shot] 已临时开启在线翻译（LEXICA_SHOT_ONLINE）');
    const probe = await mainWin.webContents.executeJavaScript(
      "window.lexica.mtTranslate('Accuracy drops from 71.2 to 63.8 in our ablation study.')",
    ).catch((e) => ({ error: e.message }));
    console.log('[shot] 译文：', probe?.text || probe, '｜通道：', probe?.via);
    /* 必须先确认**走的就是在线通道**。
     *
     * 只看译文内容会被降级骗过去：实测端点回过一次 429，请求退回了本地模型，
     * 而那句话本地恰好也译对了——断言照样打勾，等于什么都没验证。
     * 判据是 via 字段，不是文本。 */
    if (probe?.via !== 'online') {
      console.error('[shot] ✗ 没走在线通道（多半被限流退回了本地）', {
        via: probe?.via, online: (await mainWin.webContents.executeJavaScript(
          'window.lexica.mtStatus()').catch(() => null))?.online,
      });
    } else if (probe.text.includes('63.8') && !probe.text.includes('638')) {
      console.log('[shot] ✓ 在线通道生效，且保住了小数点');
    } else {
      console.error('[shot] ✗ 在线译文的数字不对', probe.text);
    }
    const st = await mainWin.webContents.executeJavaScript('window.lexica.mtStatus()')
      .catch(() => null);
    console.log('[shot] 在线状态：', JSON.stringify(st?.online || st));
  }

  /* ---- 实时字幕：用一段真实语音跑完整链路 ---- */
  if (process.env.LEXICA_SHOT_AUDIO) {
    await setTheme('paper');
    await view('lecture');
    await shot('35-lecture-idle');

    /* 走 Lx.lectureSelfTest：它用真实的 VadChunker 切分、经 lec:feed 送进主进程，
       从这里往后（识别、翻译、落盘）与真实使用完全一致。
       麦克风在自动化里喂不了，但采音之外的每一环都被覆盖了。 */
    const feeding = mainWin.webContents.executeJavaScript(
      '(async () => { try { return await window.Lx.lectureSelfTest(); } '
      + 'catch (e) { return { error: e.message }; } })()',
    ).catch((e) => ({ error: e.message }));

    /* 临时稿只在「正在说」的那几秒里存在，喂完就被清掉了。
       所以必须**在喂的过程中**查 DOM——之前放在喂完之后查，
       永远是 hasPartial:false，等于这条根本没验到。 */
    let sawPartial = null;
    for (let i = 0; i < 24; i++) {
      await wait(500);
      const st = await mainWin.webContents.executeJavaScript(`
        (() => {
          const p = document.querySelector('#lec-partial');
          if (!p) return null;
          const en = p.querySelector('.lec-en');
          const ref = document.querySelector('.lec-row:not(.is-partial) .lec-en');
          return {
            en: en?.textContent?.trim() || '',
            /* 临时稿的正文列宽必须和定稿一样。
               第一版临时稿自己拼了 DOM、漏了 .lec-texts 那层包裹，
               英文掉进 52px 的时间列里，一行只排得下一两个词。 */
            enWidth: en ? Math.round(en.getBoundingClientRect().width) : 0,
            refWidth: ref ? Math.round(ref.getBoundingClientRect().width) : 0,
          };
        })()
      `).catch(() => null);
      if (st?.en) { sawPartial = st; break; }
    }
    if (sawPartial) {
      console.log(`[shot] ✓ 滚动字幕：说话途中出现临时稿「${sawPartial.en.slice(0, 50)}」`);
      const { enWidth, refWidth } = sawPartial;
      if (refWidth > 0 && enWidth < refWidth * 0.9) {
        console.error('[shot] ✗ 临时稿的正文列被挤窄了（DOM 结构和定稿不一致）',
          { enWidth, refWidth });
      } else {
        console.log(`[shot] ✓ 临时稿正文列宽 ${enWidth}px，与定稿 ${refWidth}px 一致`);
      }
    } else {
      console.error('[shot] ✗ 滚动字幕：整个过程没看到临时稿');
    }

    const fed = await feeding;
    console.log('[shot] 实时字幕自测已喂入', fed);
    if (fed?.partials > 0) console.log(`[shot] ✓ 临时稿共 ${fed.partials} 次`);
    else console.error('[shot] ✗ 一次临时稿都没产生', fed);

    /* 说完之后临时稿必须消失。不撤的话最后半句会一直挂在屏幕上——
       实测 whisper 在尾音上还会编出一整句不存在的话。 */
    await wait(3000);
    const lingering = await mainWin.webContents.executeJavaScript(
      "!!document.querySelector('#lec-partial')",
    ).catch(() => false);
    if (lingering) console.error('[shot] ✗ 说完之后临时稿还挂在屏幕上');
    else console.log('[shot] ✓ 说完之后临时稿已撤掉');

    if (!fed?.error) {
      // 自测按 4 倍速喂 66 秒音频（约 17 秒），加上识别追平的时间
      await wait(14000);
      await shot('36-lecture-live');

      await wait(14000);

      const done = await mainWin.webContents.executeJavaScript(
        '(async () => { try { return await window.Lx.lectureSelfTestStop(); } '
        + 'catch (e) { return { error: e.message }; } })()',
      ).catch((e) => ({ error: e.message }));
      await wait(600);
      await shot('37-lecture-done');

      /* 这条断言比截图重要：字幕有没有真的落到文件里。
         截图只能证明界面画出来了，证明不了写盘。 */
      if (done?.ok && done.dir) {
        const wrote = fs.readdirSync(done.dir);
        const hasAll = ['transcript.md', 'transcript.txt', 'transcript.srt', 'transcript.json', 'journal.jsonl']
          .filter((f) => !wrote.includes(f));
        if (done.segments > 0 && !hasAll.length) {
          console.log(`[shot] ✓ 实时字幕落盘 ${done.segments} 条，${wrote.length} 个文件 → ${done.dir}`);
        } else {
          console.error('[shot] ✗ 实时字幕落盘异常', { segments: done.segments, 缺少: hasAll, wrote });
        }

        /* 临时稿绝不能进文件。
         *
         * 这条比「临时稿出现了」更重要：滚动字幕每 1.5 秒出一版半句，
         * 一旦漏进转写稿，一节课的文件里会混进几百条残句，而且不容易发现——
         * 文件看起来是满的。判据：定稿数量 == journal 里的行数。 */
        try {
          const jl = fs.readFileSync(path.join(done.dir, 'journal.jsonl'), 'utf8')
            .split(/\r?\n/).filter(Boolean);
          // journal 每行有 kind 字段：head / seg。只数 seg
          const segLines = jl.filter((l) => {
            try { return JSON.parse(l).kind === 'seg'; } catch { return false; }
          });
          if (segLines.length === done.segments) {
            console.log(`[shot] ✓ 临时稿没有混进文件（journal ${segLines.length} 条 = 定稿 ${done.segments} 条）`);
          } else {
            console.error('[shot] ✗ 文件里的条数和定稿数不一致，临时稿可能漏进去了',
              { journal: segLines.length, segments: done.segments });
          }
        } catch (e) {
          console.error('[shot] ✗ 读不到 journal.jsonl：', e.message);
        }
      } else {
        console.error('[shot] ✗ 实时字幕自测没有正常结束', done);
      }

      /* ---- 点字幕里的词查词、收进生词本 ----
       *
       * 必须用真实的鼠标事件（sendInputEvent），不能 el.click()：
       * 取词靠 caretRangeFromPoint(clientX, clientY)，合成的 click 没有坐标，
       * 那样测等于没测。 */
      const exec = (js) => mainWin.webContents.executeJavaScript(js).catch((e) => ({ __err: e.message }));

      /** 某个容器里第一处出现 word 的位置（视口坐标），顺带返回整句 */
      const wordPoint = (scopeSel, word) => exec(`
        (() => {
          const scope = document.querySelector(${JSON.stringify(scopeSel)});
          if (!scope) return null;
          const w = ${JSON.stringify(word)};
          for (const el of scope.querySelectorAll('.lec-en')) {
            const node = [...el.childNodes].find((n) => n.nodeType === 3);
            if (!node) continue;
            const text = node.textContent;
            const i = text.toLowerCase().indexOf(w);
            if (i < 0) continue;
            el.scrollIntoView({ block: 'center' });
            const r = document.createRange();
            r.setStart(node, i + 1);
            r.setEnd(node, i + 2);
            const b = r.getBoundingClientRect();
            return {
              x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
              sentence: el.textContent.trim(), src: scope.dataset.ctxSrc || null,
            };
          }
          return null;
        })()
      `);

      const clickAt = async (x, y) => {
        mainWin.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        mainWin.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await wait(1100);   // 查词是一次 IPC + 一次查库
      };

      const popover = () => exec(`
        (() => {
          const b = document.querySelector('.wp.is-open');
          if (!b) return null;
          return {
            word: b.querySelector('.wp-word')?.textContent.trim() || null,
            via: b.querySelector('.wp-via')?.textContent.trim() || null,
            senses: b.querySelectorAll('.wp-sense').length,
            ctx: b.querySelector('.wp-ctx')?.textContent.trim() || null,
          };
        })()
      `);

      await view('lecture');
      await wait(500);
      const pt = await wordPoint('#lecList', 'replay');
      if (!pt) {
        console.error('[shot] ✗ 本节字幕里找不到可点的「replay」');
      } else {
        await clickAt(pt.x, pt.y);
        const wp = await popover();
        if (wp?.word === 'replay' && wp.senses > 0 && wp.ctx === pt.sentence) {
          console.log(`[shot] ✓ 点字幕里的词弹出释义：${wp.word}（${wp.senses} 条），语境「${wp.ctx.slice(0, 40)}…」`);
        } else {
          console.error('[shot] ✗ 点词卡片不对', { wp, expectSentence: pt.sentence });
        }
        await shot('44-word-popover');

        // 收藏：卡片里的按钮不需要坐标，el.click() 就行
        await exec("document.querySelector('.wp.is-open .wp-save')?.click()");
        await wait(700);
        const saved = await exec("window.lexica.wbGet('replay')");
        const c0 = saved?.row?.contexts?.[0];
        if (saved?.saved && c0?.en === pt.sentence && c0.src === pt.src) {
          console.log(`[shot] ✓ 收进生词本并记下语境：「${c0.en.slice(0, 40)}…」出处「${c0.src}」`);
        } else {
          console.error('[shot] ✗ 收藏或语境不对', { saved: saved?.saved, contexts: saved?.row?.contexts, expect: pt });
        }
        /* 笔记一个字都不能动——语境单独存，用户的笔记是用户的 */
        if (saved?.row?.note) console.error('[shot] ✗ 收藏时往笔记里写了东西', saved.row.note);
      }

      /* 词形还原：点 networks 应当查到 network，并且让人看得出来 */
      const pt2 = await wordPoint('#lecList', 'networks');
      if (pt2) {
        await clickAt(pt2.x, pt2.y);
        const wp = await popover();
        if (wp?.word === 'network' && wp.via) {
          console.log(`[shot] ✓ 词形还原：${wp.via}`);
        } else {
          console.error('[shot] ✗ 点 networks 没有还原成 network', wp);
        }
      }
      mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await wait(300);
      if (await exec("!!document.querySelector('.wp.is-open')")) console.error('[shot] ✗ Esc 没有关掉查词卡片');

      /* ---- 历史转写稿：搜索 → 打开 → 定位 → 在查看页里接着点词 ---- */
      await exec("document.querySelector('[data-act=\"lec-tab\"][data-v=\"history\"]')?.click()");
      await wait(700);
      await shot('38-lecture-history');

      await exec(`(() => {
        const i = document.querySelector('#lecSearch');
        if (!i) return false;
        i.value = 'replay buffer';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await wait(1000);   // 防抖 200ms + 搜索
      const found = await exec(`({
        hits: document.querySelectorAll('#lecResults .lec-res-hit').length,
        marks: document.querySelectorAll('#lecResults mark').length,
        sum: document.querySelector('.lec-res-sum')?.textContent.trim() || null,
        stillHasBox: !!document.querySelector('#lecSearch'),
      })`);
      if (found.hits > 0 && found.marks > 0 && found.stillHasBox) {
        console.log(`[shot] ✓ 转写稿搜索：${found.sum}`);
      } else {
        console.error('[shot] ✗ 转写稿搜索不对', found);
      }
      await shot('45-transcript-search');

      await exec("document.querySelector('#lecResults .lec-res-hit')?.click()");
      await wait(1200);
      const viewer = await exec(`({
        open: !!document.querySelector('#lecViewer'),
        rows: document.querySelectorAll('#lecViewer .lec-row').length,
        focus: document.querySelector('#lecViewer .lec-row.is-focus .lec-en')?.textContent.trim() || null,
      })`);
      if (viewer.open && viewer.rows > 0 && /replay/i.test(viewer.focus || '')) {
        console.log(`[shot] ✓ 打开转写稿并定位到那一句（共 ${viewer.rows} 条）：「${viewer.focus.slice(0, 40)}…」`);
      } else {
        console.error('[shot] ✗ 转写稿查看页不对', viewer);
      }
      await shot('46-transcript-viewer');

      // 1 和 2 接上：查看页里点词同样能查
      const pt3 = await wordPoint('#lecViewer .lec-row.is-focus', 'buffer');
      if (pt3) {
        await clickAt(pt3.x, pt3.y);
        const wp = await popover();
        if (wp?.word === 'buffer') console.log('[shot] ✓ 转写稿查看页里点词也能查');
        else console.error('[shot] ✗ 查看页里点词没反应', wp);
        mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await wait(300);
      }

      await exec("document.querySelector('[data-act=\"lec-back\"]')?.click()");
      await wait(700);
      const back = await exec("document.querySelector('#lecSearch')?.value || null");
      if (back === 'replay buffer') console.log('[shot] ✓ 返回后搜索词还在');
      else console.error('[shot] ✗ 返回后搜索词丢了', back);
    }
  }

  /* ---- 视频字幕悬浮窗 ---- */
  if (process.env.LEXICA_SHOT_AUDIO) {
    await setTheme('paper');
    toggleSubtitleWindow(true);
    await wait(4000);   // 等它起识别服务（悬浮窗一显示就自己开始听）

    /* 悬浮窗抓的是系统声音，自动化里没法放音频。
       但 lecSend 会同时推给悬浮窗，所以用自测通道把真实语音喂进同一条流水线，
       悬浮窗就该显示出字幕——除「抓系统声音」之外的每一环都被验证到了。 */
    const subFed = await mainWin.webContents.executeJavaScript(
      '(async () => { try { const p = await window.lexica.lecPickAudio();'
      + ' if (!p || !p.ok) return { error: p && p.reason };'
      + ' const pcm = await window.Lx.lectureDecodeForTest(p.data);'
      + ' return await window.lexica.lecSelfTestFeed({ pcm, speed: 6 }); }'
      + ' catch (e) { return { error: e.message }; } })()',
    ).catch((e) => ({ error: e.message }));
    console.log('[shot] 悬浮窗喂入', subFed);

    await wait(9000);
    await shot('39-subtitle-float', subWin);

    /* 断言字幕真的画出来了：透明置顶窗口的截图不一定靠得住
       （窗口没真正前置时 capturePage 会给旧帧），查 DOM 才准。 */
    const subState = await subWin.webContents.executeJavaScript(`
      (() => {
        const lines = document.querySelectorAll('.sub-line');
        return {
          lines: lines.length,
          en: lines.length ? lines[lines.length - 1].querySelector('.sub-en').textContent.trim() : null,
          zh: lines.length ? lines[lines.length - 1].querySelector('.sub-zh').textContent.trim() : null,
          state: document.querySelector('#subState')?.textContent || '',
        };
      })()
    `).catch((e) => ({ error: e.message }));

    if (subState.lines > 0 && subState.en) {
      console.log(`[shot] ✓ 悬浮窗显示 ${subState.lines} 条字幕：${subState.en.slice(0, 50)}`);
      console.log(`[shot]   译文：${String(subState.zh).slice(0, 50)}`);
    } else {
      console.error('[shot] ✗ 悬浮窗没有字幕', subState);
    }

    // 顺手验证鼠标穿透开关不会把窗口弄坏
    subWin.setIgnoreMouseEvents(true, { forward: true });
    await wait(400);
    await shot('40-subtitle-locked', subWin);
    subWin.setIgnoreMouseEvents(false);

    await mainWin.webContents.executeJavaScript('window.lexica.subStop()').catch(() => {});
    await wait(800);
    toggleSubtitleWindow(false);
  }

  /* ---- 长句：查词框输入整句 + 独立翻译页 ---- */
  await setTheme('paper');
  await view('dict');
  mainWin.webContents.send('nav:lookup', {
    word: 'Photosynthesis converts light energy into chemical energy stored in glucose.',
  });
  /* 这里不调 assertScrollable()：长句页内容短，本来就装得下一屏，
     不滚动是正常的，那个不变式只对必然超长的词条页有意义。 */
  await wait(4500); // 术语立刻出，译文要等模型逐句跑完
  await shot('31-sentence-result');

  await setTheme('glass');
  await shot('32-sentence-result-glass');

  await setTheme('paper');
  await view('translate');
  await mainWin.webContents.executeJavaScript(`
    (() => {
      const t = document.querySelector('#trInput');
      if (!t) return false;
      t.value = 'Recent advances in self-supervised learning have substantially reduced the need for labeled data. '
              + 'Our ablation study indicates that the projection head is critical: '
              + 'removing it degrades linear-probe accuracy from 71.2 to 63.8.';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-act="tr-run"]').click();
      return true;
    })()
  `).catch(() => {});
  /* 等得比看起来需要的久：翻译进程是串行的，实时字幕那段自测会往它的队列里
     压十几条，这里得排在后面。 */
  await wait(30000);
  await shot('33-translate-page');

  /**
   * 双语对照必须真的渲染出来。
   *
   * 这条不能靠截图核：译文在折叠线以下，而窗口没被真正前置时
   * capturePage 会返回滚动前的旧帧，看起来像没渲染。直接查 DOM 才准。
   * 只看 #trResult 内部——视图是 display:none 而不是移除，
   * 整个 document 里找 .tr-pair 会把隐藏的查词视图一起数进来。
   */
  const trState = await mainWin.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('#trResult');
      return {
        pairs: box ? box.querySelectorAll('.tr-pair').length : -1,
        loading: !!box?.querySelector('.tr-progress'),
        error: box?.querySelector('.tr-error')?.textContent?.trim() || null,
      };
    })()
  `).catch((e) => ({ threw: e.message }));

  if (trState.pairs >= 2 && !trState.loading && !trState.error) {
    console.log(`[shot] ✓ 翻译页双语对照 ${trState.pairs} 句`);
  } else {
    console.error('[shot] ✗ 翻译页没出结果', trState);
  }

  /* ---- 术语表：整条链路跑一遍真模型 ----
   *
   * 这一段比截图重要得多。术语表的整个机制建立在一个假设上：
   * 「模型对同一个术语的错译是固定的，问一次就能拿到」。
   * 这里把它验证出来，并把模型实际给出的错译写法打到日志里——
   * 这是唯一能确认替换真的会发生的办法。
   */
  await setTheme('paper');
  await view('custom');
  {
    const imported = await mainWin.webContents.executeJavaScript(`
      window.lexica.glossImport([
        'policy = 策略',
        'value function: 价值函数',
        'replay buffer    经验回放缓冲',
        'ablation study，消融实验',
        'scalar\ttitle'.replace('title', '标量'),
      ].join(String.fromCharCode(10)), false)
    `).catch((e) => ({ error: e.message }));
    console.log('[shot] 术语表导入', imported);

    /* 探测是后台串行跑的：每条要问三次模型（裸词 / 带冠词 / 框架句），
       一条三四秒。五条给足时间。 */
    await wait(30000);

    const terms = await mainWin.webContents.executeJavaScript('window.lexica.glossAll()')
      .catch((e) => ({ error: e.message }));
    if (Array.isArray(terms)) {
      for (const t of terms) {
        console.log(`[shot]   ${t.surface} → 要 ${t.zh}｜模型会给 ${t.wrong?.length ? t.wrong.join('、') : '(还没探到)'}`);
      }
      const probed = terms.filter((t) => t.wrong?.length).length;
      if (probed >= 3) console.log(`[shot] ✓ 术语探测 ${probed}/${terms.length} 条拿到错译写法`);
      else console.error(`[shot] ✗ 术语探测只成功 ${probed}/${terms.length} 条，替换基本不会发生`);
    } else {
      console.error('[shot] ✗ 读不出术语表', terms);
    }

    /* 导入是直接走 IPC 的，绕过了界面，所以页面上的列表还是导入前那份空的。
       走一遍「离开再回来」让 loadCustom() 重新拉数据——用户从界面导入会自动刷新，
       这一步只是补上自测绕过 UI 造成的差异。 */
    await view('dict');
    await view('custom');
    await mainWin.webContents.executeJavaScript(
      "document.querySelector('[data-act=\"cu-tab\"][data-tab=\"gloss\"]')?.click()",
    ).catch(() => {});
    await wait(700);
    await shot('41-glossary');

    /* 界面这条也得查 DOM。透明/未前置窗口的 capturePage 会给旧帧——
       实测这张截图拍到的是上一个页面，看图完全判断不了面板有没有画出来。 */
    const glState = await mainWin.webContents.executeJavaScript(`
      (() => {
        const box = document.querySelector('#view-custom');
        const rows = box ? box.querySelectorAll('.gl-row') : [];
        return {
          rows: rows.length,
          tabOn: !!box?.querySelector('[data-tab="gloss"].is-on'),
          firstEn: rows.length ? rows[0].querySelector('.gl-en')?.textContent.trim() : null,
          firstZh: rows.length ? rows[0].querySelector('.gl-zh')?.textContent.trim() : null,
          pending: box ? box.querySelectorAll('.gl-pending').length : -1,
          hasImport: !!box?.querySelector('#glText'),
        };
      })()
    `).catch((e) => ({ error: e.message }));
    if (glState.rows === 5 && glState.tabOn && glState.hasImport && glState.pending === 0) {
      console.log(`[shot] ✓ 术语表面板 ${glState.rows} 条，首条 ${glState.firstEn} → ${glState.firstZh}`);
    } else {
      console.error('[shot] ✗ 术语表面板不对', glState);
    }

    /* 拿一句同时含多个术语的话去译，看替换有没有真的落到译文上。
       对照组在同一次调用里：句子里没有 policy 这个词的那半句不该被动。 */
    const probe = await mainWin.webContents.executeJavaScript(`
      window.lexica.mtTranslate(
        'We train the policy with a replay buffer and estimate the value function.')
    `).catch((e) => ({ error: e.message }));
    console.log('[shot] 术语句译文：', probe?.text || probe);
    if (probe?.ok) {
      const hit = ['策略', '经验回放缓冲', '价值函数'].filter((w) => probe.text.includes(w));
      if (hit.length) console.log(`[shot] ✓ 译文里用上了术语表的译名：${hit.join('、')}`);
      else console.error('[shot] ✗ 译文没有采用任何术语表译名', probe.text);
    }

    /* 反向对照：英文里没有 policy，译文里的「政策」必须保持原样。
       这条不成立的话，术语表就变成了一个会悄悄改坏译文的功能。 */
    const ctrl = await mainWin.webContents.executeJavaScript(`
      window.lexica.mtTranslate('The government announced a new economic measure.')
    `).catch((e) => ({ error: e.message }));
    console.log('[shot] 对照组译文：', ctrl?.text || ctrl);
    if (ctrl?.ok && ctrl.text.includes('策略')) {
      console.error('[shot] ✗ 英文里没有 policy，译文却被改成了「策略」——门槛失效');
    } else if (ctrl?.ok) {
      console.log('[shot] ✓ 对照组未被改动');
    }

    /* 起步包。放在术语表这段的最后：导入会在后台探测新词条（每条问三次模型），
       占着翻译进程，插在前面会把上面那几句翻译挤得超时。 */
    await view('dict');
    await view('custom');
    await mainWin.webContents.executeJavaScript(
      "document.querySelector('[data-act=\"cu-tab\"][data-tab=\"gloss\"]')?.click()",
    ).catch(() => {});
    await wait(700);
    const packsState = await mainWin.webContents.executeJavaScript(`
      (() => ({
        packs: document.querySelectorAll('#view-custom .gl-pack').length,
        caution: [...document.querySelectorAll('#view-custom .gl-pack-scope.is-caution')]
          .map((e) => e.closest('.gl-pack').querySelector('.gl-pack-name').textContent.trim().split(/\\s/)[0]),
      }))()
    `).catch((e) => ({ error: e.message }));
    // 只有收了日常常见词的强化学习包该是警示色
    if (packsState.packs === 5 && packsState.caution?.length === 1 && packsState.caution[0] === '强化学习') {
      console.log('[shot] ✓ 起步包 5 个，只有强化学习包标了警示色');
    } else {
      console.error('[shot] ✗ 起步包列表不对', packsState);
    }

    const before = (await mainWin.webContents.executeJavaScript('window.lexica.glossAll()')).length;
    await mainWin.webContents.executeJavaScript(
      "document.querySelector('[data-act=\"gl-pack\"][data-id=\"sys\"]')?.click()",
    ).catch(() => {});
    await wait(1500);
    const after = await mainWin.webContents.executeJavaScript(`
      (async () => ({
        count: (await window.lexica.glossAll()).length,
        button: document.querySelector('[data-act="gl-pack"][data-id="sys"]')?.textContent.trim() || null,
      }))()
    `).catch((e) => ({ error: e.message }));
    if (after.count - before === 25 && after.button === '已导入') {
      console.log(`[shot] ✓ 导入「计算机系统与分布式」：术语表 ${before} → ${after.count} 条，按钮变成「已导入」`);
    } else {
      console.error('[shot] ✗ 导入起步包不对', { before, after });
    }
    await shot('47-glossary-packs');
  }

  await setTheme('paper');
  await view('drill');

  /* 先退回范围列表。
   *
   * 上面 26/27 的拼写题把练习页留在了答题态，而 nav:view 是有意不重置进度的
   * （切去查个词再切回来不该丢掉正在做的题）。所以这里顺着界面上的返回键退，
   * 顺带把 drill-menu / drill-back 这两条返回路径也覆盖掉。
   * 按当前 stage 决定点什么，而不是写死点两下——以后挪动截图顺序不会又悄悄坏掉。 */
  const drillStage = () => mainWin.webContents.executeJavaScript(
    'window.Lx?.drill?.state?.stage ?? null',
  ).catch(() => null);

  for (let i = 0; i < 3; i++) {
    const st = await drillStage();
    if (st === 'scopes') break;
    await click(st === 'menu' ? '[data-act="drill-back"]' : '[data-act="drill-menu"]', 500);
  }

  await waitFor('[data-act="drill-scope"][data-scope="toefl"]');
  await shot('17-drill-scopes');

  await click('[data-act="drill-scope"][data-scope="toefl"]', 300);
  await waitFor('[data-act="drill-start"][data-mode="quiz"][data-count="10"]');
  await shot('18-drill-menu');

  await click('[data-act="drill-start"][data-mode="quiz"][data-count="10"]', 300);
  await waitFor('.q-opt');
  await shot('19-drill-question');

  /* 故意挑一个错的选项。
   *
   * 答对了 drillPick 会在 750ms 后自动跳下一题，而这里要拍的正是反馈态——
   * 盲点第一个选项有四分之一概率答对，20/21 就拍成了下一道题的题面。
   * 正确答案在锁定之前不进 DOM，只能问渲染层的状态。 */
  const wrongOpt = await mainWin.webContents.executeJavaScript(`
    (() => {
      const q = window.Lx?.drill?.state?.quiz;
      const cur = q?.questions?.[q.i];
      if (!cur?.options) return null;
      return cur.options.findIndex((_, i) => i !== cur.answer);
    })()
  `).catch(() => null);
  await click(`.q-opt[data-i="${wrongOpt}"]`, 600);
  await waitFor('.q-feedback.is-wrong');
  await shot('20-drill-feedback');

  /* 这条断言比截图管用：窗口没被真正前置时 capturePage 会给旧帧，
     19/20 拍到的可能是上一个状态，看图分辨不出来。 */
  const quizState = await mainWin.webContents.executeJavaScript(`
    (() => {
      const v = document.querySelector('#view-drill');
      return {
        kind: v?.querySelector('.q-kind')?.textContent?.trim() || null,
        prompt: v?.querySelector('.q-prompt')?.textContent?.trim().slice(0, 40) || null,
        opts: v ? v.querySelectorAll('.q-opt').length : -1,
        right: v ? v.querySelectorAll('.q-opt.is-right').length : -1,
        picked: v ? v.querySelectorAll('.q-opt.is-wrong').length : -1,
        feedback: v?.querySelector('.q-feedback .q-fb-head')?.textContent?.trim().slice(0, 24) || null,
        next: !!v?.querySelector('[data-act="drill-next"]'),
      };
    })()
  `).catch((e) => ({ error: e.message }));

  if (quizState.opts >= 2 && quizState.prompt && quizState.right === 1
      && quizState.picked === 1 && quizState.next) {
    console.log(`[shot] ✓ 练习出题与反馈正常：${quizState.kind}｜${quizState.prompt}｜${quizState.feedback}`);
  } else {
    console.error('[shot] ✗ 练习页不在反馈态', quizState);
  }

  await setTheme('glass');
  await shot('21-drill-feedback-glass');

  const glassState = await mainWin.webContents.executeJavaScript(`
    (() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      feedback: !!document.querySelector('#view-drill .q-feedback.is-wrong'),
    }))()
  `).catch((e) => ({ error: e.message }));
  if (glassState.theme === 'glass' && glassState.feedback) {
    console.log('[shot] ✓ 反馈态在玻璃主题下仍在');
  } else {
    console.error('[shot] ✗ 玻璃主题下的反馈态不对', glassState);
  }

  // 检测模式：连点到底出结果页
  await setTheme('paper');
  await click('[data-act="drill-menu"]', 700);
  await click('[data-act="drill-start"][data-mode="assess"]', 2000);
  for (let i = 0; i < 30; i++) {
    const ok = await mainWin.webContents.executeJavaScript(`
      (() => {
        const opt = document.querySelector('.q-opt:not([disabled])');
        if (opt) { opt.click(); }
        const next = document.querySelector('[data-act="drill-next"]:not([disabled])');
        if (next) { next.click(); return true; }
        return false;
      })()
    `);
    await wait(160);
    if (!ok) break;
  }
  await waitFor('.result-hero');
  await wait(600);   // 结果页的环形进度条有动画
  await shot('22-drill-assessment-result');

  /* 结果页同样只能靠 DOM 核：分层结果是这个模式唯一的产出，
     连点到底中途断在某道题上，截图看着也像一张正常的练习页。 */
  const assessState = await mainWin.webContents.executeJavaScript(`
    (() => {
      const v = document.querySelector('#view-drill');
      return {
        stage: window.Lx?.drill?.state?.stage ?? null,
        score: v?.querySelector('.result-score')?.textContent?.trim() || null,
        pct: v?.querySelector('.result-ring-num')?.textContent?.trim() || null,
        bands: v ? v.querySelectorAll('.meter').length : -1,
        estimate: !!v?.querySelector('.result-estimate'),
      };
    })()
  `).catch((e) => ({ error: e.message }));
  if (assessState.stage === 'result' && assessState.bands >= 2 && assessState.estimate) {
    console.log(`[shot] ✓ 水平检测出结果：${assessState.score} · ${assessState.pct} · ${assessState.bands} 个分层`);
  } else {
    console.error('[shot] ✗ 水平检测没走到结果页', assessState);
  }

  /* ---- 生词本的自有释义与笔记 ----
   *
   * 重点验的是「词库里没有的词组也能加进来、并且一路带到复习卡上」。
   * 这条链路以前根本不存在：查不到的词没有收藏按钮，note 那一列也没人写过。
   */
  await setTheme('paper');
  await view('wordbook');
  {
    const phrase = 'replay buffer';
    const added = await mainWin.webContents.executeJavaScript(`
      window.lexica.wbAdd({
        word: ${JSON.stringify(phrase)},
        myDef: '经验回放缓冲：存放历史转移的池子',
        note: 'RL 课第三周，别和 policy 混起来',
      })
    `).catch((e) => ({ error: e.message }));
    console.log('[shot] 手动添加词组', added);

    // 词库里真的没有这个词组，否则这条验证就没意义了
    const inDict = await mainWin.webContents.executeJavaScript(
      `(async () => (await window.lexica.wbGet(${JSON.stringify(phrase)})).inDict)()`,
    ).catch(() => null);
    if (inDict) console.error('[shot] ✗ 词库里居然有这个词组，换一个再测');

    await view('wordbook');
    await wait(900);

    /* 列表行要显示自己写的释义与笔记，并标出「词库无」。
       查 DOM 而不是看截图——虚拟列表 + 未前置窗口的截图都不可靠。 */
    const rowState = await mainWin.webContents.executeJavaScript(`
      (() => {
        const box = document.querySelector('#view-wordbook');
        const rows = [...(box?.querySelectorAll('.wb-item') || [])];
        const it = rows.find((r) => r.dataset.word === ${JSON.stringify(phrase)});
        return {
          rows: rows.length,
          found: !!it,
          text: it ? it.querySelector('.wb-tr')?.textContent.trim() : null,
          flags: it ? [...it.querySelectorAll('.custom-flag')].map((f) => f.textContent.trim()) : [],
          hasEdit: !!it?.querySelector('[data-act="wb-edit"]'),
        };
      })()
    `).catch((e) => ({ error: e.message }));

    if (rowState.found && rowState.text?.includes('经验回放缓冲')
      && rowState.text.includes('RL 课第三周') && rowState.hasEdit) {
      console.log(`[shot] ✓ 生词本行显示自有释义与笔记｜标记 ${rowState.flags.join(',')}`);
    } else {
      console.error('[shot] ✗ 生词本行不对', rowState);
    }

    // 点开编辑框，内容要能读回来
    await click(`[data-act="wb-edit"][data-word="${phrase}"]`, 800);
    const edState = await mainWin.webContents.executeJavaScript(`
      (() => {
        const f = document.querySelector('#wbForm');
        return {
          open: !!f,
          word: document.querySelector('#wbWord')?.value || null,
          def: document.querySelector('#wbDef')?.value || null,
          note: document.querySelector('#wbNote')?.value || null,
          warn: document.querySelector('.wb-form-hint.is-warn')?.textContent.trim() || null,
        };
      })()
    `).catch((e) => ({ error: e.message }));
    if (edState.open && edState.def?.includes('经验回放缓冲') && edState.note?.includes('RL 课')) {
      console.log('[shot] ✓ 编辑框回填正确' + (edState.warn ? '，并提示词库无此条' : ''));
    } else {
      console.error('[shot] ✗ 编辑框回填不对', edState);
    }
    await shot('42-wordbook-editor');

    /* 「我写过的」筛选——用户要「完整查看自己加的东西」靠这个 */
    await click('[data-act="wb-filter"][data-filter="noted"]', 800);
    const noted = await mainWin.webContents.executeJavaScript(
      "document.querySelectorAll('#view-wordbook .wb-item').length",
    ).catch(() => -1);
    if (noted >= 1) console.log(`[shot] ✓ 「我写过的」筛出 ${noted} 条`);
    else console.error('[shot] ✗ 「我写过的」筛选没结果', noted);
    await click('[data-act="wb-filter"][data-filter="all"]', 600);

    /* 复习卡上也要出现——词库里没有这个词组，自己写的释义是卡片上唯一的释义。
       这一条最容易漏：wb:due 原先只查词库，卡片会一个字都没有。 */
    const due = await mainWin.webContents.executeJavaScript(
      `(async () => {
         const q = await window.lexica.wbDue(200);
         const it = q.find((x) => x.card.word === ${JSON.stringify(phrase)});
         return it ? { myDef: it.myDef, note: it.note, entry: !!it.entry } : null;
       })()`,
    ).catch((e) => ({ error: e.message }));
    if (due?.myDef?.includes('经验回放缓冲')) {
      console.log('[shot] ✓ 复习队列带着自有释义');
    } else {
      console.error('[shot] ✗ 复习队列里没有自有释义', due);
    }

    /* 词条页的「我的」区块。这里用一个词库里真有的词，
       验证注释是**叠加**在词库释义之上，而不是把词条替换掉。 */
    await mainWin.webContents.executeJavaScript(`
      window.lexica.wbAnnotate({ word: 'policy', myDef: '策略（不是政策）', note: '强化学习语境' })
    `).catch(() => {});
    await lookup('policy');
    await wait(600);
    const entryState = await mainWin.webContents.executeJavaScript(`
      (() => {
        const box = document.querySelector('#view-dict');
        return {
          mineDef: box?.querySelector('.mine-def')?.textContent.trim() || null,
          mineNote: box?.querySelector('.mine-note')?.textContent.trim() || null,
          // 词库释义必须还在——注释是叠加，不是替换
          dictSenses: box ? box.querySelectorAll('.zh-line').length : 0,
        };
      })()
    `).catch((e) => ({ error: e.message }));
    if (entryState.mineDef?.includes('策略') && entryState.dictSenses > 0) {
      console.log(`[shot] ✓ 词条页「我的」区块在，词库释义仍有 ${entryState.dictSenses} 条`);
    } else {
      console.error('[shot] ✗ 词条页的注释区块不对', entryState);
    }
    await shot('43-entry-mine');

    /* 查不到页要有「加进生词本」的出口——用户原来在这里是死路 */
    mainWin.webContents.send('nav:lookup', { word: 'zzzqqq' });
    await wait(900);
    const missHas = await mainWin.webContents.executeJavaScript(
      "!!document.querySelector('#view-dict [data-act=\"wb-edit\"]')",
    ).catch(() => false);
    if (missHas) console.log('[shot] ✓ 查不到页有加入生词本的出口');
    else console.error('[shot] ✗ 查不到页仍然是死路');
  }

  // 复习页的学习热力图
  await view('review');
  await shot('23-heatmap');

  await view('wordbook');
  await shot('24-wordbook-virtual');

  if (badShots) console.error(`[shot] ✗ 有 ${badShots} 张截图不可信（旧帧或窗口没在出帧），看图不作数`);
  console.log('[shot] 完成，输出目录：', dir);
  quitting = true;
  app.exit(badShots ? 1 : 0);
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/* ========================================================================== */
/*  启动                                                                       */
/* ========================================================================== */

app.on('second-instance', (_e, argv) => {
  const word = argv.find((a) => /^[A-Za-z][A-Za-z'-]{1,40}$/.test(a));
  focusMain(word);
});

/**
 * 让渲染层的 getDisplayMedia 能直接拿到系统声音（网课、录播用）。
 *
 * Windows 上抓系统输出只能走 loopback，而 loopback 只在 getDisplayMedia
 * 这条路上提供。默认行为会弹出「选择共享内容」的窗口——上课前每次都点一遍太烦，
 * 这里直接回一个屏幕源 + loopback 音频，不弹窗。
 *
 * 只给音频用：渲染层拿到流后立刻把视频轨停掉并移除（见 lecture.js 的 openStream）。
 * 这里没有把画面送去任何地方，也不录屏。
 */
function installDisplayMediaHandler() {
  const { session, desktopCapturer } = require('electron');
  try {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        if (!sources.length) return callback({});
        return callback({ video: sources[0], audio: 'loopback' });
      }).catch((e) => {
        console.error('[lecture] 取系统声音失败：', e.message);
        callback({});
      });
    }, { useSystemPicker: false });
  } catch (e) {
    console.warn('[lecture] 这个 Electron 版本不支持 setDisplayMediaRequestHandler：', e.message);
  }
}

/* 截图模式用独立的用户数据目录，避免碰到真实的生词本和浏览器缓存。
 *
 * 两条都是踩出来的：
 * - **必须在 ready 之前设。** 原先写在 whenReady 里面，user.db 倒是隔离了
 *   （它是之后才打开的），但 Chromium 的 GPU 进程和磁盘缓存在 ready 之前就定了路径——
 *   实测 shot 模式的 GPU 进程跑在真实的 AppData\Roaming\Lexica 下，
 *   还和别的实例抢缓存（日志里的 Unable to move the cache: 拒绝访问）。
 * - **每次运行一个新目录**，不能是固定路径。原先写死成 tmp/lexica-shot-profile，
 *   两个会话同时跑 shot 时共用同一个 user.db 和课堂目录；为了干净开始手动 rm -rf，
 *   又把另一个会话正在跑的那一轮拆掉了——实际发生过一次。
 *   断言也依赖干净状态（「我写过的」该筛出 1 条，旧数据残留时是 2 条）。
 * LEXICA_SHOT_PROFILE 可以显式指定目录。 */
if (process.env.LEXICA_SHOT) {
  const profile = process.env.LEXICA_SHOT_PROFILE
    || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lexica-shot-'));
  app.setPath('userData', profile);
}

app.whenReady().then(() => {
  installDisplayMediaHandler();
  app.setAppUserModelId('com.lexica.dictionary');

  const shotDir = process.env.LEXICA_SHOT;
  if (shotDir) console.log('[shot] 临时用户数据目录：', app.getPath('userData'));

  logger.init(app.getPath('userData'));

  user = new UserDB(app.getPath('userData'));
  settings = user.allSettings(DEFAULTS);

  const dataDir = path.dirname(resolveDictPath());
  // 模型和词库放一起：开发时 data/model，打包后 resources/data/model
  translator = new Translator(path.join(dataDir, 'model'), { model: settings.mtModel });
  online = new OnlineTranslator({
    provider: settings.mtOnlineProvider,
    enabled: !!settings.mtOnline,
    /* 必须用 net.fetch，不能用全局 fetch。
     *
     * 实测同一时刻、同一个 URL：Electron 主进程的全局 fetch 拿到 **429**，
     * 而 net.fetch 和 node:https 都是 200。我一开始把这个 429 当成
     * 「这个免费端点会限流」写进了文档，其实是选错了请求通道。
     * net.fetch 还有个好处：它走 Electron 的会话，代理设置能生效。 */
    fetchImpl: (...a) => require('electron').net.fetch(...a),
  });
  // 启动后台预热，第一次划词就不用等模型现加载
  if (translator.available) setTimeout(() => translator.warmup(), 2000);

  /* 语音识别不在启动时拉起：whisper-server 常驻要占几百 MB 内存和一个端口，
     只有真的开始上课记录时才值得。这里只构造，start() 由界面触发。
     maxChunkSec 必须与渲染层 VadChunker 的 maxMs 一致——它决定 audio-ctx。 */
  asr = new AsrEngine(path.join(dataDir, 'asr'), { maxChunkSec: LECTURE_MAX_CHUNK_SEC });
  /* 临时稿单独一个服务。
   *
   * 为什么不复用主服务：请求在服务端是串行的，一次临时稿（small+beam5 约 900ms）
   * 会把正式字幕往后推同样长的时间——正好抵消了滚动字幕想省的那点延迟。
   * 另起一个用小模型、限死 4 线程（本机 24 核，主服务占 12），互不打扰。
   * 临时稿会被正式字幕覆盖，所以它准不准无所谓，快才重要。 */
  rollAsr = new AsrEngine(path.join(dataDir, 'asr'), {
    maxChunkSec: LECTURE_MAX_CHUNK_SEC,
    threads: 4,
    tag: 'roll',
  });
  lectures = new LectureRecorder(path.join(app.getPath('userData'), 'lectures'));

  if (shotDir) {
    settings.theme = 'paper';
    // 给生词本塞几个词，截图里才有内容
    for (const w of ['ephemeral', 'meticulous', 'ubiquitous', 'serendipity', 'paradigm',
                     'photosynthesis', 'run', 'candid', 'resilient', 'nuance']) {
      user.toggle(w);
    }
    // 造一年的学习活动，热力图截图才不是全空（只影响临时的截图专用配置目录）
    const seedLog = user.db.prepare('INSERT INTO quiz_log (at, scope, kind, word, correct) VALUES (?, ?, ?, ?, ?)');
    const seedRev = user.db.prepare('INSERT INTO reviews (word, at, grade) VALUES (?, ?, ?)');
    user.db.exec('BEGIN');
    for (let back = 0; back < 360; back++) {
      // 留出一些空白日，看起来才像真实的学习节奏
      if (back % 7 === 3 || back % 11 === 5) continue;
      const at = Date.now() - back * 86_400_000 + 3600_000;
      const n = 3 + ((back * 7) % 26);
      // 正确率随时间缓慢上升并带点波动，截图里的曲线才不是一条直线
      const rate = 0.55 + (1 - back / 360) * 0.3 + Math.sin(back / 9) * 0.08;
      for (let i = 0; i < n; i++) {
        seedLog.run(at + i * 1000, 'toefl', 'en2zh', 'sample', Math.random() < rate ? 1 : 0);
      }
      if (back % 3 === 0) seedRev.run('sample', at, 'good');
    }
    user.db.exec('COMMIT');
  }

  dict = new DictDB(resolveDictPath());
  quiz = new Quiz(dict);
  // 自定义词表存在 user.db，跨库拿不到，用回调注入
  quiz.setCustomSource({
    lists: () => user.lists(),
    words: (id) => user.listWords(id),
  });
  const opened = dict.open();
  if (!opened) {
    console.error('[dict] 打开失败：', dict.error);
  } else {
    console.log(`[dict] 已加载 ${dict.meta.words} 条词条，${dict.meta.senses} 条义项，${dict.meta.sentences} 条例句`);
  }

  registerIpc();
  createMainWindow();
  createQuickWindow();
  buildTray();
  // 启动时允许自动换一个可用热键，免得用户开箱就发现悬浮查词没反应
  const hk = registerHotkey({ allowFallback: true });
  if (hk.registered) {
    console.log(`[hotkey] 已注册 ${hk.hotkey}${hk.fellBack ? '（原设置被占用，已自动更换）' : ''}`);
  } else if (settings.hotkeyEnabled) {
    console.warn('[hotkey] 注册失败：', hk.reason);
  }
  refreshTrayMenu(); // 热键定下来之后再刷菜单，标签才是真正生效的那个
  if (settings.clipboardLookup) startClipboardWatch();
  if (settings.selectionMode && settings.selectionMode !== 'off') applySelectionMode();

  // 开机自启时以隐藏状态启动
  if (process.argv.includes('--hidden')) mainWin?.once('ready-to-show', () => mainWin.hide());

  if (shotDir) runShotSequence(shotDir).catch((e) => { console.error('[shot]', e); app.exit(1); });
});

app.on('window-all-closed', () => {
  // 托盘常驻，不退出
  if (!settings.minimizeToTray) app.quit();
});

app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => {
  stopClipboardWatch();
  selection?.stop();
  translator?.dispose();
  asr?.dispose();
  try { if (subWin && !subWin.isDestroyed()) subWin.destroy(); } catch { /* 忽略 */ }
  // 强退时把记录收尾，别让最后几条卡在队列里
  try { lectures?.stop(); } catch { /* 忽略 */ }
  globalShortcut.unregisterAll();
  dict?.close();
  user?.close();
});
