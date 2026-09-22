'use strict';
/* 实时字幕页的渲染。
 *
 * 版式上的一个决定：英文在上、中文在下，两行等宽并列，中文用竖线标出来。
 * 不做「只看中文」的模式——识别和翻译各有各的错法（whisper 会把
 * training 听成 twinning，翻译模型会把数字改错），原文必须一直在旁边。
 */
(function (Lx) {
  const { esc, icon } = Lx;

  /** 毫秒 → 0:00 / 1:02:03 */
  Lx.lectureClock = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  };

  Lx.lectureImportLabel = (im) => {
    if (!im) return '';
    if (im.phase === 'decode') return `正在解码 ${esc(im.name)}…`;
    if (im.phase === 'asr') return `识别中 ${im.percent || 0}%${im.minutes ? `（共 ${im.minutes} 分钟）` : ''}`;
    if (im.phase === 'mt') return `翻译中 ${im.percent || 0}%`;
    return '处理中…';
  };

  /** 一条字幕：英文 + 中文 */
  /**
   * 字幕行。定稿和滚动字幕的临时稿共用这一个函数。
   *
   * 共用是必须的：`.lec-row` 是两列网格（时间 52px + 正文），
   * 另写一份 DOM 必然漏掉 `.lec-texts` 那层包裹，英文就会掉进时间那一窄列里、
   * 变成一行一两个词竖着排。第一版临时稿就是这么写坏的。
   *
   * @param seg.partial true 表示这是还没说完的临时稿
   */
  Lx.lectureRow = (seg) => `
    <div class="lec-time">${seg.partial ? '···' : Lx.lectureClock(seg.t0)}</div>
    <div class="lec-texts">
      <div class="lec-en">${esc(seg.en)}</div>
      ${
        seg.zh
          ? `<div class="lec-zh">${esc(seg.zh)}</div>`
          : seg.partial
            ? '<div class="lec-zh is-pending">正在说…</div>'
            : seg.pending
              ? '<div class="lec-zh is-pending">翻译中…</div>'
              : `<div class="lec-zh is-empty">${esc(seg.reason || '未译出')}</div>`
      }
    </div>`;

  function renderNotInstalled(st) {
    return `<div class="page"><div class="blank"><div>
      <div class="blank-mark">🎙</div>
      <div class="blank-title">还没有安装语音识别组件</div>
      <div class="blank-text">
        实时字幕用的是 whisper.cpp 的官方 Windows 版 + 语音模型，完全离线。<br>
        在项目目录执行：<br><br>
        <span class="mono">npm run fetch:asr</span> — 下载识别组件（约 90MB，含 base 模型）<br>
        <span class="mono">npm run fetch:asr -- --all</span> — 连快速版与高精度版一起下（约 330MB）<br><br>
        <span class="faint">装好后重启应用即可。存放位置：${esc(st.status?.dir || 'data/asr')}</span>
      </div>
    </div></div></div>`;
  }

  function renderControls(st, SOURCES) {
    const busy = st.running || st.starting || !!st.importing;
    const models = st.status?.models || [];
    const modelLabel = models.find((m) => m.key === st.status?.model)?.label
      || models.find((m) => m.key === (Lx.settings?.asrModel))?.label
      || '—';

    return `
      <div class="lec-bar">
        <div class="lec-bar-main">
          <input class="lec-title" id="lecTitle" data-act="lec-title" type="text"
                 placeholder="课程名（进文件名，可留空）" value="${esc(st.title)}"
                 ${busy ? 'disabled' : ''}>
          <div class="seg lec-sources">
            ${Object.entries(SOURCES).map(([k, v]) => `
              <button class="seg-btn ${st.source === k ? 'is-on' : ''}"
                      data-act="lec-source" data-v="${k}" title="${esc(v.hint)}"
                      ${st.running ? 'disabled' : ''}>${esc(v.label)}</button>`).join('')}
          </div>
        </div>

        <div class="lec-bar-actions">
          ${
            st.running
              ? `<div class="lec-live">
                   <span class="lec-dot"></span>
                   <span id="lecClock">${Lx.lectureClock(Date.now() - st.startedAt)}</span>
                 </div>
                 <div class="lec-meter"><i id="lecLevel"></i></div>
                 <button class="btn btn-accent" data-act="lec-stop">${icon('x')} 停止并保存</button>`
              : st.source === 'import'
                ? `<button class="btn btn-accent" data-act="lec-import" ${busy ? 'disabled' : ''}>
                     ${icon('folder')} 选择录音文件</button>`
                : `<button class="btn btn-accent" data-act="lec-start" ${busy ? 'disabled' : ''}>
                     ${icon('volume')} ${st.starting ? '正在启动…' : '开始记录'}</button>`
          }
        </div>
      </div>

      <div class="lec-meta">
        <span>${esc(SOURCES[st.source]?.hint || '')}</span>
        <span class="spacer"></span>
        <span class="faint">识别 ${esc(modelLabel)}　翻译 ${esc(st.status?.mtModel || '—')}
          ${st.status?.mtModels?.length ? '' : '（未安装）'}</span>
      </div>`;
  }

  function renderImport(st) {
    if (!st.importing) return '';
    return `<div class="lec-import">
      <div class="lec-import-text" id="lecImportText">${Lx.lectureImportLabel(st.importing)}</div>
      <div class="lec-import-bar"><i id="lecImportBar" style="width:${st.importing.percent || 0}%"></i></div>
      <div class="faint">一小时的录音大约要几分钟，期间可以切去别的页面。</div>
    </div>`;
  }

  function renderLive(st) {
    if (!st.segments.length) {
      return `<div class="lec-empty">
        ${st.running
          ? '正在听…第一句大约 6～9 秒后出现（要等你说完一句、识别、再翻译）。'
          : '按「开始记录」后，英文与中文会逐句出现在这里，同时写进文件。'}
      </div>`;
    }
    /* data-ctx-src：点里面的词可以查（word-popover.js），值是收藏时记下的出处 */
    return `<div class="lec-list scroll" id="lecList" data-ctx-src="${esc(st.title || '课堂记录')}">
      ${st.segments.map((s) => `<div class="lec-row" id="lec-${s.id}">${Lx.lectureRow(s)}</div>`).join('')}
    </div>`;
  }

  /* ------------------------------------------------------ 历史：搜索 */

  const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * 把命中的关键词包上 <mark>。先切分再逐段转义——
   * 反过来（先转义再替换）会把 &amp; 之类的实体切坏。
   */
  function marked(text, tokens) {
    const s = String(text || '');
    if (!tokens?.length || !s) return esc(s);
    const re = new RegExp(`(${tokens.map(escRe).join('|')})`, 'gi');
    return s.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
  }

  const dateOf = (ms) => (ms ? new Date(ms).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '');

  /**
   * 搜索结果。单独导出：敲字时只重绘这一块，
   * 整页重绘会换掉输入框，光标和输入法状态都会丢。
   */
  Lx.lectureSearchResults = (st) => {
    const r = st.search?.res;
    const q = (st.search?.query || '').trim();
    if (!q) return '';
    if (!r) return '<div class="lec-empty">搜索中…</div>';
    if (!r.total) return `<div class="lec-empty">没有找到「${esc(q)}」。换个说法试试，或者只搜其中一个词。</div>`;

    // 按课分组，课的顺序沿用搜索结果（新的在前）
    const groups = [];
    const byDir = new Map();
    for (const h of r.hits) {
      if (!byDir.has(h.dir)) { const g = { ...h, hits: [] }; byDir.set(h.dir, g); groups.push(g); }
      byDir.get(h.dir).hits.push(h);
    }

    return `<div class="lec-res-sum">找到 ${r.total} 处，分布在 ${groups.length} 节课里${
      r.truncated ? `（只列出前 ${r.hits.length} 处，换个更具体的词能缩小范围）` : ''}</div>
      ${groups.map((g) => `
        <div class="lec-res-group">
          <div class="lec-res-title">${esc(g.title)}<span class="faint">　${dateOf(g.startedAt)}　${g.hits.length} 处</span></div>
          ${g.hits.map((h) => `
            <div class="lec-res-hit" data-act="lec-view" data-dir="${esc(h.dir)}" data-focus="${h.id}"
                 title="打开这节课，定位到这一句">
              <div class="lec-time">${Lx.lectureClock(h.t0)}</div>
              <div class="lec-texts">
                <div class="lec-res-en">${marked(h.en, r.tokens)}</div>
                ${h.zh ? `<div class="lec-res-zh">${marked(h.zh, r.tokens)}</div>` : ''}
              </div>
            </div>`).join('')}
        </div>`).join('')}`;
  };

  /* ------------------------------------------------------ 历史：查看一节课 */

  /**
   * 应用内的转写稿查看页。原先历史里只能「打开文件夹」，
   * 搜到了也没处可去。这里点词同样能查、能收藏（data-ctx-src 是这节课的课名）。
   */
  function renderTranscript(st) {
    const v = st.viewing;
    if (!v) return '<div class="lec-empty">读取中…</div>';
    return `<div class="lec-viewer-head">
        <button class="btn btn-outline btn-xs" data-act="lec-back">${icon('left')} 返回</button>
        <div class="lec-hist-title">${esc(v.title)}</div>
        <span class="faint">${dateOf(v.startedAt)}　${v.segments.length} 条</span>
        <span class="spacer"></span>
        <span class="faint lec-viewer-tip">点英文里的词可以查、可以收进生词本</span>
      </div>
      <div class="lec-list scroll lec-viewer" id="lecViewer" data-ctx-src="${esc(v.title)}">
        ${v.segments.length
          ? v.segments.map((s) => `<div class="lec-row${s.id === v.focusId ? ' is-focus' : ''}"
                id="lecv-${s.id}">${Lx.lectureRow(s)}</div>`).join('')
          : '<div class="lec-empty">这节课没有字幕。</div>'}
      </div>`;
  }

  function renderHistory(st) {
    if (!st.history.length) {
      return '<div class="lec-empty">还没有记录。上完一节课，这里会列出全部文件。</div>';
    }
    const q = st.search?.query || '';
    const box = `<div class="lec-search">
        ${icon('search')}
        <input class="lec-search-input" id="lecSearch" type="text" spellcheck="false" autocomplete="off"
               placeholder="在全部转写稿里搜，如 replay buffer 或 经验回放" value="${esc(q)}">
      </div>`;
    // 有关键词时列表换成搜索结果；结果区单独一个容器，敲字时只刷它
    if (q.trim()) return `${box}<div id="lecResults" class="lec-results">${Lx.lectureSearchResults(st)}</div>`;
    return `${box}<div id="lecResults" class="lec-results"></div><div class="lec-history">
      ${st.history.map((h) => `
        <div class="lec-hist">
          <div class="lec-hist-main">
            <div class="lec-hist-title">${esc(h.title)}</div>
            <div class="lec-hist-sub">
              ${esc(h.name.slice(0, 16))}　${h.segments} 条　${Lx.lectureClock(h.durationMs)}
              ${h.unfinished ? '<span class="lec-tag-warn">上次未正常结束</span>' : ''}
            </div>
            <div class="lec-hist-files">
              ${Object.keys(h.files).length
                ? Object.keys(h.files).map((k) => `<span class="lec-file">${k}</span>`).join('')
                : '<span class="faint">没有成品文件</span>'}
            </div>
          </div>
          <div class="row row-gap-2">
            ${h.segments ? `<button class="btn btn-outline btn-xs" data-act="lec-view" data-dir="${esc(h.dir)}"
                 title="在应用里看这节课的转写稿">${icon('book')} 查看</button>` : ''}
            ${h.unfinished || !Object.keys(h.files).length
              ? `<button class="btn btn-outline btn-xs" data-act="lec-recover" data-dir="${esc(h.dir)}"
                   title="从流水账重新生成 md/txt/srt/json">${icon('corner')} 恢复</button>`
              : ''}
            <button class="btn btn-outline btn-xs" data-act="lec-open" data-dir="${esc(h.dir)}">
              ${icon('folder')} 打开目录</button>
          </div>
        </div>`).join('')}
    </div>`;
  }

  Lx.renderLecture = (st, SOURCES) => {
    if (!st.status?.available) return renderNotInstalled(st);

    return `<div class="page lec-page">
      <div class="wb-head">
        <div class="wb-title">实时字幕</div>
        <div class="wb-sub">边上课边出双语字幕，同时写进文件。完全离线。</div>
        <div class="spacer"></div>
        <button class="btn btn-outline btn-xs" data-act="lec-subtitle"
                title="抓系统声音，在置顶悬浮窗上显示字幕。看电影、看视频用">
          ${icon('quote')} 视频字幕悬浮窗</button>
        <div class="seg">
          <button class="seg-btn ${st.view === 'live' ? 'is-on' : ''}" data-act="lec-tab" data-v="live">本节</button>
          <button class="seg-btn ${st.view !== 'live' ? 'is-on' : ''}" data-act="lec-tab" data-v="history">历史</button>
        </div>
      </div>

      ${st.view === 'live' ? renderControls(st, SOURCES) : ''}
      ${renderImport(st)}

      <div id="lecWarn" class="lec-warn ${st.warn ? '' : 'hidden'}">${esc(st.warn || '')}</div>

      ${st.view === 'live' ? renderLive(st) : st.view === 'transcript' ? renderTranscript(st) : renderHistory(st)}

      ${
        st.view === 'live' && st.segments.length
          ? `<div class="lec-foot">
               <span class="faint">${st.segments.length} 条${
                 st.session ? `　→ ${esc(st.session.name)}` : ''}</span>
               <span class="spacer"></span>
               <button class="btn btn-ghost btn-xs" data-act="lec-copy">${icon('copy')} 复制全部</button>
               ${st.session ? `<button class="btn btn-ghost btn-xs" data-act="lec-open"
                   data-dir="${esc(st.session.dir)}">${icon('folder')} 打开目录</button>` : ''}
             </div>`
          : ''
      }

      ${
        st.view === 'live' && !st.segments.length && !st.running
          ? `<div class="tr-tip">${icon('alert')}
              <div><strong>关于准确度</strong><br>
              识别和翻译都会出错（识别默认用 whisper small，翻译默认用本地模型，可在设置里开在线翻译）：
              实测 <span class="mono">training</span> 会被听成 <span class="mono">twinning</span>，
              翻译模型会把 <span class="mono">63.8</span> 写成 <span class="mono">638</span>。
              所以这里始终英中对照显示，重要内容（尤其是数字、公式、人名）请以英文原文为准。<br>
              记录会存成 ${esc((Lx.settings?.lectureFormats || ['md']).join(' / '))}，
              可在设置页调整。</div>
            </div>`
          : ''
      }
    </div>`;
  };
})(window.Lx);
