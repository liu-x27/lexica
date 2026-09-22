'use strict';
/**
 * 电影字幕悬浮窗。
 *
 * 抓系统声音 → 识别 → 翻译 → 在一块置顶的半透明面板上滚动显示。
 * 看视频时把它拖到画面下方，像播放器自带字幕一样。
 *
 * 为什么采音放在这个窗口而不是主窗口：看电影时主窗口会被最小化或挡住，
 * 而 Chromium 会限流不可见窗口的定时器。悬浮窗是置顶常显的，
 * 采音链在这里最稳（这个坑在做课堂自测时踩过一次，卡了 19 分钟）。
 *
 * 只显示最近几条，不做长列表——字幕的用途是当下看懂，不是回顾。
 * 要留记录的话在「实时字幕」页开，那边会写文件。
 */
(function () {
  const api = window.lexica;
  const $ = (s) => document.querySelector(s);

  const st = {
    running: false,
    locked: false,
    lines: [],          // { id, en, zh, pending }
    byId: new Map(),
    fontScale: 1,
    maxLines: 2,
    cap: null,          // 采音句柄
    status: null,
    /* 临时稿：一句话还没说完时的识别结果，会被正式字幕整条替换。
       单独存一份而不是塞进 lines——它没有 id、不落盘，混进去会被当成正式字幕。 */
    partial: null,      // { en, zh }
  };

  /** 只保留最近 N 条，多的丢掉——DOM 一直增长的话几小时后会很卡 */
  const KEEP = 6;

  function setState(text, kind = '') {
    const el = $('#subState');
    if (el) {
      el.textContent = text;
      el.className = `sub-state ${kind}`;
    }
  }

  function paint() {
    const box = $('#subLines');
    if (!box) return;
    const esc = window.Lx.esc;
    /* 临时稿排在最后一行，正式字幕往上挤。
       它占掉一个行位，所以正式字幕少画一条，总高度不变——
       否则悬浮窗会在出临时稿的瞬间跳一下。 */
    const partial = st.partial?.en
      ? `<div class="sub-line is-partial">
           <div class="sub-en">${esc(st.partial.en)}</div>
           <div class="sub-zh${st.partial.zh ? '' : ' is-pending'}">${
             st.partial.zh ? esc(st.partial.zh) : '…'}</div>
         </div>`
      : '';

    if (!st.lines.length && !partial) {
      box.innerHTML = st.running
        ? '<div class="sub-hint">正在听…有人说话时字幕会出现在这里。</div>'
        : '<div class="sub-hint">开启后，这里会显示正在播放内容的英文与中文字幕。</div>';
      return;
    }
    // 只画最后几条，旧的滚出视野
    const room = Math.max(1, st.maxLines - (partial ? 1 : 0));
    const show = st.lines.slice(-room);
    box.innerHTML = show.map((l) => `
      <div class="sub-line" id="sl-${l.id}">
        <div class="sub-en">${esc(l.en)}</div>
        <div class="sub-zh${l.pending ? ' is-pending' : ''}">${
          l.pending ? '…' : esc(l.zh || '')}</div>
      </div>`).join('') + partial;
  }

  function applyFont() {
    document.documentElement.style.setProperty('--sub-scale', String(st.fontScale));
  }

  /* ==================================================================== */
  /*  开关                                                                */
  /* ==================================================================== */

  async function start() {
    if (st.running) return;
    setState('正在启动识别…');
    try {
      st.status = await api.asrStatus();
      const r = await api.subStart();
      if (!r?.ok) throw new Error(r?.reason || '无法开始');

      st.cap = await window.LexicaAudio.start('system', {
        maxChunkSec: st.status?.maxChunkSec || 9,
        silenceMs: st.status?.silenceMs || 420,
        onChunk: (cut) => api.lecFeed(cut.pcm.buffer, cut.startMs),
        // 看电影最吃延迟，滚动字幕在这里收益最大
        partialMs: st.status?.rolling ? (st.status.rollingMs || 1500) : 0,
        onPartial: (snap) => api.lecPartial(snap ? snap.pcm.buffer : null),
      });

      st.running = true;
      setState('正在听', 'is-live');
      paint();
    } catch (e) {
      setState(e.message.slice(0, 60), 'is-error');
      // 半路失败要把主进程那边收掉，否则下次开始会撞上「已经在记录了」
      await api.subStop().catch(() => {});
      st.running = false;
    }
  }

  async function stop() {
    st.running = false;
    if (st.cap) { await st.cap.stop(); st.cap = null; }
    await api.subStop().catch(() => {});
    setState('已停止');
  }

  /* ==================================================================== */
  /*  接线                                                               */
  /* ==================================================================== */

  window.addEventListener('DOMContentLoaded', async () => {
    const s = await api.getSettings();
    st.fontScale = Number(s.subtitleFontScale) || 1;
    st.maxLines = Math.max(1, Math.min(4, Number(s.subtitleLines) || 2));
    applyFont();
    paint();

    document.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;

      if (act === 'sub-close') {
        await stop();
        api.subHide();
        return;
      }
      if (act === 'sub-font') {
        st.fontScale = Math.max(0.7, Math.min(2.2, st.fontScale + Number(el.dataset.v) * 0.1));
        applyFont();
        await api.putSettings({ subtitleFontScale: Number(st.fontScale.toFixed(2)) });
        return;
      }
      if (act === 'sub-lock') {
        /* 锁定 = 鼠标事件穿过整个窗口，能点到后面的播放器。
           代价是窗口自己也点不到了，所以解锁只能靠全局热键
           （主进程注册的那个），这一点要在按钮提示里写清楚。 */
        st.locked = !st.locked;
        $('#subLock').textContent = st.locked ? '已锁定' : '锁定';
        await api.subSetLocked(st.locked);
      }
    });

    /* 临时稿。空的 en 表示「定稿到了，撤掉临时稿」——
       主进程在推正式字幕时会先发一条空的。 */
    api.onLecPartial(({ en, zh }) => {
      st.partial = en ? { en, zh: zh || null } : null;
      paint();
    });

    api.onLecSegment((seg) => {
      st.partial = null;          // 定稿覆盖临时稿
      const row = { ...seg, zh: null, pending: true };
      st.lines.push(row);
      st.byId.set(seg.id, row);
      if (st.lines.length > KEEP) {
        const drop = st.lines.shift();
        st.byId.delete(drop.id);
      }
      paint();
    });

    api.onLecTranslated(({ id, zh }) => {
      const row = st.byId.get(id);
      if (!row) return;
      row.zh = zh;
      row.pending = false;
      paint();
    });

    api.onLecWarn(({ message }) => setState(message.slice(0, 60), 'is-warn'));

    /* 主进程唤起/隐藏这个窗口时通知一声：
       唤起就开始听，隐藏就停掉——不然关掉窗口后识别还在后台跑。 */
    api.onSubToggle(({ on, locked }) => {
      if (locked !== undefined) {
        st.locked = locked;
        const b = $('#subLock');
        if (b) b.textContent = locked ? '已锁定' : '锁定';
      }
      if (on) start();
      else stop();
    });

    // 窗口一显示就开始，省一次点击
    start();
  });
})();
