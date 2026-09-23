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
const { createCore, IPC_CHANNELS } = require('./app-core');
const { Quiz } = require('./quiz');
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
const { runShotSequence, seedShotProfile } = require('./self-test');

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

  /* ---- 与安卓共用的业务层 ----
     查词、生词本、练习、自定义词表与词条都在 app-core.js 里，安卓的 shim 用的是同一份。
     这里只把它的方法挂到各自的 IPC 通道上；通道表也在 app-core.js，测试会拿它和
     preload 逐条对账。 */
  const core = createCore({ dict, user, quiz, emit: broadcast });
  for (const [channel, method] of Object.entries(IPC_CHANNELS)) handle(channel, core.api[method]);
  // preload 把这一个的两个参数包成了一个对象
  handle('wb:removeContext', (p) => core.api.wbRemoveContext(p?.word, p?.index));

  /* 两个导出：内容由 app-core 生成（安卓生成的是同一份），存到哪里由这里问用户 */
  handle('wb:export', async (format) => {
    const file = core.wordbookFile(format);
    if (!file.ok) return file;
    const isAnki = format === 'anki';
    const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
      title: isAnki ? '导出为 Anki 可导入的 TSV' : '导出为 CSV',
      defaultPath: file.filename,
      filters: isAnki ? [{ name: 'TSV', extensions: ['tsv'] }] : [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, reason: '已取消' };
    fs.writeFileSync(filePath, file.content, 'utf8');
    return { ok: true, filePath, count: file.count };
  });

  handle('wb:revealExport', (p) => { if (p) shell.showItemInFolder(p); });

  handle('drill:export', async (onlyScope) => {
    const file = core.drillFile(onlyScope);
    if (!file.ok) return file;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
      title: '导出练习进度',
      defaultPath: file.filename,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, reason: '已取消' };
    fs.writeFileSync(filePath, file.content, 'utf8');
    return { ok: true, filePath, scopes: file.scopes, weak: file.weak };
  });

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

  /* ---- 自定义词表：导入文件要弹系统对话框，只有这一个是桌面自己的 ---- */
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

  if (shotDir) seedShotProfile({ user, settings });

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

  if (shotDir) {
    runShotSequence(shotDir, {
      // 窗口用 getter：字幕悬浮窗是跑到一半才第一次建出来的
      get mainWin() { return mainWin; },
      get quickWin() { return quickWin; },
      get subWin() { return subWin; },
      online,
      settings,
      broadcast,
      showQuickWindow,
      toggleSubtitleWindow,
      setQuitting: () => { quitting = true; },
    }).catch((e) => { console.error('[shot]', e); app.exit(1); });
  }
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
  /* 两个识别服务都是 whisper-server 子进程，Windows 上父进程退出不会带走它们。
     rollAsr 原先漏在这里：开着滚动字幕退出，它会一直占着端口和几百 MB 内存。 */
  asr?.dispose();
  rollAsr?.dispose();
  try { if (subWin && !subWin.isDestroyed()) subWin.destroy(); } catch { /* 忽略 */ }
  // 强退时把记录收尾，别让最后几条卡在队列里
  try { lectures?.stop(); } catch { /* 忽略 */ }
  globalShortcut.unregisterAll();
  dict?.close();
  user?.close();
});
