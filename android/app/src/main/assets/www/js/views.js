'use strict';
/* 生词本 / 复习 / 设置 三个视图的渲染。同样只输出 HTML，交互交给 app.js。 */
(function (Lx) {
  const { esc, icon, badges, stars, freqLabel } = Lx;

  const DAY = 86_400_000;

  /** 到期时间 → 人话 */
  function dueText(due) {
    const diff = due - Date.now();
    if (diff <= 0) return { text: '待复习', due: true };
    if (diff < 3600_000) return { text: `${Math.ceil(diff / 60_000)} 分钟后`, due: false };
    if (diff < DAY) return { text: `${Math.ceil(diff / 3600_000)} 小时后`, due: false };
    const d = Math.ceil(diff / DAY);
    if (d < 30) return { text: `${d} 天后`, due: false };
    return { text: `${Math.round(d / 30)} 个月后`, due: false };
  }

  /* ==================================================================== */
  /*  生词本                                                              */
  /* ==================================================================== */

  /**
   * 生词本的编辑框。
   *
   * 不做浮层：这个应用里没有 modal 这套原语，而「自定义」页早就是
   * 「上面一块表单 + 下面一个列表」的样子，沿用同一个模式更一致。
   * 默认折叠——列表才是主体，表单常驻会把列表挤下去。
   *
   * 表单里的值在重绘前必须先收回 state（见 app.js 的 captureWbDraft），
   * 否则一次重绘就把用户正在打的字冲掉。
   */
  function wbEditor(ed) {
    if (!ed || !ed.open) return '';
    const isNew = !ed.saved;
    /* data-for 记下这块表单是给哪个词渲染的。
       回收草稿时要比对它——切到另一个词时页面上可能还挂着上一个词的旧表单，
       不比对就会把旧词的输入写进新词的草稿里。 */
    return `<div class="cu-form wb-form" id="wbForm" data-for="${esc(ed.word || '')}">
      <div class="cu-form-row">
        <input class="cu-input" id="wbWord" spellcheck="false"
               placeholder="单词或词组，如 replay buffer"
               value="${esc(ed.word || '')}" ${ed.lockWord ? 'readonly' : ''}>
        <button class="btn btn-accent" data-act="wb-save">${isNew ? '加入生词本' : '保存'}</button>
        <button class="btn btn-outline" data-act="wb-cancel">取消</button>
      </div>
      ${
        /* 词库里查到了就把摘要摆出来，省得用户重复抄一遍；
           查不到就说清楚，让人知道这条只能靠自己写。 */
        ed.word
          ? (ed.inDict
            ? `<div class="wb-form-hint">词库释义：${esc((ed.dictBrief || '').slice(0, 120))}
                 ${ed.phonetic ? `<span class="faint">/${esc(ed.phonetic)}/</span>` : ''}</div>`
            : '<div class="wb-form-hint is-warn">词库里没有这个词条，下面写的释义就是它唯一的释义</div>')
          : ''
      }
      <textarea class="cu-textarea" id="wbDef" rows="2" spellcheck="false"
        placeholder="我的释义（会显示在列表、词条页和复习卡上，留空就用词库的）">${esc(ed.myDef || '')}</textarea>
      <textarea class="cu-textarea" id="wbNote" rows="3" spellcheck="false"
        placeholder="我的笔记：哪节课遇到的、和哪个词容易混、例句…">${esc(ed.note || '')}</textarea>
      ${
        ed.saved
          ? `<div class="row row-gap-2">
               <span class="spacer"></span>
               <button class="btn btn-outline" data-act="wb-drop" data-word="${esc(ed.word)}">
                 ${icon('trash')} 移出生词本
               </button>
             </div>`
          : ''
      }
    </div>`;
  }

  Lx.renderWordbook = (rows, counts, filter, ed = null) => {
    const chips = [
      ['all', '全部'],
      ['due', '待复习'],
      ['fresh', '未学'],
      ['mature', '已掌握'],
      // 有笔记/我的释义的——「完整查看自己加的东西」靠这个筛
      ['noted', `我写过的${counts.noted ? ` ${counts.noted}` : ''}`],
      ...Lx.TAG_ORDER.map((t) => [t, Lx.TAG_LABEL[t]]),
    ]
      .map(
        ([k, label]) =>
          `<button class="filter-btn ${filter === k ? 'is-on' : ''}" data-act="wb-filter" data-filter="${k}">${label}</button>`,
      )
      .join('');

    /* 列表体由虚拟滚动接管（见 app.js 的 wbVList），这里只给容器。
       行高在 CSS 里锁成固定值，虚拟滚动才能直接算偏移。 */
    const list = rows.length
      ? '<div class="wb-list" id="wbList"></div>'
      : `<div class="blank">
           <div>
             <div class="blank-mark">${filter === 'all' ? '∅' : '—'}</div>
             <div class="blank-title">${filter === 'all' ? '生词本还是空的' : '这个分类下没有词'}</div>
             <div class="blank-text">查词时点右上角的书签图标，就能把词收进来。<br>
               词库里没有的词组，用上面的「手动添加」自己写一条。</div>
             <div class="blank-tips">
               <button class="btn btn-outline" data-act="wb-new">${icon('bookmark')} 手动添加</button>
             </div>
           </div>
         </div>`;

    return `<div class="page">
      <div>
        <div class="wb-head">
          <div class="wb-title">生词本</div>
          <div class="spacer"></div>
          <div class="wb-stats">
            <div><div class="wb-stat-num">${counts.total}</div><div class="wb-stat-label">收录</div></div>
            <div><div class="wb-stat-num">${counts.due}</div><div class="wb-stat-label">待复习</div></div>
            <div><div class="wb-stat-num">${counts.mature}</div><div class="wb-stat-label">已掌握</div></div>
            <div><div class="wb-stat-num">${counts.reviewedToday}</div><div class="wb-stat-label">今日已复习</div></div>
          </div>
        </div>

        <div class="filter-row">
          ${chips}
          <div class="spacer"></div>
          <button class="btn btn-outline" data-act="wb-new">${icon('bookmark')} 手动添加</button>
          <button class="btn btn-outline" data-act="export-csv">${icon('download')} 导出 CSV</button>
          <button class="btn btn-outline" data-act="export-anki">${icon('download')} 导出 Anki</button>
        </div>

        ${wbEditor(ed)}
        ${list}
      </div>
    </div>`;
  };

  /** 生词本单行。虚拟滚动逐行调用，必须是固定高度。 */
  Lx.wordbookRow = (r) => {
    const d = dueText(r.due);
    const note = (r.note || '').trim();
    return `<div class="wb-item" data-act="goto" data-word="${esc(r.word)}">
      <div class="wb-main">
        <div class="row row-gap-3">
          <span class="wb-word">${esc(r.word)}</span>
          ${r.phonetic ? `<span class="phonetic-text" style="font-size:var(--fs-2xs)">/${esc(r.phonetic)}/</span>` : ''}
          ${r.myDef ? '<span class="custom-flag">我的释义</span>' : ''}
          ${r.inDict ? '' : '<span class="custom-flag is-quiet">词库无</span>'}
          <span class="badge-set">${badges(r.tags, false)}</span>
        </div>
        ${
          /* 一行的位置，释义和笔记都要塞进来：笔记接在释义后面，
             用竖线隔开、颜色更淡，超出省略。全文在编辑框里看。 */
          r.brief || note
            ? `<div class="wb-tr">${esc(r.brief || '')}${
              note ? `<span class="wb-note-inline">${r.brief ? '｜' : ''}${esc(note)}</span>` : ''
            }</div>`
            : ''
        }
      </div>
      <div class="wb-right">
        ${stars(r.collins)}
        <span class="wb-due ${d.due ? 'is-due' : ''}">${d.text}</span>
        <button class="icon-btn" data-act="wb-edit" data-word="${esc(r.word)}"
                title="写我的释义与笔记">${icon('quote')}</button>
        <button class="icon-btn" data-act="wb-remove" data-word="${esc(r.word)}"
                title="移出生词本">${icon('trash')}</button>
      </div>
    </div>`;
  };

  /* ==================================================================== */
  /*  学习热力图                                                          */
  /* ==================================================================== */

  /**
   * 把每日活动量画成一年的热力图。一列七格代表一周，从左到右按周推进。
   * 活动量 = 复习次数 + 练习答题数。
   */
  Lx.renderHeatmap = (days) => {
    const byDay = new Map();
    for (const d of days || []) byDay.set(d.day, d);

    const DAY_MS = 86_400_000;
    const todayIdx = Math.floor(Date.now() / DAY_MS);
    // 从 52 周前的周日开始，让每列正好对齐星期
    const start = todayIdx - 364;
    const startDow = new Date(start * DAY_MS).getUTCDay();
    const first = start - startDow;

    let total = 0;
    let active = 0;
    let streak = 0;
    let streakRunning = true;

    const cells = [];
    for (let i = first; i <= todayIdx; i++) {
      const e = byDay.get(i);
      const n = e ? (e.reviews || 0) + (e.quiz || 0) : 0;
      if (i >= start) {
        total += n;
        if (n > 0) active++;
      }
      const lvl = n === 0 ? 0 : n < 5 ? 1 : n < 15 ? 2 : n < 40 ? 3 : 4;
      const date = new Date(i * DAY_MS).toISOString().slice(0, 10);
      cells.push(
        `<div class="heat-cell${lvl ? ` l${lvl}` : ''}" title="${date}　${n ? `${n} 次` : '没有学习'}"></div>`,
      );
    }

    // 连续天数从今天往前数
    for (let i = todayIdx; i >= first; i--) {
      const e = byDay.get(i);
      const n = e ? (e.reviews || 0) + (e.quiz || 0) : 0;
      if (n > 0) streak++;
      else if (i === todayIdx) continue; // 今天还没学不算断
      else break;
      if (!streakRunning) break;
    }

    return `<div class="heat-wrap">
      <div class="heat-head">
        <span class="heat-title">最近一年</span>
        ${streak > 0 ? `<span class="heat-streak">${icon('flame')} 连续 ${streak} 天</span>` : ''}
        <span class="spacer"></span>
        <span class="set-desc">${active} 天有学习记录 · 共 ${total.toLocaleString()} 次</span>
      </div>
      <div class="heat-grid">${cells.join('')}</div>
      <div class="heat-legend">
        <span>少</span>
        <span class="heat-cell"></span>
        <span class="heat-cell l1"></span>
        <span class="heat-cell l2"></span>
        <span class="heat-cell l3"></span>
        <span class="heat-cell l4"></span>
        <span>多</span>
      </div>
    </div>`;
  };

  /* ==================================================================== */
  /*  每日目标                                                            */
  /* ==================================================================== */

  Lx.renderGoals = (g) => {
    if (!g) return '';
    const rows = [
      ['新收生词', g.added],
      ['复习卡片', g.reviews],
      ['练习题量', g.quiz],
    ].filter(([, v]) => v.target > 0);
    if (!rows.length) return '';

    return `<div class="goal-bar">${rows
      .map(([label, v]) => {
        const pct = Math.min(100, Math.round((v.done / v.target) * 100));
        return `<div class="goal-item">
          <div class="goal-top">
            <span class="goal-label">${label}</span>
            <span class="goal-val">${v.done} / ${v.target}</span>
          </div>
          <div class="goal-track">
            <div class="goal-fill ${pct >= 100 ? 'is-done' : ''}" style="width:${pct}%"></div>
          </div>
        </div>`;
      })
      .join('')}</div>`;
  };

  /* ==================================================================== */
  /*  练习正确率曲线                                                      */
  /* ==================================================================== */

  /**
   * 用练习流水按天算正确率，画成折线 + 面积。
   * 只画有答题记录的天，天数不足 3 天时不画（画不出趋势，还占地方）。
   */
  Lx.renderAccuracyCurve = (days, span = 90) => {
    const DAY_MS = 86_400_000;
    const today = Math.floor(Date.now() / DAY_MS);
    const pts = (days || [])
      .filter((d) => d.quiz > 0 && d.day > today - span)
      .sort((a, b) => a.day - b.day)
      .map((d) => ({ day: d.day, rate: d.hit / d.quiz, n: d.quiz }));

    if (pts.length < 3) return '';

    const W = 100;
    const H = 34;
    const first = pts[0].day;
    const lastDay = pts[pts.length - 1].day;
    const spanDays = Math.max(1, lastDay - first);
    const x = (d) => ((d - first) / spanDays) * W;
    const y = (r) => H - r * H;

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(2)} ${y(p.rate).toFixed(2)}`).join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;

    const avg = (n) => {
      const recent = pts.slice(-n);
      const tot = recent.reduce((s, p) => s + p.n, 0);
      const hit = recent.reduce((s, p) => s + p.rate * p.n, 0);
      return tot ? Math.round((hit / tot) * 100) : null;
    };
    const a7 = avg(7);
    const a30 = avg(30);

    return `<div class="heat-wrap">
      <div class="heat-head">
        <span class="heat-title">练习正确率</span>
        <span class="spacer"></span>
        <span class="set-desc">
          ${a7 != null ? `近 7 次练习日 ${a7}%` : ''}
          ${a30 != null ? ` · 近 30 次 ${a30}%` : ''}
        </span>
      </div>
      <div class="acc-chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
          ${[0.25, 0.5, 0.75].map((g) => `<line x1="0" y1="${y(g)}" x2="${W}" y2="${y(g)}" class="acc-grid"/>`).join('')}
          <path d="${area}" class="acc-area"/>
          <path d="${line}" class="acc-line"/>
        </svg>
        <div class="acc-axis"><span>100%</span><span>50%</span><span>0</span></div>
      </div>
      <div class="heat-legend">
        <span>${new Date(first * DAY_MS).toLocaleDateString('zh-CN')}</span>
        <span class="spacer"></span>
        <span>${pts.length} 个练习日</span>
        <span class="spacer"></span>
        <span>${new Date(lastDay * DAY_MS).toLocaleDateString('zh-CN')}</span>
      </div>
    </div>`;
  };

  /* ==================================================================== */
  /*  复习                                                                */
  /* ==================================================================== */

  /** 预测四档按钮各自会把间隔推到多久后 */
  function previewIntervals(card) {
    const { ease, ivl, reps } = card;
    const base = reps === 0 ? 1 : reps === 1 ? 6 : Math.max(1, Math.round(ivl * ease));
    const fmt = (d) => (d < 1 ? '10 分钟' : d < 30 ? `${d} 天` : `${Math.round(d / 30)} 个月`);
    return {
      again: '10 分钟',
      hard: fmt(Math.max(1, Math.round(base * 0.6))),
      good: fmt(base),
      easy: fmt(Math.round(base * 1.3)),
    };
  }

  Lx.renderReview = (queue, counts, state, heat) => {
    if (!queue.length) {
      return `<div class="page">
        <div>
        ${heat ? Lx.renderHeatmap(heat) : ''}
        <div class="blank" style="min-height:44vh">
          <div>
            <div class="blank-mark">✓</div>
            <div class="blank-title">${counts.total ? '今天的复习都做完了' : '还没有需要复习的词'}</div>
            <div class="blank-text">
              ${
                counts.total
                  ? `生词本里共 ${counts.total} 个词，下一批到期后会自动出现在这里。`
                  : '先去查几个词、点书签收进生词本，复习队列就会自动排好。'
              }
            </div>
            <div class="blank-tips">
              <button class="btn btn-outline" data-view="wordbook">${icon('layers')} 打开生词本</button>
              <button class="btn btn-outline" data-view="drill">${icon('target')} 按考纲练习</button>
              <button class="btn btn-outline" data-act="random">${icon('shuffle')} 随机学个新词</button>
            </div>
          </div>
        </div>
        </div>
      </div>`;
    }

    const { card, entry } = queue[state.index];
    const total = queue.length;
    const iv = previewIntervals(card);
    const revealed = state.revealed;

    const { myDef, note } = queue[state.index];
    /* 自己写的释义排在最前面。词库里没这个词时（自己加的词组），
       它是卡片上唯一的释义——所以「词库中没有」那句话只在两边都空时才出。 */
    const mineLines = [
      myDef ? `<div class="zh-line zh-mine">${esc(myDef)}</div>` : '',
      note ? `<div class="zh-line zh-note">${esc(note)}</div>` : '',
    ].join('');

    const dictLines = entry
      ? entry.translation
          .slice(0, 6)
          .map((t) => `<div class="zh-line">${t.pos ? `<span class="zh-sub">${esc(t.pos)}.</span>` : ''}${esc(t.text)}</div>`)
          .join('')
      : '';

    const zh = mineLines + dictLines
      || '<div class="faint">词库中没有这个词的释义，可以在生词本里自己写一条</div>';

    const ex = entry?.examples?.[0]
      ? `<div class="fc-ex"><div class="ex">
           <div class="ex-en">${Lx.highlight(entry.examples[0].en, entry.word, [])}</div>
           ${entry.examples[0].zh ? `<div class="ex-zh">${esc(entry.examples[0].zh)}</div>` : ''}
         </div></div>`
      : '';

    return `<div class="review-wrap">
      <div class="review-progress">
        <span class="review-count">${state.index + 1} / ${total}</span>
        <div class="review-bar"><div class="review-bar-fill" style="width:${((state.index) / total) * 100}%"></div></div>
        <span class="review-count">今日已复习 ${counts.reviewedToday}</span>
      </div>

      <div class="flashcard" data-word="${esc(card.word)}">
        <div>
          <div class="fc-word">${esc(card.word)}</div>
          ${entry?.phonetic ? `<div class="fc-ph">/${esc(entry.phonetic)}/</div>` : ''}
          <div class="row row-gap-2" style="justify-content:center;margin-top:var(--sp-4)">
            <button class="speak-btn" data-act="speak" data-accent="uk" data-text="${esc(card.word)}">${icon('volume')}</button>
            <span class="badge-set">${badges(entry?.tags?.map((t) => t.code) || [], entry?.oxford)}</span>
          </div>
        </div>

        ${revealed ? `<div class="fc-back"><div class="fc-tr">${zh}</div>${ex}</div>` : ''}
      </div>

      ${
        revealed
          ? `<div class="grade-row">
               <button class="grade-btn grade-again" data-act="grade" data-grade="again">
                 <strong>忘了</strong><span>${iv.again}</span></button>
               <button class="grade-btn grade-hard" data-act="grade" data-grade="hard">
                 <strong>有点难</strong><span>${iv.hard}</span></button>
               <button class="grade-btn grade-good" data-act="grade" data-grade="good">
                 <strong>记得</strong><span>${iv.good}</span></button>
               <button class="grade-btn grade-easy" data-act="grade" data-grade="easy">
                 <strong>很简单</strong><span>${iv.easy}</span></button>
             </div>
             <div class="row row-gap-3" style="justify-content:center;margin-top:var(--sp-5)">
               <span class="faint" style="font-size:var(--fs-2xs)">按 1 / 2 / 3 / 4 快速评分</span>
             </div>`
          : `<div class="grade-row">
               <button class="btn btn-accent" data-act="reveal" style="flex:1;height:46px">
                 显示释义　<span class="kbd" style="background:transparent;border-color:currentColor">空格</span>
               </button>
             </div>`
      }
    </div>`;
  };

  /* ==================================================================== */
  /*  设置                                                                */
  /* ==================================================================== */

  Lx.renderSettings = (s, stats, voices) => {
    const m = stats.meta || {};
    const n = (k) => Number(m[k] || 0).toLocaleString('zh-CN');

    const row = (name, desc, control) => `
      <div class="set-row">
        <div class="set-label">
          <div class="set-name">${name}</div>
          <div class="set-desc">${desc}</div>
        </div>
        ${control}
      </div>`;

    const sw = (key, on) => `<button class="switch ${on ? 'is-on' : ''}" data-act="toggle" data-key="${key}"></button>`;

    const voiceOpts = voices.length
      ? voices.map((v) => `<option value="${esc(v.name)}" ${s.ttsVoice === v.name ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}</option>`).join('')
      : '<option value="">未检测到英语语音</option>';

    /* 热键、托盘、开机启动、划词取词都是 Windows 独有的；安卓上取词走系统的
       「分享 / 处理文本」菜单，没有对应设置项，整组直接不渲染。 */
    const isAndroid = stats.platform === 'android';

    /* 在线翻译的状态。stats 里没有时给一份空的，免得每处都写 ?. */
    const mtOnline = stats.mtOnline || {
      provider: 'google', calls: 0, errors: 0, cacheHits: 0, avgMs: 0, coolingDown: false, lastError: null,
    };

    return `<div class="page">
      <div class="settings">
        <div class="wb-head"><div class="wb-title">设置</div></div>

        <div class="set-group">
          <div class="label-rule"><span class="label">外观</span></div>
          <div class="theme-picker">
            <button class="theme-card ${s.theme === 'paper' ? 'is-on' : ''}" data-act="theme" data-theme="paper">
              <div class="theme-swatch theme-swatch-paper"></div>
              <div class="theme-name">纸质浅色</div>
            </button>
            <button class="theme-card ${s.theme === 'glass' ? 'is-on' : ''}" data-act="theme" data-theme="glass">
              <div class="theme-swatch theme-swatch-glass"></div>
              <div class="theme-name">玻璃深色</div>
            </button>
          </div>
        </div>

        <div class="set-group">
          <div class="label-rule"><span class="label">${isAndroid ? '取词与翻译' : '悬浮查词'}</span></div>
          ${isAndroid ? row('从其它应用取词',
            `在任意应用里选中英文，点系统菜单的「Lexica」或「分享」即可直接查。<br>
             <span class="faint">首次使用可能要在选择菜单里点「更多」把 Lexica 调到前面。</span>`,
            '<span class="set-desc">系统菜单</span>') : ''}
          ${isAndroid ? '' : row('全局热键', '在任何程序里按下热键都能唤起悬浮查词窗；若剪贴板里是英文单词会自动填入。',
            `<div class="row row-gap-2">
               <button class="btn btn-outline" data-act="record-hotkey" id="hotkeyBtn">${esc(s.hotkey || '未设置')}</button>
               ${sw('hotkeyEnabled', s.hotkeyEnabled)}
             </div>`)}
          ${isAndroid ? '' : row('剪贴板取词',
            '开启后，只要复制了英文单词或短语（Ctrl+C），悬浮查词窗会自动弹出。' +
            '真正的鼠标悬停划词需要系统无障碍接口，本机编不了原生模块，所以用复制触发。' +
            '主窗口在前台时不打扰。',
            sw('clipboardLookup', s.clipboardLookup))}
          ${isAndroid ? '' : row('划词取词', `选中其它程序里的文字后直接查。优先用 Windows UI Automation 读取选区（不碰剪贴板）；
            读不到时可选择用模拟 Ctrl+C 兜底。<br>
            <span class="faint">浏览器、Office、WPF 程序支持较好；部分老式程序只能靠兜底。</span>`,
            `<div class="seg">${[['off', '关闭'], ['hotkey', '按热键'], ['auto', '划完自动弹']]
              .map(([v, t]) => `<button class="seg-btn ${(s.selectionMode || 'off') === v ? 'is-on' : ''}"
                     data-act="sel-mode" data-v="${v}">${t}</button>`)
              .join('')}</div>`)}
          ${
            !isAndroid && (s.selectionMode || 'off') !== 'off'
              ? row('划词热键', '按下后抓取当前选中的文字。「划完自动弹」模式下不需要热键。',
                  `<button class="btn btn-outline" data-act="record-sel-hotkey" id="selHotkeyBtn"
                     ${s.selectionMode === 'auto' ? 'disabled' : ''}>${esc(s.selectionHotkey || '未设置')}</button>`) +
                row('允许模拟 Ctrl+C 兜底',
                  'UI Automation 读不到选区时改用复制。取词前会备份剪贴板、取完立刻还原。',
                  sw('selectionCopyFallback', s.selectionCopyFallback !== false))
              : ''
          }
          ${row('自动机器翻译', stats.mtAvailable
            ? `词典给不出整体释义时（多为学术词组），自动补一条本地模型翻译。<br>
               <span class="faint">结果排在逐词拆解之后并标注为机器翻译——模型在专业术语上常有偏差。</span>`
            : isAndroid
              ? `安卓版没有内置翻译模型。<br>
                 <span class="faint">查不到的词组仍会给出逐词拆解，这部分是词典数据，比机器翻译可靠。</span>`
              : '未安装翻译模型。在项目目录运行 <span class="mono">npm run fetch:model</span> 后可用（约 117MB）。',
            stats.mtAvailable
              ? sw('mtAuto', s.mtAuto !== false)
              : '<span class="set-desc">未内置</span>')}
          ${
            /* 在线翻译。安卓版没有这条路（也没有本地模型），整项不渲染。
               措辞必须把两件事都说清楚：会外发什么，以及它治不了延迟。 */
            isAndroid ? '' : row('在线翻译', `本地模型在数字和术语上会<strong>改错内容</strong>
              （实测 <span class="mono">63.8 → 638</span>、<span class="mono">scalar reward → 一笔奖金</span>），
              在线服务这几处都是对的。<br>
              <span class="faint">开启后，要翻译的英文会发送到
              ${esc((mtOnline.provider === 'google' ? 'Google' : mtOnline.provider))}
              ——上课时那就是老师讲的内容。断网或超时会自动退回本地模型，字幕不会中断。</span><br>
              <span class="faint">注意：这<strong>不会</strong>让字幕变快。实测延迟里翻译只占约 300ms，
              大头是等说话人停顿，那要靠「滚动字幕」解决。</span>`,
              sw('mtOnline', !!s.mtOnline))
          }
          ${
            /* 开着的时候把实时状态摆出来：退回本地是静默的，
               不给个地方看统计，用户没法知道自己到底用的是哪条通道。 */
            !isAndroid && s.mtOnline && mtOnline.calls + mtOnline.errors > 0
              ? row('在线翻译状态',
                `已用 ${mtOnline.calls} 次 · 平均 ${mtOnline.avgMs}ms · 缓存命中 ${mtOnline.cacheHits} 次`
                + (mtOnline.errors
                  ? ` · <strong>失败 ${mtOnline.errors} 次</strong>（最近：${esc(mtOnline.lastError || '')}）`
                  : ' · 无失败')
                + (mtOnline.coolingDown ? '<br><span class="faint">连续失败已暂停一分钟，期间走本地模型。</span>' : ''),
                '')
              : ''
          }
          ${isAndroid ? '' : row('关闭主窗口时最小化到托盘', '关掉窗口后程序继续驻留托盘，热键依然可用。', sw('minimizeToTray', s.minimizeToTray))}
          ${isAndroid ? '' : row('开机自动启动', '以隐藏方式随系统启动，只留托盘图标。', sw('autoLaunch', s.autoLaunch))}
        </div>

        <div class="set-group">
          <div class="label-rule"><span class="label">实时字幕</span></div>
          ${
            stats.asr?.available
              ? row('识别模型', `听写用的模型。本机实测：快速 ≈ 5 倍实时，推荐 ≈ 3.6 倍，
                  高精度只有 0.6 倍（跟不上实时，只适合课后转写导入的录音）。`,
                  `<div class="seg">${(stats.asr.models || []).map((m) => `
                    <button class="seg-btn ${(s.asrModel || 'base') === m.key ? 'is-on' : ''}"
                            data-act="asr-model" data-v="${m.key}">${esc(m.label)}</button>`).join('')}</div>`)
              : row('识别模型', `还没有安装。在项目目录运行
                  <span class="mono">npm run fetch:asr</span>（约 90MB）后可用。`,
                  '<span class="set-desc">未安装</span>')
          }
          ${
            (stats.mtModels || []).length > 1
              ? row('翻译模型', `两个都装了，可以随时切。opus 快但会把数字改错
                  （实测 63.8 → 638）；NLLB 慢三四倍，数字准、术语明显更好。<br>
                  <span class="faint">这一项管查词与翻译页。实时字幕另有一项设置，
                  在下面——那里别用 NLLB，它会和识别引擎抢 CPU。</span>`,
                  `<div class="seg">${stats.mtModels.map((m) => `
                    <button class="seg-btn ${(s.mtModel || 'opus') === m.key ? 'is-on' : ''}"
                            data-act="mt-model" data-v="${m.key}" title="${esc(m.note)}">
                      ${esc(m.label)}</button>`).join('')}</div>`)
              : ''
          }
          ${stats.asr?.available ? row('领域提示词', `告诉识别引擎这节课在讲什么，它会更倾向于输出这些写法。<br>
            <span class="faint">这是单项收益最大的一项——实测词错误率从 4.7% 降到 1.6%，
            能把「twinning」这种同音错词拉回「training」。课程名会自动拼在前面，
            这里只写术语，逗号分隔。</span>`,
            `<textarea class="set-prompt" data-act="asr-prompt" rows="3"
               placeholder="algorithm, hypothesis, gradient descent, …">${esc(s.asrPrompt || '')}</textarea>`) : ''}
          ${
            (stats.mtModels || []).length > 1
              ? row('字幕翻译模型', `实时字幕单独用一个更快的。实测 NLLB 和识别引擎会抢 CPU，
                  两边一起变慢（一节课只识别出四分之一），所以这里默认用快的。<br>
                  <span class="faint">转写文件里留着英文原文，课后想要更准的译文可以在翻译页重译。</span>`,
                  `<div class="seg">${stats.mtModels.map((m) => `
                    <button class="seg-btn ${(s.lectureMtModel || 'opus') === m.key ? 'is-on' : ''}"
                            data-act="lec-mt-model" data-v="${m.key}">${esc(m.label)}</button>`).join('')}</div>`)
              : ''
          }
          ${stats.asr?.available ? row('滚动字幕', `边说边出<strong>临时字幕</strong>，说完再换成定稿。<br>
            <span class="faint">实测延迟里翻译只占约 300ms，大头是等说话人把话说完（约 5 秒）——
            这一项才是治延迟的。临时稿用小模型跑、会有错字，几秒后被定稿替换；
            它<strong>不写进文件</strong>，转写稿里只有定稿。</span>`,
            sw('lectureRolling', s.lectureRolling !== false)) : ''}
          ${row('记录格式', `每节课要生成哪几种文件。无论选了哪些，都会额外写一份
            <span class="mono">journal.jsonl</span> 流水账——中途崩了可以从它恢复。`,
            `<div class="seg seg-wrap">${[['md', 'Markdown'], ['txt', '纯文本'], ['srt', '字幕 SRT'], ['json', 'JSON']]
              .map(([k, label]) => `<button class="seg-btn ${(s.lectureFormats || []).includes(k) ? 'is-on' : ''}"
                     data-act="lec-format" data-v="${k}">${label}</button>`).join('')}</div>`)}
          ${stats.asr?.available ? row('视频字幕悬浮窗', `抓系统声音，在置顶悬浮窗上显示双语字幕，看电影/看视频用。<br>
            <span class="faint">热键随时开关——字幕锁定成鼠标穿透后窗口自己点不到，只能靠热键关。</span>`,
            `<div class="row row-gap-2">
               <button class="btn btn-outline" data-act="record-sub-hotkey" id="subHotkeyBtn">${esc(s.subtitleHotkey || '未设置')}</button>
               <button class="btn btn-outline" data-act="sub-open">打开</button>
             </div>`) : ''}
          ${stats.asr?.available ? row('字幕显示条数', '同时显示几条。看电影两条够用（当前 + 上一条），讲座可以多留几条。',
            `<div class="seg">${[1, 2, 3, 4].map((n) => `
              <button class="seg-btn ${Number(s.subtitleLines || 2) === n ? 'is-on' : ''}"
                      data-act="sub-lines" data-v="${n}">${n}</button>`).join('')}</div>`) : ''}
          ${row('停顿判定', `多长的静音算一句话说完。教室回声大、教授语速慢时调大一点；
            调太小会把一句话切成两半。`,
            `<div class="seg">${[[300, '灵敏'], [420, '标准'], [600, '宽松'], [800, '很宽松']]
              .map(([v, t]) => `<button class="seg-btn ${Number(s.lectureSilenceMs || 420) === v ? 'is-on' : ''}"
                     data-act="lec-silence" data-v="${v}">${t}</button>`).join('')}</div>`)}
        </div>

        <div class="set-group">
          <div class="label-rule"><span class="label">阅读</span></div>
          ${row('正文字号', '影响释义、例句等正文内容，界面骨架不变。',
            `<div class="seg">${[[0.9, '小'], [1, '标准'], [1.1, '大'], [1.2, '特大']]
              .map(([v, t]) => `<button class="seg-btn ${Number(s.fontScale) === v ? 'is-on' : ''}"
                     data-act="font-scale" data-v="${v}">${t}</button>`)
              .join('')}</div>`)}
        </div>

        <div class="set-group">
          <div class="label-rule"><span class="label">每日目标</span></div>
          <div class="set-desc" style="margin-bottom:var(--sp-4)">
            设为 0 表示不设目标。完成情况显示在练习页顶部。
          </div>
          ${[['dailyNew', '新收生词', '每天往生词本里加几个词'],
             ['dailyReviews', '复习卡片', '每天完成多少张复习卡'],
             ['dailyQuiz', '练习题量', '每天做多少道自测题']]
            .map(([key, name, desc]) => row(name, desc,
              `<div class="row row-gap-2">
                 <button class="icon-btn" data-act="goal-step" data-key="${key}" data-d="-5">−</button>
                 <span class="goal-num">${Number(s[key]) || 0}</span>
                 <button class="icon-btn" data-act="goal-step" data-key="${key}" data-d="5">+</button>
               </div>`))
            .join('')}
        </div>

        <div class="set-group">
          <div class="label-rule"><span class="label">发音</span></div>
          ${isAndroid
            ? row('语音引擎', `用系统自带的 TTS 朗读，完全离线。<br>
                <span class="faint">听不到声音的话，多半是系统里没装英语语音数据——
                在「系统设置 → 语言和输入法 → 文字转语音」里下载一次即可。</span>`,
                '<button class="btn btn-outline" data-act="tts-test">试听</button>')
            : row('语音', '使用 Windows 内置语音，完全离线。',
                `<select class="btn btn-outline" data-act="voice" style="min-width:200px">${voiceOpts}</select>`)}
          ${row('语速', `当前 ${Number(s.ttsRate).toFixed(2)} 倍`,
            `<input type="range" min="0.5" max="1.5" step="0.05" value="${s.ttsRate}" data-act="rate" style="width:160px">`)}
        </div>

        <div class="set-group">
          <div class="label-rule"><span class="label">词库</span></div>
          <div class="db-status">
            <span class="db-dot ${stats.ready ? 'ok' : 'bad'}"></span>
            <div style="flex:1">
              ${
                stats.ready
                  ? `词库已加载 · 构建于 ${esc((m.built_at || '').slice(0, 10))}`
                  : `词库未就绪：${esc(stats.error || '未找到 dict.db')}`
              }
              <div class="set-desc" style="margin-top:4px">${esc(stats.file || '')}</div>
            </div>
            <button class="btn btn-outline" data-act="open-data">${icon('folder')} ${isAndroid ? '存放位置' : '打开目录'}</button>
          </div>

          ${
            stats.ready
              ? `<div class="card" style="margin-top:var(--sp-4)">
                   <div class="card-title">收录统计</div>
                   <div class="src-list">
                     <div class="src-row"><span class="src-name">词条总数</span><span class="src-desc">${n('words')}（其中单词 ${n('words_single')}）</span></div>
                     <div class="src-row"><span class="src-name">词形映射</span><span class="src-desc">${n('forms')} 组</span></div>
                     <div class="src-row"><span class="src-name">WordNet 义项</span><span class="src-desc">${n('senses')} 条</span></div>
                     <div class="src-row"><span class="src-name">例句</span><span class="src-desc">${n('sentences')} 条，其中中英对照 ${n('sentences_bilingual')} 条</span></div>
                     <div class="src-row"><span class="src-name">例句词性归属</span><span class="src-desc">${n('sentences_pos')} 条，其中定到具体义项 ${n('sentences_bound')} 条</span></div>
                     <div class="src-row"><span class="src-name">词源</span><span class="src-desc">${n('etym')} 条（GCIDE 韦氏 1913）</span></div>
                     <div class="src-row"><span class="src-name">古典引文</span><span class="src-desc">${n('quotes')} 条</span></div>
                     <div class="src-row"><span class="src-name">柯林斯星级词</span><span class="src-desc">${n('with_collins')}</span></div>
                     <div class="src-row"><span class="src-name">牛津 3000</span><span class="src-desc">${n('oxford')}</span></div>
                     <div class="src-row"><span class="src-name">四级 / 六级</span><span class="src-desc">${n('cet4')} / ${n('cet6')}</span></div>
                     <div class="src-row"><span class="src-name">考研</span><span class="src-desc">${n('ky')}</span></div>
                     <div class="src-row"><span class="src-name">托福 / 雅思 / GRE</span><span class="src-desc">${n('toefl')} / ${n('ielts')} / ${n('gre')}</span></div>
                   </div>
                 </div>`
              : `<div class="set-desc" style="margin-top:var(--sp-3)">
                   在项目目录执行 <code class="mono">npm run data</code> 下载并构建词库，然后重启应用。
                 </div>`
          }
        </div>

        <div class="set-group">
          <div class="label-rule"><span class="label">数据</span></div>
          ${row('导出生词本', '导出为 CSV（Excel 可直接打开）或 Anki 可导入的 TSV。',
            `<div class="row row-gap-2">
               <button class="btn btn-outline" data-act="export-csv">CSV</button>
               <button class="btn btn-outline" data-act="export-anki">Anki</button>
             </div>`)}
          ${row('清空查询历史', '只清历史记录，不影响生词本。',
            `<button class="btn btn-outline" data-act="clear-history">${icon('trash')} 清空</button>`)}
          ${row('备份学习数据', '把生词本、练习进度、自定义词表与设置整体导出为一个文件，换机器可直接恢复。',
            `<div class="row row-gap-2">
               <button class="btn btn-outline" data-act="backup-export">${icon('download')} 备份</button>
               <button class="btn btn-outline" data-act="backup-import">${icon('corner')} 恢复</button>
             </div>`)}
          ${row('自定义词条', `词库里没有的新词可以自己补。当前 ${stats.customCount || 0} 条。`,
            `<button class="btn btn-outline" data-act="custom-open">${icon('wand')} 管理</button>`)}
          ${row('运行日志', '出问题时把这个文件发出来最有用。',
            `<button class="btn btn-outline" data-act="open-log">${icon('folder')} 打开</button>`)}
        </div>

        <div class="set-group">
          <div class="label-rule"><span class="label">关于</span></div>
          <div class="src-list">
            <div class="src-row"><span class="src-name">Lexica</span><span class="src-desc">v${esc(stats.appVersion || '0.1.0')} · 完全离线运行</span></div>
            <div class="src-row"><span class="src-name">ECDICT</span><span class="src-desc">MIT · 释义、词频、考纲标签、词形变化</span></div>
            <div class="src-row"><span class="src-name">WordNet 3.1</span><span class="src-desc">Princeton WordNet License · 义项与词汇网络</span></div>
            <div class="src-row"><span class="src-name">Tatoeba</span><span class="src-desc">CC BY 2.0 FR · 例句与中英对照</span></div>
            <div class="src-row"><span class="src-name">Inter / Source Serif 4</span><span class="src-desc">SIL Open Font License</span></div>
          </div>
        </div>
      </div>
    </div>`;
  };

  /* ==================================================================== */
  /*  查词空态（首页）                                                     */
  /* ==================================================================== */

  Lx.renderHome = (recent, counts, meta) => {
    const chips = recent.length
      ? `<div class="blank-tips">${recent
          .slice(0, 8)
          .map((r) => `<button class="chip" data-act="goto" data-word="${esc(r.word)}">${esc(r.word)}</button>`)
          .join('')}</div>`
      : `<div class="blank-tips">
           ${['serendipity', 'ephemeral', 'run', 'meticulous', 'paradigm']
             .map((w) => `<button class="chip" data-act="goto" data-word="${w}">${w}</button>`)
             .join('')}
         </div>`;

    const words = Number(meta.words || 0).toLocaleString('zh-CN');

    return `<div class="page">
      <div class="blank">
        <div>
          <div class="blank-mark">Aa</div>
          <div class="blank-title">${meta.words ? `${words} 条词条，随时待查` : 'Lexica'}</div>
          <div class="blank-text">
            直接输入英文单词，或者输入中文反查。<br>
            拼错了也没关系，会给出拼写建议；输入 <span class="mono">running</span> 会自动跳到 <span class="mono">run</span>。
          </div>
          <div class="label" style="margin-top:var(--sp-8);margin-bottom:var(--sp-3)">
            ${recent.length ? '最近查过' : '试试这几个'}
          </div>
          ${chips}
        </div>
      </div>
    </div>`;
  };
})(window.Lx);
