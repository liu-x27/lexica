'use strict';
/**
 * 截图自测：`LEXICA_SHOT=<输出目录>`（`npm run shot`）时，按脚本走一遍界面、
 * 逐张截图、沿路断言，然后退出。自测不过就以 1 退出。
 *
 * 原先整段写在 index.js 里，占了那个文件三分之一；它只需要主进程的几样东西，
 * 由 index.js 通过 `host` 交进来：
 *   mainWin / quickWin / subWin  三个窗口（getter——字幕悬浮窗是半路才建的）
 *   online, settings             在线翻译与设置对象（和主进程是同一个对象）
 *   broadcast, showQuickWindow, toggleSubtitleWindow
 *   setQuitting()                收尾时让 before-quit 那套逻辑放行
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

/**
 * 设了 LEXICA_SHOT=<输出目录> 就按脚本走一遍界面、逐张截图然后退出。
 * 用来在改完样式后快速核对两套主题的实际效果，正常启动完全不受影响。
 * 这种模式下 userData 指向临时目录，不会碰到真实的生词本。
 */
async function runShotSequence(dir, host) {
  const { online, settings, broadcast, showQuickWindow, toggleSubtitleWindow } = host;
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

  const shot = async (name, win = host.mainWin) => {
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
      if (win === host.mainWin && lastPng.get(win.id)?.equals(png)) {
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
    try { host.mainWin.setTitleBarOverlay({ ...THEME_CHROME[theme], height: 60 }); } catch { /* 忽略 */ }
    broadcast('set:theme', { theme });
    await wait(700);
  };

  const lookup = async (word) => {
    host.mainWin.webContents.send('nav:lookup', { word });
    await wait(900);
  };

  const view = async (v) => {
    host.mainWin.webContents.send('nav:view', { view: v });
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
    const r = await host.mainWin.webContents.executeJavaScript(`
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
    const found = await host.mainWin.webContents.executeJavaScript(`
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
      const ok = await host.mainWin.webContents.executeJavaScript(
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
    await host.mainWin.webContents.executeJavaScript(
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
    const ok = await host.mainWin.webContents.executeJavaScript(
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
  host.mainWin.webContents.send('nav:lookup', { word: 'recieve' });
  await wait(1000);
  await shot('09-misspelling-correction');

  await lookup('children');
  await shot('10-inflection-redirect');

  // 易混词区块
  await lookup('principal');
  await scrollTo('.confuse-list');
  await shot('25-confusables');

  // 中文反查
  host.mainWin.webContents.send('nav:lookup', { word: '光合作用' });
  await wait(900);
  await shot('11-chinese-lookup');

  // 悬浮查词窗（两套主题各来一张）
  showQuickWindow('serendipity');
  await wait(1400);
  await shot('12-quick-paper', host.quickWin);

  await setTheme('glass');
  await wait(500);
  await shot('13-quick-glass', host.quickWin);

  // 划词场景：悬浮窗里查一个词库没有的学术词组，看拆解 + 机器翻译
  await setTheme('paper');
  showQuickWindow('ablation study');
  await wait(4000); // 模型已在后台预热过，这里只等一次推理
  await shot('29-quick-phrase-fallback', host.quickWin);

  // 划到整句：悬浮窗里给术语对照 + 双语逐句译文
  await setTheme('paper');
  showQuickWindow('The mitochondria generate adenosine triphosphate through oxidative phosphorylation.');
  await wait(6000); // 逐句翻译，一句约 1 秒
  await shot('30-quick-sentence', host.quickWin);
  host.quickWin?.hide();

  // 页面下半部分：义项折叠按钮、词源、古典引文
  await setTheme('paper');
  host.quickWin?.hide();
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
  host.mainWin.webContents.send('nav:view', { view: 'drill' });
  await wait(900);
  await host.mainWin.webContents.executeJavaScript(`
    (async () => {
      const app = window.__lexicaShot;
      if (app) await app.startSpellQuiz();
    })()
  `).catch(() => {});
  await wait(1400);
  await shot('26-spell-question');

  await host.mainWin.webContents.executeJavaScript(`
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

  /* 自定义页的「去练习」：要切到练习页、进这个词表的练习菜单。
     它原先点了没反应——app.js 里有两个 case 'drill-scope'，只有前一个生效，
     那个只刷新了看不见的练习页。截图里看不出来，所以这里断言落点。
     走真实的建表表单，不直接调 listCreate：表单那条路会清掉练习页缓存的范围列表。 */
  await host.mainWin.webContents.executeJavaScript(`
    document.querySelector('#clName').value = '自测词表';
    document.querySelector('#clText').value = 'apple\\nbanana\\ncherry';
  `);
  await click('[data-act="cl-create"]', 900);
  await click('button[data-act="drill-scope"][data-scope^="list:"]', 1200);
  const landed = await host.mainWin.webContents.executeJavaScript(`({
    active: !!document.querySelector('#view-drill.is-active'),
    title: document.querySelector('#view-drill .wb-title')?.textContent || null,
  })`);
  if (!landed.active || landed.title !== '自测词表') {
    throw new Error(`[shot] 「去练习」没有进到这个词表的练习菜单：${JSON.stringify(landed)}`);
  }
  console.log('[shot] 自定义页「去练习」进到了词表的练习菜单');
  await shot('28b-custom-list-drill');

  /* 在线翻译默认关，而 shot 用的是每次全新的 profile，
     所以要验证在线那条链路只能靠这个开关。 */
  if (process.env.LEXICA_SHOT_ONLINE) {
    settings.mtOnline = online.setEnabled(true);
    console.log('[shot] 已临时开启在线翻译（LEXICA_SHOT_ONLINE）');
    const probe = await host.mainWin.webContents.executeJavaScript(
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
        via: probe?.via, online: (await host.mainWin.webContents.executeJavaScript(
          'window.lexica.mtStatus()').catch(() => null))?.online,
      });
    } else if (probe.text.includes('63.8') && !probe.text.includes('638')) {
      console.log('[shot] ✓ 在线通道生效，且保住了小数点');
    } else {
      console.error('[shot] ✗ 在线译文的数字不对', probe.text);
    }
    const st = await host.mainWin.webContents.executeJavaScript('window.lexica.mtStatus()')
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
    const feeding = host.mainWin.webContents.executeJavaScript(
      '(async () => { try { return await window.Lx.lectureSelfTest(); } '
      + 'catch (e) { return { error: e.message }; } })()',
    ).catch((e) => ({ error: e.message }));

    /* 临时稿只在「正在说」的那几秒里存在，喂完就被清掉了。
       所以必须**在喂的过程中**查 DOM——之前放在喂完之后查，
       永远是 hasPartial:false，等于这条根本没验到。 */
    let sawPartial = null;
    for (let i = 0; i < 24; i++) {
      await wait(500);
      const st = await host.mainWin.webContents.executeJavaScript(`
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
    const lingering = await host.mainWin.webContents.executeJavaScript(
      "!!document.querySelector('#lec-partial')",
    ).catch(() => false);
    if (lingering) console.error('[shot] ✗ 说完之后临时稿还挂在屏幕上');
    else console.log('[shot] ✓ 说完之后临时稿已撤掉');

    if (!fed?.error) {
      // 自测按 4 倍速喂 66 秒音频（约 17 秒），加上识别追平的时间
      await wait(14000);
      await shot('36-lecture-live');

      await wait(14000);

      const done = await host.mainWin.webContents.executeJavaScript(
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
      const exec = (js) => host.mainWin.webContents.executeJavaScript(js).catch((e) => ({ __err: e.message }));

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
        host.mainWin.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        host.mainWin.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
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
      host.mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
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
        host.mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
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
    const subFed = await host.mainWin.webContents.executeJavaScript(
      '(async () => { try { const p = await window.lexica.lecPickAudio();'
      + ' if (!p || !p.ok) return { error: p && p.reason };'
      + ' const pcm = await window.Lx.lectureDecodeForTest(p.data);'
      + ' return await window.lexica.lecSelfTestFeed({ pcm, speed: 6 }); }'
      + ' catch (e) { return { error: e.message }; } })()',
    ).catch((e) => ({ error: e.message }));
    console.log('[shot] 悬浮窗喂入', subFed);

    await wait(9000);
    await shot('39-subtitle-float', host.subWin);

    /* 断言字幕真的画出来了：透明置顶窗口的截图不一定靠得住
       （窗口没真正前置时 capturePage 会给旧帧），查 DOM 才准。 */
    const subState = await host.subWin.webContents.executeJavaScript(`
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
    host.subWin.setIgnoreMouseEvents(true, { forward: true });
    await wait(400);
    await shot('40-subtitle-locked', host.subWin);
    host.subWin.setIgnoreMouseEvents(false);

    await host.mainWin.webContents.executeJavaScript('window.lexica.subStop()').catch(() => {});
    await wait(800);
    toggleSubtitleWindow(false);
  }

  /* ---- 长句：查词框输入整句 + 独立翻译页 ---- */
  await setTheme('paper');
  await view('dict');
  host.mainWin.webContents.send('nav:lookup', {
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
  await host.mainWin.webContents.executeJavaScript(`
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
  const trState = await host.mainWin.webContents.executeJavaScript(`
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
    const imported = await host.mainWin.webContents.executeJavaScript(`
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

    const terms = await host.mainWin.webContents.executeJavaScript('window.lexica.glossAll()')
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
    await host.mainWin.webContents.executeJavaScript(
      "document.querySelector('[data-act=\"cu-tab\"][data-tab=\"gloss\"]')?.click()",
    ).catch(() => {});
    await wait(700);
    await shot('41-glossary');

    /* 界面这条也得查 DOM。透明/未前置窗口的 capturePage 会给旧帧——
       实测这张截图拍到的是上一个页面，看图完全判断不了面板有没有画出来。 */
    const glState = await host.mainWin.webContents.executeJavaScript(`
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
    const probe = await host.mainWin.webContents.executeJavaScript(`
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
    const ctrl = await host.mainWin.webContents.executeJavaScript(`
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
    await host.mainWin.webContents.executeJavaScript(
      "document.querySelector('[data-act=\"cu-tab\"][data-tab=\"gloss\"]')?.click()",
    ).catch(() => {});
    await wait(700);
    const packsState = await host.mainWin.webContents.executeJavaScript(`
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

    const before = (await host.mainWin.webContents.executeJavaScript('window.lexica.glossAll()')).length;
    await host.mainWin.webContents.executeJavaScript(
      "document.querySelector('[data-act=\"gl-pack\"][data-id=\"sys\"]')?.click()",
    ).catch(() => {});
    await wait(1500);
    const after = await host.mainWin.webContents.executeJavaScript(`
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
  const drillStage = () => host.mainWin.webContents.executeJavaScript(
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
  const wrongOpt = await host.mainWin.webContents.executeJavaScript(`
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
  const quizState = await host.mainWin.webContents.executeJavaScript(`
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

  const glassState = await host.mainWin.webContents.executeJavaScript(`
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
    const ok = await host.mainWin.webContents.executeJavaScript(`
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
  const assessState = await host.mainWin.webContents.executeJavaScript(`
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
    const added = await host.mainWin.webContents.executeJavaScript(`
      window.lexica.wbAdd({
        word: ${JSON.stringify(phrase)},
        myDef: '经验回放缓冲：存放历史转移的池子',
        note: 'RL 课第三周，别和 policy 混起来',
      })
    `).catch((e) => ({ error: e.message }));
    console.log('[shot] 手动添加词组', added);

    // 词库里真的没有这个词组，否则这条验证就没意义了
    const inDict = await host.mainWin.webContents.executeJavaScript(
      `(async () => (await window.lexica.wbGet(${JSON.stringify(phrase)})).inDict)()`,
    ).catch(() => null);
    if (inDict) console.error('[shot] ✗ 词库里居然有这个词组，换一个再测');

    await view('wordbook');
    await wait(900);

    /* 列表行要显示自己写的释义与笔记，并标出「词库无」。
       查 DOM 而不是看截图——虚拟列表 + 未前置窗口的截图都不可靠。 */
    const rowState = await host.mainWin.webContents.executeJavaScript(`
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
    const edState = await host.mainWin.webContents.executeJavaScript(`
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
    const noted = await host.mainWin.webContents.executeJavaScript(
      "document.querySelectorAll('#view-wordbook .wb-item').length",
    ).catch(() => -1);
    if (noted >= 1) console.log(`[shot] ✓ 「我写过的」筛出 ${noted} 条`);
    else console.error('[shot] ✗ 「我写过的」筛选没结果', noted);
    await click('[data-act="wb-filter"][data-filter="all"]', 600);

    /* 复习卡上也要出现——词库里没有这个词组，自己写的释义是卡片上唯一的释义。
       这一条最容易漏：wb:due 原先只查词库，卡片会一个字都没有。 */
    const due = await host.mainWin.webContents.executeJavaScript(
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
    await host.mainWin.webContents.executeJavaScript(`
      window.lexica.wbAnnotate({ word: 'policy', myDef: '策略（不是政策）', note: '强化学习语境' })
    `).catch(() => {});
    await lookup('policy');
    await wait(600);
    const entryState = await host.mainWin.webContents.executeJavaScript(`
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
    host.mainWin.webContents.send('nav:lookup', { word: 'zzzqqq' });
    await wait(900);
    const missHas = await host.mainWin.webContents.executeJavaScript(
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
  host.setQuitting();
  app.exit(badShots ? 1 : 0);
}

/**
 * 截图用的临时配置目录里预先放点东西：生词本十个词、一年的练习记录，
 * 生词本和热力图的截图才不是空的。只在 LEXICA_SHOT 下调用，碰不到真实数据。
 */
function seedShotProfile({ user, settings }) {
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

module.exports = { runShotSequence, seedShotProfile };
