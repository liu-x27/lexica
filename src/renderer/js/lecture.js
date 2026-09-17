'use strict';
/**
 * 实时字幕：采音 → 静音切分 → 交给主进程识别翻译 → 落盘。
 *
 * 渲染层在这条链上只负责两件事：拿到音频、切成句子（都在 audio-source.js 里，
 * 与电影字幕悬浮窗共用）。
 * 识别、翻译、写文件都在主进程——界面刷新（或者手滑 Ctrl+R）
 * 不该把正在上的一节课打断。
 *
 * 三种音频来源：
 *   mic     麦克风。线下课用，教室大/教授走动时识别率会降。
 *   system  系统声音。网课、录播用，音质干净，识别率明显更高。
 *           走 getDisplayMedia + loopback，需要主进程侧配合（见 index.js）。
 *   import  已有录音文件。课后批量转写，可以用跑不动实时的 small 模型。
 */
(function (Lx) {
  const { $, esc, toast } = Lx;
  const api = window.lexica;

  /** 导入录音时重采样的目标采样率，与 audio-source.js 一致 */
  const RATE = window.LexicaAudio.RATE;

  const SOURCES = {
    mic: { label: '麦克风', hint: '线下课。教室大或教授走动时识别率会下降。' },
    system: { label: '系统声音', hint: '网课、录播。音质干净，识别率明显更高。' },
    import: { label: '导入录音', hint: '课后转写已有的录音文件，可用更准的模型。' },
  };

  const st = {
    view: 'live',            // live | history
    status: null,            // asr:status 的结果
    running: false,
    starting: false,
    source: 'mic',
    title: '',
    segments: [],            // { id, t0, t1, en, zh, pending }
    byId: new Map(),
    warn: null,
    history: [],
    importing: null,         // { phase, percent, name }
    startedAt: 0,
    // 采音链
    audio: null,             // { ctx, stream, node, source, vad }
    level: 0,                // 当前输入电平，给界面画音量条
  };

  Lx.lectureState = st;

  /* ==================================================================== */
  /*  采音                                                                */
  /* ==================================================================== */

  /* 采音抽到了 audio-source.js：电影字幕悬浮窗也要用同一套，
     两处各抄一份的话采样率、VAD 参数、清理顺序必然会漂。 */
  async function startCapture(source) {
    st.audio = await window.LexicaAudio.start(source, {
      maxChunkSec: st.status?.maxChunkSec || 9,
      silenceMs: st.status?.silenceMs || 420,
      onLevel: (v) => { st.level = v; },
      // 转移 buffer 所有权，避免每段都复制一遍（一段有几十万个采样点）
      onChunk: (cut) => api.lecFeed(cut.pcm.buffer, cut.startMs),
    });
  }

  async function stopCapture() {
    const a = st.audio;
    st.audio = null;
    st.level = 0;
    if (a) await a.stop();
  }

  /* ==================================================================== */
  /*  开始 / 停止                                                         */
  /* ==================================================================== */

  async function start() {
    if (st.running || st.starting) return;
    st.starting = true;
    st.warn = null;
    paint();

    try {
      // 先起识别服务：模型加载要两三秒，失败了就不必占着麦克风
      const r = await api.lecStart({
        title: st.title,
        source: st.source,
        sourceLabel: SOURCES[st.source]?.label,
      });
      if (!r?.ok) throw new Error(r?.reason || '无法开始');

      await startCapture(st.source);

      st.running = true;
      st.startedAt = Date.now();
      st.segments = [];
      st.byId.clear();
      st.session = r.session;
      /* 回填实际用的模型：记录期间会临时切到实时专用的翻译模型，
         不回填的话顶栏显示的是切换前那个，对不上文件头里写的。 */
      st.status = { ...st.status, model: r.asrModel, mtModel: r.mtModel };
      toast(`开始记录：${r.session.title}`);
    } catch (e) {
      // 半路失败要把已经起来的部分收掉，否则下次开始会撞上「已经在记录了」
      await stopCapture();
      await api.lecStop().catch(() => {});
      st.running = false;
      st.warn = e.message;
      toast(`开始失败：${e.message}`, 3200);
    } finally {
      st.starting = false;
      paint();
      tick();
    }
  }

  async function stop() {
    if (!st.running) return;
    st.running = false;
    paint();
    await stopCapture();
    const r = await api.lecStop();
    if (r?.ok) {
      st.lastResult = r;
      const dropped = r.dropped ? `，丢弃 ${r.dropped} 段` : '';
      toast(`已保存 ${r.segments} 条字幕${dropped}`, 2600);
      st.history = await api.lecList();
    } else if (r?.reason) {
      toast(r.reason);
    }
    paint();
  }

  /* ==================================================================== */
  /*  导入录音                                                            */
  /* ==================================================================== */

  /**
   * 解码任意音频并重采样成 16k 单声道。
   *
   * 用 Chromium 自带的解码器（decodeAudioData 支持 mp3/m4a/ogg/flac/wav），
   * 不引入 ffmpeg —— 本机没有，而且多一个外部依赖就多一处打包问题。
   */
  async function decodeTo16k(arrayBuffer) {
    const probe = new AudioContext();
    let decoded;
    try {
      decoded = await probe.decodeAudioData(arrayBuffer);
    } finally {
      probe.close();
    }
    // OfflineAudioContext 负责重采样与混单声道
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return out.getChannelData(0);
  }

  async function importAudio() {
    if (st.running) return toast('正在实时记录，先停止再导入');
    const picked = await api.lecPickAudio();
    if (!picked?.ok) {
      if (picked?.reason && picked.reason !== '已取消') toast(picked.reason);
      return;
    }

    st.importing = { phase: 'decode', percent: 0, name: picked.name };
    st.segments = [];
    st.byId.clear();
    paint();

    try {
      const pcm = await decodeTo16k(picked.data);
      const minutes = (pcm.length / RATE / 60).toFixed(1);
      st.importing = { phase: 'asr', percent: 0, name: picked.name, minutes };
      paint();

      const r = await api.lecTranscribeFile({
        pcm: pcm.buffer,
        title: st.title || picked.name.replace(/\.[^.]+$/, ''),
        modelKey: st.status?.models?.some((m) => m.key === 'small') ? 'small' : undefined,
      });
      st.importing = null;
      if (!r?.ok) {
        toast(r?.reason || '转写失败', 3200);
      } else {
        st.lastResult = r;
        toast(`已转写 ${r.segments} 条`, 2600);
        st.history = await api.lecList();
      }
    } catch (e) {
      st.importing = null;
      toast(`解码失败：${e.message}`, 3200);
    }
    paint();
  }

  /* ==================================================================== */
  /*  渲染                                                                */
  /* ==================================================================== */

  const view = () => $('#view-lecture');

  function paint() {
    const el = view();
    if (!el) return;
    el.innerHTML = Lx.renderLecture(st, SOURCES);
    // 实时模式下自动滚到底，除非用户自己往上翻了
    if (st.running && !st.userScrolled) {
      const list = $('#lecList');
      if (list) list.scrollTop = list.scrollHeight;
    }
  }

  /** 只更新计时与音量条，不整页重绘——一秒重绘一次整屏字幕太浪费 */
  function tick() {
    if (!st.running) return;
    const t = $('#lecClock');
    if (t) t.textContent = Lx.lectureClock(Date.now() - st.startedAt);
    const bar = $('#lecLevel');
    if (bar) bar.style.transform = `scaleX(${Math.min(1, st.level * 3).toFixed(3)})`;
    requestAnimationFrame(tick);
  }

  /** 增量插入一条字幕，避免整页重绘 */
  function appendSegment(seg) {
    const list = $('#lecList');
    if (!list) return paint();
    const div = document.createElement('div');
    div.className = 'lec-row';
    div.id = `lec-${seg.id}`;
    div.innerHTML = Lx.lectureRow(seg);
    list.appendChild(div);
    if (!st.userScrolled) list.scrollTop = list.scrollHeight;
    return null;
  }

  function fillTranslation(id, zh, reason) {
    const row = st.byId.get(id);
    if (row) { row.zh = zh; row.pending = false; row.reason = reason; }
    const el = document.getElementById(`lec-${id}`);
    if (el && row) el.innerHTML = Lx.lectureRow(row);
  }

  /* ==================================================================== */
  /*  接线                                                                */
  /* ==================================================================== */

  Lx.lectureEnter = async function lectureEnter() {
    st.status = await api.asrStatus();
    st.source = (Lx.settings?.lectureSource) || st.source;
    if (!st.history.length) st.history = await api.lecList();
    paint();
  };

  Lx.lectureLeave = function lectureLeave() {
    // 离开页面不停止记录：切去查个词回来，课还在录
  };

  Lx.lectureWire = function lectureWire() {
    api.onLecSegment((seg) => {
      const row = { ...seg, zh: null, pending: true };
      st.segments.push(row);
      st.byId.set(seg.id, row);
      if (st.view === 'live') appendSegment(row);
    });

    api.onLecTranslated(({ id, zh, reason }) => fillTranslation(id, zh, reason));

    api.onLecWarn(({ message }) => {
      st.warn = message;
      const box = $('#lecWarn');
      if (box) { box.textContent = message; box.classList.remove('hidden'); }
      else paint();
    });

    api.onLecImportProgress((p) => {
      if (!st.importing) return;
      st.importing = { ...st.importing, ...p };
      const bar = $('#lecImportBar');
      const txt = $('#lecImportText');
      if (bar) bar.style.width = `${p.percent || 0}%`;
      if (txt) txt.textContent = Lx.lectureImportLabel(st.importing);
      if (!bar) paint();
    });

    // 用户往上翻看历史字幕时别把他拽回底部
    document.addEventListener('scroll', (e) => {
      if (e.target?.id !== 'lecList') return;
      const l = e.target;
      st.userScrolled = l.scrollHeight - l.scrollTop - l.clientHeight > 80;
    }, true);
  };

  /**
   * 自测钩子：拿一段音频按**实时链路**跑一遍（VAD 切分 → lecFeed → 识别 → 翻译 → 落盘）。
   *
   * 麦克风在自动化里喂不了，但从 lecFeed 往后的每一环都和真实使用完全一致，
   * 所以这条路径能验证除「采音」以外的全部逻辑。正常运行时挂着无害。
   */
  Lx.lectureSelfTest = async function lectureSelfTest() {
    const picked = await api.lecPickAudio();
    if (!picked?.ok) throw new Error(picked?.reason || '拿不到测试音频');

    st.status = await api.asrStatus();
    st.title = '自测：强化学习导论';
    const r = await api.lecStart({ title: st.title, source: 'mic', sourceLabel: '麦克风（自测）' });
    if (!r?.ok) throw new Error(r.reason);
    st.running = true;
    st.startedAt = Date.now();
    st.segments = [];
    st.byId.clear();
    st.session = r.session;
    st.status = { ...st.status, model: r.asrModel, mtModel: r.mtModel };
    paint();

    const pcm = await decodeTo16k(picked.data);

    /* 解码在渲染层（Web Audio 只有这儿有），但**按节奏喂必须放主进程**。
       原先这里用 setTimeout 分 664 次喂，结果打包版跑到这一步卡了 19 分钟只出 2 条：
       Chromium 会把不可见/被遮挡窗口的定时器限流到每秒一次甚至更慢。
       真实采音不受影响（由音频线程驱动），但自测不该依赖窗口可见性。 */
    return api.lecSelfTestFeed({ pcm: pcm.buffer, speed: 4 });
  };

  /** 自测钩子：只做解码，把 PCM 交回调用方（悬浮窗那条验证要用） */
  Lx.lectureDecodeForTest = async function lectureDecodeForTest(arrayBuffer) {
    const pcm = await decodeTo16k(arrayBuffer);
    return pcm.buffer;
  };

  Lx.lectureSelfTestStop = async function lectureSelfTestStop() {
    st.running = false;
    const r = await api.lecStop();
    st.history = await api.lecList();
    paint();
    return r;
  };

  /** 事件委托里用得到的动作 */
  Lx.lectureActions = {
    'lec-start': () => start(),
    'lec-stop': () => stop(),
    'lec-import': () => importAudio(),
    'lec-source': (el) => {
      if (st.running) return toast('正在记录，先停止再换音频来源');
      st.source = el.dataset.v;
      api.putSettings({ lectureSource: st.source });
      paint();
    },
    'lec-title': (el) => { st.title = el.value; },
    'lec-tab': (el) => { st.view = el.dataset.v; st.userScrolled = false; paint(); },
    'lec-open': (el) => api.lecOpen(el.dataset.dir),
    'lec-recover': async (el) => {
      const r = await api.lecRecover(el.dataset.dir).catch((e) => ({ __error: e.message }));
      if (r?.__error) toast(r.__error, 3000);
      else toast(`已恢复 ${r.segments} 条`);
      st.history = await api.lecList();
      paint();
    },
    'lec-subtitle': () => api.subToggle(true),
    'lec-copy': async () => {
      const text = st.segments.map((s) => `${s.en}\n${s.zh || ''}`).join('\n\n');
      if (!text.trim()) return toast('还没有内容');
      await navigator.clipboard.writeText(text);
      return toast('已复制本节全部字幕');
    },
  };
})(window.Lx);
