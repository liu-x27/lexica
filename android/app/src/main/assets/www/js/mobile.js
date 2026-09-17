'use strict';
/**
 * 安卓端对渲染层的补丁。加载顺序在 ui.js 之后、app.js 之前。
 *
 * 只做三件事，都是桌面版里由 Electron/Windows 承担、手机上没有对应物的：
 *   1. 朗读改走系统 TTS（WebView 的 speechSynthesis 在很多机型上是哑的）
 *   2. 实体返回键的层级处理
 *   3. 触摸端的搜索框行为（不抢焦点、软键盘上的「搜索」键直接查）
 */
(function (Lx) {
  /* ================================================================ */
  /*  朗读                                                            */
  /* ================================================================ */

  /* WebView 里 speechSynthesis 常常存在但没有任何 voice，调用静默失败，
     排查起来很费劲。安卓侧统一走 TextToSpeech，接口形状与桌面版保持一致。 */
  Lx.tts = {
    voices: [],          // 渲染层用它决定要不要显示语音下拉；安卓上恒为空
    ready: false,
    rate: 0.95,

    init() {
      this.ready = !!(window.AndroidTts && AndroidTts.available());
      // TTS 引擎初始化是异步的，第一次问可能还没好，过一会儿再确认一次
      if (!this.ready) setTimeout(() => { this.ready = !!AndroidTts.available(); }, 1200);
    },

    speak(text, accent = 'us', btn = null) {
      if (!text) return;
      try {
        AndroidTts.speak(String(text), accent, this.rate);
        if (btn) {
          // 系统 TTS 不回调进度，用固定时长把播放态收掉
          btn.classList.add('is-playing');
          setTimeout(() => btn.classList.remove('is-playing'), Math.min(4000, 600 + String(text).length * 60));
        }
      } catch {
        Lx.toast('系统语音不可用，请先在系统设置里安装英语语音');
      }
    },
  };

  /* ================================================================ */
  /*  返回键                                                          */
  /* ================================================================ */

  /**
   * 实体返回键的处理顺序，由内到外剥一层：
   * 建议面板 → 练习的当前阶段 → 非查词页回查词页 → 词条历史 → 交给系统退出。
   *
   * 全部通过点已有按钮实现，不碰 app.js 的内部状态——那边的状态机
   * 只有它自己知道，从外面改必然会漂。
   */
  window.__lexicaBack = () => {
    const q = (sel) => document.querySelector(sel);

    const suggest = q('#suggest');
    if (suggest && !suggest.classList.contains('hidden')) {
      q('#searchInput')?.blur();
      return true;
    }

    const activeView = q('.view.is-active')?.id?.replace('view-', '');

    if (activeView === 'drill') {
      // 练习页自己有层级：答题 → 菜单 → 范围列表
      const back = q('[data-act="drill-menu"]') || q('[data-act="drill-back"]');
      if (back) { back.click(); return true; }
    }

    if (activeView && activeView !== 'dict') {
      q('.nav-btn[data-view="dict"]')?.click();
      return true;
    }

    const backBtn = q('[data-act="back"]');
    if (backBtn && !backBtn.disabled) { backBtn.click(); return true; }

    return false;   // 交给系统，退出应用
  };

  /* ================================================================ */
  /*  触摸端的搜索框                                                  */
  /* ================================================================ */

  window.addEventListener('DOMContentLoaded', () => {
    const input = document.querySelector('#searchInput');
    if (!input) return;

    // 软键盘右下角显示「搜索」而不是换行；关掉首字母大写和自动更正，
    // 否则输入英文单词时会被改成大写开头，查不到。
    input.setAttribute('enterkeyhint', 'search');
    input.setAttribute('autocapitalize', 'none');
    input.setAttribute('autocorrect', 'off');

    // 回车（软键盘的「搜索」）后主动收起键盘，否则结果被挡掉大半屏
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') setTimeout(() => input.blur(), 0);
    });
  });

  /* 主题变化时同步系统状态栏 —— 首屏也要来一次，否则深色主题下顶部还是浅的 */
  window.addEventListener('DOMContentLoaded', () => {
    const sync = () => {
      try { AndroidApp.setTheme(document.documentElement.getAttribute('data-theme') || 'paper'); }
      catch { /* 忽略 */ }
    };
    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });
    sync();
  });

  /* 未捕获的错误落到日志里，手机上没有开发者工具可看 */
  window.addEventListener('error', (e) => {
    try { AndroidApp.appendLog(`[window] ${e.message} @${e.filename}:${e.lineno}`); } catch { /* 忽略 */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { AndroidApp.appendLog(`[promise] ${e.reason && e.reason.stack ? e.reason.stack : e.reason}`); } catch { /* 忽略 */ }
  });
})(window.Lx);
