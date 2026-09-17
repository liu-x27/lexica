'use strict';
/**
 * 考纲练习视图：选范围 → 选模式 → 学习 / 自测 / 水平检测 → 结果。
 *
 * 渲染纯字符串输出，交互统一走 app.js 的事件委托（data-act="drill-*"）。
 * 状态机放在 Lx.drill.state 上，由 app.js 驱动。
 */
(function (Lx) {
  const { esc, icon, badges, stars } = Lx;

  const KIND_HINT = {
    en2zh: '看单词，选中文释义',
    zh2en: '看中文，选单词',
    cloze: '例句挖空，选出该填的词',
    syn: '选出与该词意思最接近的词',
    audio: '听发音，选出对应的单词',
  };

  const state = {
    stage: 'scopes',
    scopes: [],
    scope: null,
    scopeLabel: '',
    progress: null,
    kinds: ['en2zh', 'zh2en', 'cloze', 'syn', 'audio'],

    heat: null,
    study: { list: [], i: 0, revealed: false },
    quiz: { mode: 'quiz', questions: [], i: 0, picked: null, locked: false, answers: [], bands: [] },
    result: null,
    loading: false,
  };

  Lx.drill = { state };

  /* ==================================================================== */
  /*  范围选择                                                            */
  /* ==================================================================== */

  /** 掌握度环形进度条 */
  function ring(pct, size = 44) {
    const r = (size - 6) / 2;
    const c = 2 * Math.PI * r;
    const off = c * (1 - Math.max(0, Math.min(1, pct)));
    return `<svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
              stroke="var(--meter-track)" stroke-width="4"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
              stroke="var(--accent)" stroke-width="4" stroke-linecap="round"
              stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
              transform="rotate(-90 ${size / 2} ${size / 2})"/>
    </svg>`;
  }

  function scopeCard(s) {
    const p = s.progress || {};
    const pct = s.quizzable ? (p.mastered || 0) / s.quizzable : 0;
    const acc = p.accuracy == null ? null : Math.round(p.accuracy * 100);
    return `<button class="scope-card" data-act="drill-scope" data-scope="${esc(s.scope)}">
      <div class="scope-ring">
        ${ring(pct)}
        <span class="scope-ring-num">${Math.round(pct * 100)}<i>%</i></span>
      </div>
      <div class="scope-body">
        <div class="scope-name">${esc(s.label)}</div>
        <div class="scope-meta">
          <span>${s.quizzable.toLocaleString()} 词</span>
          ${p.mastered ? `<span class="dot-sep">已掌握 ${p.mastered}</span>` : ''}
          ${p.shaky ? `<span class="dot-sep is-warn">待巩固 ${p.shaky}</span>` : ''}
          ${acc != null ? `<span class="dot-sep">正确率 ${acc}%</span>` : ''}
        </div>
        ${
          p.lastAssessment
            ? `<div class="scope-assess">上次检测掌握率 ${Math.round(p.lastAssessment.rate * 100)}%
                 · ${new Date(p.lastAssessment.at).toLocaleDateString('zh-CN')}</div>`
            : ''
        }
      </div>
      ${icon('right', 'scope-arrow')}
    </button>`;
  }

  function renderScopes() {
    const exam = state.scopes.filter((s) => ['zk', 'gk', 'cet4', 'cet6', 'ky', 'ielts', 'toefl', 'gre'].includes(s.scope));
    const other = state.scopes.filter((s) => !exam.includes(s));
    return `<div class="page">
      <div>
        <div class="wb-head">
          <div>
            <div class="wb-title">按考纲练习</div>
            <div class="set-desc" style="margin-top:6px">
              选一个范围，可以逐词学习、随机自测，或做一次分层抽样的水平检测。题目全部现算，不联网。
            </div>
          </div>
        </div>

        ${state.goals ? Lx.renderGoals(state.goals) : ''}
        ${/* 热力图放这里而不是复习页：复习页的卡片区只有 620px 宽，装不下一年 52 列 */ ''}
        ${state.heat ? Lx.renderHeatmap(state.heat) : ''}
        ${state.heat ? Lx.renderAccuracyCurve(state.heat) : ''}

        <div class="label-rule">
          <span class="label">考试大纲</span>
          <button class="btn btn-outline" data-act="drill-export" style="margin-left:auto">
            ${icon('download')} 导出全部进度
          </button>
        </div>
        <div class="scope-grid">${exam.map(scopeCard).join('')}</div>

        <div class="label-rule" style="margin-top:var(--sp-8)"><span class="label">常用词表</span></div>
        <div class="scope-grid">${other.map(scopeCard).join('')}</div>
      </div>
    </div>`;
  }

  /* ==================================================================== */
  /*  模式选择                                                            */
  /* ==================================================================== */

  function renderMenu() {
    const p = state.progress || {};
    const s = state.scopes.find((x) => x.scope === state.scope) || {};
    const total = s.quizzable || 0;

    const stat = (num, label, warn) =>
      `<div><div class="wb-stat-num${warn ? ' is-warn' : ''}">${num}</div>
        <div class="wb-stat-label">${label}</div></div>`;

    const kindChip = (k) =>
      `<button class="filter-btn ${state.kinds.includes(k) ? 'is-on' : ''}"
               data-act="drill-kind" data-kind="${k}">${esc(Lx.drill.kindLabels?.[k] || k)}</button>`;

    return `<div class="page">
      <div>
        <div class="wb-head">
          <button class="icon-btn" data-act="drill-back" title="返回范围列表">${icon('left')}</button>
          <div class="wb-title">${esc(state.scopeLabel)}</div>
          <button class="btn btn-outline" data-act="drill-export" data-scope="${esc(state.scope)}"
                  title="导出本范围的进度与错题">${icon('download')} 导出</button>
          <div class="spacer"></div>
          <div class="wb-stats">
            ${stat(total.toLocaleString(), '可练词量')}
            ${stat(p.mastered || 0, '已掌握')}
            ${stat(p.shaky || 0, '待巩固', (p.shaky || 0) > 0)}
            ${stat(p.answered || 0, '累计答题')}
          </div>
        </div>

        <div class="mode-grid">
          <button class="mode-card" data-act="drill-start" data-mode="study">
            <div class="mode-icon">${icon('book')}</div>
            <div class="mode-name">学习浏览</div>
            <div class="mode-desc">一张张过词，标记认识 / 不认识。<br>标为不认识的会自动进生词本。</div>
            <div class="mode-tag">20 词一组</div>
          </button>

          <button class="mode-card" data-act="drill-start" data-mode="quiz" data-count="10">
            <div class="mode-icon">${icon('cards')}</div>
            <div class="mode-name">快速自测</div>
            <div class="mode-desc">四选一，答完立刻反馈。<br>题型可在下方筛选。</div>
            <div class="mode-tag">10 题 · 约 2 分钟</div>
          </button>

          <button class="mode-card" data-act="drill-start" data-mode="quiz" data-count="25">
            <div class="mode-icon">${icon('layers')}</div>
            <div class="mode-name">标准自测</div>
            <div class="mode-desc">题量更大，覆盖更广。</div>
            <div class="mode-tag">25 题 · 约 5 分钟</div>
          </button>

          <button class="mode-card" data-act="drill-start" data-mode="assess" data-count="30">
            <div class="mode-icon">${icon('wand')}</div>
            <div class="mode-name">水平检测</div>
            <div class="mode-desc">按词频分高/中/低三层等量抽样，<br>估算这个范围你掌握了多少。</div>
            <div class="mode-tag">30 题 · 出结果前不反馈</div>
          </button>

          <button class="mode-card ${(p.shaky || 0) === 0 ? 'is-disabled' : ''}"
                  data-act="drill-start" data-mode="weak" data-count="15">
            <div class="mode-icon">${icon('shuffle')}</div>
            <div class="mode-name">强化错题</div>
            <div class="mode-desc">${
              (p.shaky || 0) === 0
                ? '还没有错题记录，先做一轮自测。'
                : `重点重练错过的 ${p.shaky} 个词。`
            }</div>
            <div class="mode-tag">15 题</div>
          </button>
        </div>

        <div class="label-rule" style="margin-top:var(--sp-8)"><span class="label">自测题型</span></div>
        <div class="filter-row" style="border:0;padding-bottom:0">
          ${['en2zh', 'zh2en', 'cloze', 'syn', 'audio'].map(kindChip).join('')}
        </div>
        <div class="set-desc" style="margin-top:var(--sp-2)">
          ${state.kinds.map((k) => esc(KIND_HINT[k])).join(' · ')}
        </div>
      </div>
    </div>`;
  }

  /* ==================================================================== */
  /*  学习浏览                                                            */
  /* ==================================================================== */

  function renderStudy() {
    const { list, i, revealed } = state.study;
    if (!list.length) return loadingPage('正在抽词…');
    if (i >= list.length) return renderStudyDone();

    const e = list[i];
    const zh = e.translation
      .slice(0, 5)
      .map((t) => `<div class="zh-line">${t.pos ? `<span class="zh-sub">${esc(t.pos)}.</span>` : ''}${esc(t.text)}</div>`)
      .join('');
    const ex = (() => {
      const all = [...(e.examples || []), ...Object.values(e.examplesByPos || {}).flat()];
      const pick = all.find((x) => x.zh) || all[0];
      if (!pick) return '';
      return `<div class="fc-ex"><div class="ex">
        <div class="ex-en">${Lx.highlight(pick.en, e.word, e.forms.flatMap((f) => f.words))}</div>
        ${pick.zh ? `<div class="ex-zh">${esc(pick.zh)}</div>` : ''}
      </div></div>`;
    })();

    return `<div class="review-wrap">
      ${progressBar(i, list.length, `${state.scopeLabel} · 学习浏览`)}

      <div class="flashcard">
        <div>
          <div class="fc-word">${esc(e.word)}</div>
          ${e.phon ? `<div class="fc-ph">/${esc(e.phon.main)}/</div>` : ''}
          <div class="row row-gap-2" style="justify-content:center;margin-top:var(--sp-4)">
            <button class="speak-btn" data-act="speak" data-accent="uk" data-text="${esc(e.word)}">${icon('volume')}</button>
            <span class="badge-set">${badges(e.tags.map((t) => t.code), e.oxford)}</span>
            ${stars(e.collins)}
          </div>
        </div>
        ${revealed ? `<div class="fc-back"><div class="fc-tr">${zh}</div>${ex}</div>` : ''}
      </div>

      ${
        revealed
          ? `<div class="grade-row">
               <button class="grade-btn grade-again" data-act="drill-mark" data-known="0">
                 <strong>不认识</strong><span>加入生词本</span></button>
               <button class="grade-btn grade-good" data-act="drill-mark" data-known="1">
                 <strong>认识</strong><span>下一个</span></button>
             </div>
             <div class="drill-hint">按 1 / 2 快速标记　·　L 查看完整词条</div>`
          : `<div class="grade-row">
               <button class="btn btn-accent" data-act="drill-reveal" style="flex:1;height:46px">
                 显示释义　<span class="kbd" style="background:transparent;border-color:currentColor">空格</span>
               </button>
             </div>`
      }
    </div>`;
  }

  function renderStudyDone() {
    const known = state.study.list.filter((_, i) => state.study.marks?.[i] === 1).length;
    return `<div class="review-wrap">
      <div class="blank" style="min-height:auto">
        <div>
          <div class="blank-mark">✓</div>
          <div class="blank-title">这组 ${state.study.list.length} 个词过完了</div>
          <div class="blank-text">标记为认识 ${known} 个，不认识 ${state.study.list.length - known} 个。<br>
            不认识的已经进了生词本，会按记忆曲线排进复习队列。</div>
          <div class="blank-tips">
            <button class="btn btn-accent" data-act="drill-start" data-mode="study">再来一组</button>
            <button class="btn btn-outline" data-act="drill-start" data-mode="quiz" data-count="10">测一测</button>
            <button class="btn btn-outline" data-act="drill-menu">返回</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ==================================================================== */
  /*  自测 / 检测                                                         */
  /* ==================================================================== */

  const LETTERS = ['A', 'B', 'C', 'D'];

  const modeLabel = (m) => (m === 'assess' ? '水平检测' : m === 'weak' ? '强化错题' : '自测');

  function renderQuiz() {
    const q = state.quiz;
    if (!q.questions.length) return loadingPage('正在出题…');
    if (q.i >= q.questions.length) return renderResult();

    const cur = q.questions[q.i];
    const isAssess = q.mode === 'assess';
    const showFeedback = !isAssess && q.locked;

    const prompt = (() => {
      if (cur.kind === 'audio') {
        return `<div class="q-audio">
          <button class="q-audio-btn" data-act="speak" data-accent="us" data-text="${esc(cur.speak)}"
                  title="再听一次">${icon('volume')}</button>
          <div class="q-audio-hint">点击重听</div>
        </div>`;
      }
      if (cur.kind === 'cloze') {
        return `<div class="q-cloze">${esc(cur.prompt)}</div>
                ${cur.promptZh ? `<div class="q-cloze-zh">${esc(cur.promptZh)}</div>` : ''}`;
      }
      if (cur.kind === 'zh2en' || cur.kind === 'confuse') {
        return `<div class="q-zh">${esc(cur.prompt)}</div>
                ${cur.kind === 'confuse' ? '<div class="q-sub">下面几个词拼写相近，选出意思对应的那个</div>' : ''}`;
      }
      if (cur.kind === 'spell') {
        return `<div class="q-zh">${esc(cur.prompt)}</div>
                <div class="q-sub">根据中文写出这个单词</div>`;
      }
      if (cur.kind === 'spellAudio') {
        return `<div class="q-audio">
          <button class="q-audio-btn" data-act="speak" data-accent="us" data-text="${esc(cur.speak)}"
                  title="再听一次">${icon('volume')}</button>
          <div class="q-audio-hint">听发音，写出这个单词</div>
        </div>`;
      }
      // en2zh / syn
      return `<div class="q-word">${esc(cur.prompt)}
                ${cur.phonetic ? `<span class="q-word-ph">/${esc(cur.phonetic)}/</span>` : ''}
              </div>
              ${cur.kind === 'syn' ? '<div class="q-sub">选出与它意思最接近的词</div>' : ''}`;
    })();

    /* 输入型题目：给首字母与字母数作为脚手架，纯回忆对多数人过难 */
    if (cur.input) {
      const r = q.spellResult;
      const done = !!q.locked;
      const slots = Array.from({ length: cur.hint.length }, (_, i) =>
        `<span class="spell-slot${i === 0 ? ' is-given' : ''}">${i === 0 ? esc(cur.hint.first) : ''}</span>`,
      ).join('');

      return `<div class="review-wrap">
        ${progressBar(q.i, q.questions.length, `${state.scopeLabel} · ${modeLabel(q.mode)}`, q.answers.filter((a) => a.correct).length)}

        <div class="q-card">
          <div class="q-kind">${esc(cur.kindLabel)}${cur.band ? ` · ${esc(cur.band)}词` : ''}</div>
          <div class="q-prompt">${prompt}</div>

          <div class="spell-hint">${slots}</div>
          <input class="spell-input" id="spellInput" type="text" spellcheck="false"
                 autocomplete="off" autocapitalize="off" placeholder="输入单词后回车"
                 value="${esc(q.spellValue || '')}" ${done ? 'disabled' : ''}>
          ${
            done
              ? `<div class="spell-answer ${r?.correct ? 'is-right' : 'is-wrong'}">
                   ${
                     r?.correct
                       ? `拼写正确 · <strong>${esc(cur.solution)}</strong>`
                       : `正确拼写是 <strong>${esc(cur.solution)}</strong>${
                           r?.near ? '　（你只差一点）' : ''
                         }`
                   }
                   ${cur.promptZh ? `<div class="spell-zh">${esc(cur.promptZh)}</div>` : ''}
                 </div>`
              : ''
          }
        </div>

        ${
          done
            ? `<div class="q-feedback ${r?.correct ? 'is-right' : 'is-wrong'}">
                 <div class="q-fb-head">
                   ${r?.correct ? '答对了' : r?.near ? '差一个字母' : '答错了'}
                   <button class="chip" data-act="goto" data-word="${esc(cur.word)}">查看 ${esc(cur.word)}</button>
                 </div>
                 <button class="btn btn-accent" data-act="drill-next">
                   下一题　<span class="kbd" style="background:transparent;border-color:currentColor">空格</span>
                 </button>
               </div>`
            : `<div class="q-feedback">
                 <button class="btn btn-accent" data-act="drill-spell">提交
                   <span class="kbd" style="background:transparent;border-color:currentColor">回车</span>
                 </button>
               </div>`
        }
      </div>`;
    }

    const options = cur.options
      .map((o, i) => {
        let cls = 'q-opt';
        if (showFeedback) {
          if (i === cur.answer) cls += ' is-right';
          else if (i === q.picked) cls += ' is-wrong';
          else cls += ' is-dim';
        } else if (isAssess && q.picked === i) cls += ' is-picked';
        return `<button class="${cls}" data-act="drill-pick" data-i="${i}" ${q.locked ? 'disabled' : ''}>
          <span class="q-opt-key">${LETTERS[i]}</span>
          <span class="q-opt-text">${esc(o.text)}</span>
          ${showFeedback && i === cur.answer ? icon('check', 'q-opt-mark') : ''}
        </button>`;
      })
      .join('');

    const modeName = modeLabel(q.mode);

    return `<div class="review-wrap">
      ${progressBar(q.i, q.questions.length, `${state.scopeLabel} · ${modeName}`, q.answers.filter((a) => a.correct).length)}

      <div class="q-card">
        <div class="q-kind">${esc(cur.kindLabel)}${cur.band ? ` · ${esc(cur.band)}词` : ''}</div>
        <div class="q-prompt">${prompt}</div>
        <div class="q-opts">${options}</div>
      </div>

      ${
        showFeedback
          ? `<div class="q-feedback ${q.picked === cur.answer ? 'is-right' : 'is-wrong'}">
               <div class="q-fb-head">
                 ${q.picked === cur.answer ? '答对了' : `答错了 · 正确答案是 ${LETTERS[cur.answer]}`}
                 <button class="chip" data-act="goto" data-word="${esc(cur.word)}">查看 ${esc(cur.word)}</button>
               </div>
               ${
                 /* 辨析题答完把几个近形词的释义并排摊开，价值就在对比上 */
                 cur.reveal
                   ? `<div class="q-reveal">${cur.reveal
                       .map(
                         (r) => `<div class="q-reveal-row">
                                   <span class="q-reveal-word">${esc(r.word)}</span>
                                   <span class="q-reveal-zh">${esc(r.zh || '')}</span>
                                 </div>`,
                       )
                       .join('')}</div>`
                   : ''
               }
               <button class="btn btn-accent" data-act="drill-next">
                 下一题　<span class="kbd" style="background:transparent;border-color:currentColor">空格</span>
               </button>
             </div>`
          : isAssess
            ? `<div class="q-feedback">
                 <div class="q-fb-head faint">检测模式不即时反馈，答完统一给结果</div>
                 <button class="btn ${q.picked == null ? 'btn-outline' : 'btn-accent'}"
                         data-act="drill-next" ${q.picked == null ? 'disabled' : ''}>
                   ${q.i === q.questions.length - 1 ? '提交并查看结果' : '下一题'}
                 </button>
               </div>`
            : '<div class="drill-hint">按 1-4 或 A-D 作答</div>'
      }
    </div>`;
  }

  function progressBar(done, total, label, right) {
    return `<div class="review-progress">
      <button class="icon-btn" data-act="drill-menu" title="退出">${icon('left')}</button>
      <span class="review-count">${done + (done < total ? 1 : 0)} / ${total}</span>
      <div class="review-bar"><div class="review-bar-fill" style="width:${(done / total) * 100}%"></div></div>
      ${right != null ? `<span class="review-count">✓ ${right}</span>` : ''}
      <span class="review-count faint">${esc(label)}</span>
    </div>`;
  }

  /* ==================================================================== */
  /*  结果                                                                */
  /* ==================================================================== */

  function renderResult() {
    const r = state.result;
    if (!r) return loadingPage('正在统计…');

    const pct = Math.round(r.rate * 100);
    const wrong = r.answers.filter((a) => !a.correct);

    const bandRows = r.summary?.bands?.length
      ? `<div class="card" style="margin-top:var(--sp-6)">
           <div class="card-title">分层结果</div>
           ${r.summary.bands
             .map(
               (b) => `<div class="meter">
                 <div class="meter-top">
                   <span class="meter-label">${esc(b.name)}词</span>
                   <span class="meter-value">${b.right}/${b.asked}</span>
                 </div>
                 <div class="meter-track"><div class="meter-fill" style="width:${b.rate * 100}%"></div></div>
               </div>`,
             )
             .join('')}
           <div class="meter-note" style="margin-top:var(--sp-4)">
             按词频分层等量抽样。高频段明显好于低频段是正常的；
             如果低频段也很高，说明这个范围对你偏简单，可以换更难的范围。
           </div>
         </div>`
      : '';

    const estimate = r.mode === 'assess'
      ? `<div class="result-estimate">
           估计你掌握了 <strong>${esc(state.scopeLabel)}</strong> 里约
           <b>${pct}%</b> 的词汇
           <span class="result-margin">± ${Math.round(r.summary.margin * 100)}%</span>
           <div class="result-margin-note">
             基于 ${r.total} 题的分层抽样，括号内是 95% 置信区间半宽。
             题量越大区间越窄——想更准就多测几轮。
           </div>
         </div>`
      : '';

    const wrongList = wrong.length
      ? `<div class="label-rule" style="margin-top:var(--sp-8)"><span class="label">错题 ${wrong.length} 个</span></div>
         <div class="wrong-list">
           ${wrong
             .map(
               (a) => `<div class="wrong-item" data-act="goto" data-word="${esc(a.word)}">
                 <span class="wrong-word">${esc(a.word)}</span>
                 <span class="wrong-zh">${esc(a.zh || '')}</span>
                 <button class="speak-btn" data-act="speak" data-accent="us" data-text="${esc(a.word)}">${icon('volume')}</button>
               </div>`,
             )
             .join('')}
         </div>`
      : '';

    return `<div class="review-wrap">
      <div class="result-hero">
        <div class="result-ring">
          ${ring(r.rate, 120)}
          <div class="result-ring-num">${pct}<i>%</i></div>
        </div>
        <div class="result-score">答对 ${r.right} / ${r.total}</div>
        ${estimate}
      </div>

      ${bandRows}
      ${wrongList}

      <div class="grade-row" style="margin-top:var(--sp-8)">
        <button class="btn btn-accent" data-act="drill-start" data-mode="${r.mode === 'assess' ? 'assess' : 'quiz'}"
                data-count="${r.total}" style="flex:1;height:44px">再来一轮</button>
        ${
          wrong.length
            ? `<button class="btn btn-outline" data-act="drill-start" data-mode="weak" data-count="15"
                       style="flex:1;height:44px">强化错题</button>`
            : ''
        }
        <button class="btn btn-outline" data-act="drill-menu" style="flex:1;height:44px">返回</button>
      </div>
    </div>`;
  }

  function loadingPage(text) {
    return `<div class="review-wrap"><div class="blank" style="min-height:40vh"><div>
      <div class="blank-mark">…</div>
      <div class="blank-title">${esc(text)}</div>
    </div></div></div>`;
  }

  /* ==================================================================== */

  /**
   * 把答题结果换算成掌握率与分层结果。
   * 与主进程 Quiz.summarize 同一套算法，这里为了结果页能立刻出数字而在渲染层也算一遍。
   */
  Lx.summarizeDrill = (answers, bands) => {
    const byBand = new Map();
    for (const b of bands || []) byBand.set(b.name, { name: b.name, asked: 0, right: 0 });
    let right = 0;
    for (const a of answers) {
      const b = byBand.get(a.band);
      if (b) {
        b.asked++;
        if (a.correct) b.right++;
      }
      if (a.correct) right++;
    }
    const n = answers.length || 1;
    const p = right / n;
    return {
      total: answers.length,
      right,
      rate: p,
      // 95% 置信区间半宽（正态近似）；题量小的时候这个区间会很宽，如实显示
      margin: Math.min(0.5, 1.96 * Math.sqrt((p * (1 - p)) / n)),
      bands: [...byBand.values()].filter((b) => b.asked > 0).map((b) => ({ ...b, rate: b.right / b.asked })),
    };
  };

  Lx.renderDrill = () => {
    if (state.loading) return loadingPage('正在准备…');
    switch (state.stage) {
      case 'scopes': return renderScopes();
      case 'menu': return renderMenu();
      case 'study': return renderStudy();
      case 'quiz': return renderQuiz();
      case 'result': return renderResult();
      default: return renderScopes();
    }
  };
})(window.Lx);
