'use strict';
/* Lexica 渲染层公共工具：图标、转义、DOM、Toast。挂在全局 Lx 上。 */
window.Lx = window.Lx || {};

/* ------------------------------------------------------------------ 图标 */
/* 统一 24 格线性图标，stroke 走 currentColor（见 base.css 的 svg 规则） */
const P = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  cards: '<rect x="3" y="6" width="13" height="15" rx="2"/><path d="M8 3h10a2 2 0 0 1 2 2v11"/>',
  // 真正的齿轮轮廓。之前用「圆 + 放射线」画，结果和 sun 图标几乎一样，
  // 侧栏里「设置」和「切换主题」两个按钮看着是同一个东西。
  cog: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11A1.7 1.7 0 0 0 4.67 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.11A1.7 1.7 0 0 0 19.4 15z"/>',
  volume: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/>',
  bookmark: '<path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6m4-6v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  shuffle: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  check: '<path d="m5 12 5 5L19 7"/>',
  arrowRight: '<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>',
  corner: '<path d="M9 4v10a2 2 0 0 0 2 2h9"/><path d="m16 12 4 4-4 4"/>',
  wand: '<path d="M15 4V2m0 20v-2M4 15H2m20 0h-2M6.3 6.3 4.9 4.9m14.2 14.2-1.4-1.4"/><path d="m11 13 8 8"/><circle cx="9" cy="11" r="3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
  flame: '<path d="M12 22c4.2 0 7-2.6 7-6.4 0-3-1.7-5.2-3.4-7.1C14.2 6.9 13 5.3 13 3c-2 1-3.6 2.9-3.6 5.2 0 1.2.4 2 .4 2.6 0 1-.8 1.7-1.7 1.7-1.1 0-2-1-2-2.4-1.3 1.4-2.1 3.3-2.1 5.5C4 19.4 7.1 22 12 22z"/>',
  quote: '<path d="M9 7H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v3H4"/><path d="M19 7h-4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v3h-3"/>',
  // 字母 A 与汉字「文」并排，翻译功能的通用画法
  translate: '<path d="M3 6h8"/><path d="M7 6V4"/><path d="M9.5 6c0 3.6-2.6 6.6-6 7.4"/><path d="M4.5 9.5c.9 2.2 2.7 3.5 5 4.2"/><path d="M13 20l4-10 4 10"/><path d="M14.4 16.5h5.2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  alert: '<path d="M12 4 2.5 20h19L12 4z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  mic: '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/><path d="M8 22h8"/>',
};

Lx.icon = (name, cls = '') =>
  `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${P[name] || ''}</svg>`;

/* 实心星（柯林斯星级用） */
Lx.starSolid = (on) =>
  `<svg viewBox="0 0 24 24"><path class="${on ? 'on' : 'off'}" d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/></svg>`;

/* ------------------------------------------------------------ 文本安全 */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
Lx.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * 在已转义的英文文本里高亮目标词及其变形。
 * 先转义再插标签，所以不会引入注入风险。
 */
