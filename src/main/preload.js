'use strict';
/** 渲染层唯一的对外接口。上下文隔离开启，渲染层拿不到 Node。 */
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** 主进程推送的事件：返回取消订阅函数 */
const on = (channel, fn) => {
  const wrapped = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
};

contextBridge.exposeInMainWorld('lexica', {
  /* 词典 */
  stats: () => call('dict:stats'),
  lookup: (word, opts) => call('dict:lookup', word, opts),
  suggest: (q, limit) => call('dict:suggest', q, limit),
  search: (q, limit) => call('dict:search', q, limit),
  random: () => call('dict:random'),
  // 抽出任意文本里词库收录的术语，翻译页要用
  sentenceTerms: (text) => call('dict:terms', text),

  /* 生词本与复习 */
  wbToggle: (word) => call('wb:toggle', word),
  wbIsSaved: (word) => call('wb:isSaved', word),
  wbList: (opts) => call('wb:list', opts),
  wbGet: (word) => call('wb:get', word),
  wbAdd: (entry) => call('wb:add', entry),
  wbAnnotate: (entry) => call('wb:annotate', entry),
  wbRemove: (word) => call('wb:remove', word),
  // 带语境收藏：点了字幕里的词、按「收进生词本」
  wbAddContext: (entry) => call('wb:addContext', entry),
  wbRemoveContext: (word, index) => call('wb:removeContext', { word, index }),
  wbCounts: () => call('wb:counts'),
  wbDue: (limit) => call('wb:due', limit),
  wbGrade: (word, grade) => call('wb:grade', word, grade),
  wbExport: (format) => call('wb:export', format),
  wbRevealExport: (p) => call('wb:revealExport', p),

  /* 考纲练习 */
  drillScopes: () => call('drill:scopes'),
  drillProgress: (scope) => call('drill:progress', scope),
  drillStudy: (scope, count) => call('drill:study', scope, count),
  drillQuiz: (scope, count, kinds) => call('drill:quiz', scope, count, kinds),
  drillAssess: (scope, count) => call('drill:assess', scope, count),
  drillAnswer: (payload) => call('drill:answer', payload),
  drillFinish: (payload) => call('drill:finish', payload),
  drillMark: (word, scope, known) => call('drill:mark', word, scope, known),
  drillWeak: (scope, limit) => call('drill:weak', scope, limit),
  drillWeakQuiz: (scope, count) => call('drill:weakQuiz', scope, count),
  drillLabels: () => call('drill:labels'),
  drillExport: (scope) => call('drill:export', scope),
  drillCheckSpell: (input, answer) => call('drill:checkSpell', input, answer),

  /* 自定义词表与词条 */
  lists: () => call('list:all'),
  listCreate: (name, text, note) => call('list:create', name, text, note),
  listDelete: (id) => call('list:delete', id),
  listPreview: (text) => call('list:preview', text),
  listImportFile: () => call('list:importFile'),
  customAll: (limit) => call('custom:all', limit),
  customGet: (word) => call('custom:get', word),
  customPut: (entry) => call('custom:put', entry),
  customDelete: (word) => call('custom:delete', word),

  /* ---- 术语表：用自己维护的译名修正机器翻译 ---- */
  glossAll: () => call('gloss:all'),
  glossPut: (entry) => call('gloss:put', entry),
  glossDelete: (term) => call('gloss:delete', term),
  glossImport: (text, replace) => call('gloss:import', { text, replace }),
  glossReprobe: () => call('gloss:reprobe'),

  /* 机器翻译兜底 */
  mtStatus: () => call('mt:status'),
  mtTranslate: (text) => call('mt:translate', text),
  // 整段翻译。token 用来把进度事件对上是哪一次请求
  mtTranslateLong: (text, token) => call('mt:translateLong', text, token),
  onMtProgress: (fn) => on('mt:progress', fn),

  /* 实时字幕（上课听写） */
  asrStatus: () => call('asr:status'),
  lecStart: (opts) => call('lec:start', opts),
  /* 音频块用 send 而不是 invoke：渲染层不该等识别结果，
     结果通过 onLecSegment / onLecTranslated 事件回来。 */
  lecFeed: (pcm, startMs) => ipcRenderer.send('lec:feed', { pcm, startMs }),
  // 滚动字幕：「说到一半」的音频快照，主进程拿它出临时稿
  lecPartial: (pcm) => ipcRenderer.send('lec:partial', { pcm }),
  lecStop: () => call('lec:stop'),
  lecList: () => call('lec:list'),
  lecSearch: (query) => call('lec:search', query),
  lecRead: (dir) => call('lec:read', dir),
  lecOpen: (dir) => call('lec:open', dir),
  lecReveal: (file) => call('lec:reveal', file),
  lecRecover: (dir) => call('lec:recover', dir),
  lecPickAudio: () => call('lec:pickAudio'),
  lecTranscribeFile: (payload) => call('lec:transcribeFile', payload),
  // 自测用：按真实节奏把一整段 PCM 喂进实时链路（节奏在主进程控制）
  lecSelfTestFeed: (payload) => call('lec:selfTestFeed', payload),

  /* 视频字幕悬浮窗 */
  subStart: () => call('sub:start'),
  subStop: () => call('sub:stop'),
  subHide: () => call('sub:hide'),
  subToggle: (on) => call('sub:toggle', on),
  subSetLocked: (locked) => call('sub:setLocked', locked),
  // 悬浮字幕里点词：交给悬浮查词窗，x/y 是屏幕坐标
  subLookup: (payload) => call('sub:lookup', payload),
  onSubToggle: (fn) => on('sub:toggle', fn),
  onLecSegment: (fn) => on('lec:segment', fn),
  onLecTranslated: (fn) => on('lec:translated', fn),
  onLecWarn: (fn) => on('lec:warn', fn),
  onLecImportProgress: (fn) => on('lec:importProgress', fn),

  /* 目标、备份、日志 */
  goalProgress: () => call('goal:progress'),
  backupExport: () => call('backup:export'),
  backupImport: () => call('backup:import'),
  openLog: () => call('app:openLog'),

  /* 学习统计 */
  heatmap: (days) => call('stats:heatmap', days),

  /* 历史 */
  recent: (limit) => call('hist:recent', limit),
  clearHistory: () => call('hist:clear'),

  /* 设置 */
  getSettings: () => call('set:all'),
  putSettings: (patch) => call('set:put', patch),
  openDataFolder: () => call('app:openDataFolder'),
  relaunch: () => call('app:relaunch'),

  /* 悬浮窗 */
  quickHide: () => call('app:quickHide'),
  quickToMain: (word) => call('app:quickToMain', word),

  /* 事件 */
  onLookup: (fn) => on('nav:lookup', fn),
  onView: (fn) => on('nav:view', fn),
  onTheme: (fn) => on('set:theme', fn),
  onWordbookChanged: (fn) => on('wb:changed', fn),
  onLecPartial: (fn) => on('lec:partial', fn),
  onQuickOpen: (fn) => on('quick:open', fn),
});
