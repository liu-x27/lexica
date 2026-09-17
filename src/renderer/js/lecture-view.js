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
  Lx.lectureRow = (seg) => `
    <div class="lec-time">${Lx.lectureClock(seg.t0)}</div>
    <div class="lec-texts">
      <div class="lec-en">${esc(seg.en)}</div>
      ${
        seg.pending
          ? '<div class="lec-zh is-pending">翻译中…</div>'
          : seg.zh
            ? `<div class="lec-zh">${esc(seg.zh)}</div>`
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
    return `<div class="lec-list scroll" id="lecList">
      ${st.segments.map((s) => `<div class="lec-row" id="lec-${s.id}">${Lx.lectureRow(s)}</div>`).join('')}
    </div>`;
  }

  function renderHistory(st) {
    if (!st.history.length) {
      return '<div class="lec-empty">还没有记录。上完一节课，这里会列出全部文件。</div>';
    }
    return `<div class="lec-history">
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
          <button class="seg-btn ${st.view === 'history' ? 'is-on' : ''}" data-act="lec-tab" data-v="history">历史</button>
        </div>
      </div>

      ${st.view === 'live' ? renderControls(st, SOURCES) : ''}
      ${renderImport(st)}

      <div id="lecWarn" class="lec-warn ${st.warn ? '' : 'hidden'}">${esc(st.warn || '')}</div>

      ${st.view === 'live' ? renderLive(st) : renderHistory(st)}

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
              识别用的是 whisper base 模型，翻译用的是本地小模型，两边都会出错：
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