Lx.highlight = (text, word, forms = []) => {
  const safe = Lx.esc(text);
  const stems = [word, ...forms].filter((w) => w && /^[a-zA-Z'-]+$/.test(w));
  if (!stems.length) return safe;
  // 长词优先，避免 run 抢在 running 前面
  stems.sort((a, b) => b.length - a.length);
  const alt = stems.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // 再加一个宽松的词干前缀匹配，覆盖没登记的变形
  const base = word.length > 4 ? `|${word.slice(0, Math.max(4, word.length - 2))}[a-z]{0,4}` : '';
  try {
    return safe.replace(new RegExp(`\\b(${alt}${base})\\b`, 'gi'), '<mark>$1</mark>');
  } catch {
    return safe;
  }
};

/* --------------------------------------------------------------- DOM */
Lx.$ = (sel, root = document) => root.querySelector(sel);
Lx.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

Lx.debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

/* ------------------------------------------------------- 虚拟滚动列表 */
/**
 * 窗口化渲染的长列表：只渲染可视区加缓冲区的行，其余用一个撑高的占位块顶住。
 * 行高固定（CSS 里锁死），所以偏移量可以直接算出来，不需要测量每一行。
 *
 *   const vl = new Lx.VirtualList({ mount, scroller, rowHeight: 76, render });
 *   vl.setItems(rows);
 */
Lx.VirtualList = class VirtualList {
  constructor({ mount, scroller, rowHeight, render, overscan = 8 }) {
    this.mount = mount;
    this.scroller = scroller;
    this.rowHeight = rowHeight;
    this.render = render;
    this.overscan = overscan;
    this.items = [];
    this.range = [-1, -1];

    this.mount.classList.add('vlist');
    this.mount.innerHTML = '<div class="vlist-spacer"><div class="vlist-window"></div></div>';
    this.spacer = this.mount.querySelector('.vlist-spacer');
    this.win = this.mount.querySelector('.vlist-window');

    this._onScroll = () => this._paint();
    this.scroller.addEventListener('scroll', this._onScroll, { passive: true });
    this._onResize = () => { this._measure(); this._paint(true); };
    window.addEventListener('resize', this._onResize);
  }

  setItems(items) {
    this.items = items || [];
    this.spacer.style.height = `${this.items.length * this.rowHeight}px`;
    this.range = [-1, -1];
    this._measure();
    this._paint(true);
  }

  /** 记下挂载点在滚动容器内容坐标系里的位置 */
  _measure() {
    const m = this.mount.getBoundingClientRect();
    const s = this.scroller.getBoundingClientRect();
    this.top = m.top - s.top + this.scroller.scrollTop;
  }

  _paint(force = false) {
    const n = this.items.length;
    if (!n) {
      this.win.innerHTML = '';
      return;
    }
    const viewTop = this.scroller.scrollTop - this.top;
    const viewH = this.scroller.clientHeight;

    let start = Math.floor(viewTop / this.rowHeight) - this.overscan;
    let end = Math.ceil((viewTop + viewH) / this.rowHeight) + this.overscan;
    start = Math.max(0, start);
    end = Math.min(n, Math.max(start, end));

    if (!force && start === this.range[0] && end === this.range[1]) return;
    this.range = [start, end];

    let html = '';
    for (let i = start; i < end; i++) html += this.render(this.items[i], i);
    this.win.style.transform = `translateY(${start * this.rowHeight}px)`;
    this.win.innerHTML = html;
  }

  destroy() {
    this.scroller.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
    this.mount.classList.remove('vlist');
    this.mount.innerHTML = '';
  }
};

/* -------------------------------------------------------------- Toast */
Lx.toast = (msg, ms = 2200) => {
  let host = Lx.$('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 240);
  }, ms);
};

/* ---------------------------------------------------------------- TTS */
/* Windows 自带 SAPI 语音，完全离线；优先挑英语语音 */
Lx.tts = {
  voices: [],
  ready: false,
  rate: 0.95,

  init() {
    const load = () => {
      this.voices = (speechSynthesis.getVoices() || []).filter((v) => /^en/i.test(v.lang));
      this.ready = this.voices.length > 0;
    };
    load();
    speechSynthesis.onvoiceschanged = load;
  },

  pick(accent) {
    if (!this.voices.length) return null;
    const want = accent === 'uk' ? /en-GB/i : /en-US/i;
    return this.voices.find((v) => want.test(v.lang)) || this.voices[0];
  },

  /** @param btn 可选，播放期间加上 is-playing 类 */
  speak(text, accent = 'us', btn = null) {
    if (!text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      const v = this.pick(accent);
      if (v) u.voice = v;
      u.lang = accent === 'uk' ? 'en-GB' : 'en-US';
      u.rate = this.rate;
      if (btn) {
        btn.classList.add('is-playing');
        const off = () => btn.classList.remove('is-playing');
        u.onend = off;
        u.onerror = off;
      }
      speechSynthesis.speak(u);
    } catch {
      Lx.toast('系统语音不可用');
    }
  },
};

/* --------------------------------------------------------- 词性色板 */
const POS_HUE = {
  n: 232, v: 150, adj: 32, a: 32, j: 32, adv: 292, r: 292,
  prep: 195, i: 195, conj: 265, c: 265, pron: 320, p: 320, num: 90, m: 90,
};
Lx.posColor = (pos, i = 0) => {
  const h = POS_HUE[pos] ?? (200 + i * 47) % 360;
  return `oklch(var(--badge-l) 0.13 ${h})`;
};

/* ------------------------------------------------------ 难度标签展示 */
Lx.TAG_LABEL = {
  zk: '中考', gk: '高考', cet4: '四级', cet6: '六级',
  ky: '考研', toefl: '托福', ielts: '雅思', gre: 'GRE',
};
Lx.TAG_ORDER = ['zk', 'gk', 'cet4', 'cet6', 'ky', 'ielts', 'toefl', 'gre'];

Lx.badges = (tags, oxford) => {
  const codes = (tags || []).slice().sort((a, b) => Lx.TAG_ORDER.indexOf(a) - Lx.TAG_ORDER.indexOf(b));
  const out = codes.map((c) => `<span class="badge badge-${c}">${Lx.TAG_LABEL[c] || c}</span>`);
  if (oxford) out.push('<span class="badge badge-oxford">牛津3000</span>');
  return out.join('');
};

Lx.stars = (n) => {
  if (!n) return '';
  let s = '<span class="stars" title="柯林斯星级 ' + n + '/5">';
  for (let i = 1; i <= 5; i++) s += Lx.starSolid(i <= n);
  return s + '</span>';
};

/* 词频排名 → 人话 */
Lx.freqLabel = (rank) => {
  if (!rank || rank >= 999999) return { text: '低频/专业词', pct: 4 };
  if (rank <= 1000) return { text: `最常用 1000 词（第 ${rank} 位）`, pct: 100 };
  if (rank <= 3000) return { text: `常用 3000 词（第 ${rank} 位）`, pct: 88 };
  if (rank <= 8000) return { text: `中频词（第 ${rank} 位）`, pct: 68 };
  if (rank <= 20000) return { text: `较低频（第 ${rank} 位）`, pct: 46 };
  if (rank <= 60000) return { text: `低频（第 ${rank} 位）`, pct: 26 };
  return { text: `罕见词（第 ${rank} 位）`, pct: 12 };
};
