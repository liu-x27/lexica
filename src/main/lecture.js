'use strict';
/**
 * 课堂记录：一场课一个目录，边上课边落盘。
 *
 * 两条硬约束决定了这里的结构：
 *
 * 1. **一节课一个多小时，中途崩了不能全丢。** 所以不在内存里攒到最后再写，
 *    而是每条字幕定稿就追加一次。
 * 2. **译文比原文晚到。** 识别出英文后才送去翻译，两者之间差一两秒。
 *    如果原文一到就写，译文回来时已经写下去了，顺序就乱了。
 *    所以维护一个按时间排序的待写队列，只有队首那条齐了才推进游标——
 *    识别和翻译都是顺序完成的，队首不会被后面的插队。
 *
 * 落盘策略：无论用户选了哪几种导出格式，**总是**写一份 journal.jsonl 流水账，
 * 它是崩溃安全的真相来源；md/txt/srt 是追加式生成的，json 在结束时由流水账汇总。
 * 上次没正常结束的话，流水账还在，可以用 recover() 重新生成成品。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** 支持的导出格式。key 与设置项 lectureFormats 里的值对应 */
const FORMATS = {
  md: { ext: 'md', label: 'Markdown（时间戳 + 双语）' },
  txt: { ext: 'txt', label: '纯文本' },
  srt: { ext: 'srt', label: '字幕 SRT' },
  json: { ext: 'json', label: '结构化 JSON' },
};

/** 毫秒 → SRT 的 00:01:23,456 */
function srtTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const msec = t % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(msec, 3)}`;
}

/** 毫秒 → 阅读用的 12:34（超过一小时给 1:02:03） */
function clockTime(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/** 文件名里不能出现的字符。课程名是用户随手输的，必须过滤 */
function safeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '未命名';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}`,
    human: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

class LectureRecorder {
  /** @param root 存放所有课堂记录的目录（userData/lectures） */
  constructor(root) {
    this.root = root;
    this.session = null;
  }

  get active() { return !!this.session; }

  /**
   * 开一场新记录。
   * @param title    课程名，进文件名
   * @param formats  要生成哪几种格式，如 ['md','srt']
   * @param meta     记进头部的信息（音频来源、模型等）
   */
  async start({ title = '', formats = ['md'], meta = {} } = {}) {
    if (this.session) await this.stop();

    const at = new Date();
    const s = stamp(at);
    const name = `${s.date} ${s.time} ${safeName(title)}`;
    const dir = path.join(this.root, name);
    await fsp.mkdir(dir, { recursive: true });

    const picked = formats.filter((f) => FORMATS[f]);
    this.session = {
      id: `${s.date}-${s.time}-${Math.random().toString(36).slice(2, 6)}`,
      title: title || '未命名课程',
      dir,
      name,
      startedAt: at.getTime(),
      startedAtHuman: s.human,
      formats: picked.length ? picked : ['md'],
      meta,
      // 待写队列：按 t0 排序，只有齐了译文的队首才写出去
      pending: [],
      nextId: 1,
      written: 0,
      srtIndex: 1,
      files: {},
    };

    /* 流水账永远写，它是崩溃时唯一还在的东西。
       故意用同步追加而不是 WriteStream：流的缓冲会让刚写的内容还没落盘，
       断电就丢——而这正是流水账要防的事；stop() 里回读也会读到空文件
       （写测试时就是这么暴露出来的：5 条字幕全在缓冲区里，JSON 汇总成了空数组）。
       一条字幕几百字节、每几秒一次，同步写完全负担得起。 */
    this.session.journalPath = path.join(dir, 'journal.jsonl');
    fs.appendFileSync(this.session.journalPath, `${JSON.stringify({
      kind: 'head',
      title: this.session.title,
      startedAt: this.session.startedAt,
      ...meta,
    })}\n`, 'utf8');

    for (const f of this.session.formats) {
      const file = path.join(dir, `transcript.${FORMATS[f].ext}`);
      this.session.files[f] = file;
      if (f === 'md') {
        await fsp.writeFile(file,
          `# ${this.session.title}\n\n`
          + `- 时间：${s.human}\n`
          + `- 音频来源：${meta.sourceLabel || '未知'}\n`
          + `- 识别模型：${meta.asrModel || '-'}　翻译模型：${meta.mtModel || '-'}\n\n`
          + '> 机器识别 + 机器翻译，术语与数字可能有误，重要内容请对照原文。\n\n---\n\n',
          'utf8');
      } else if (f === 'txt') {
        await fsp.writeFile(file, `${this.session.title}\n${s.human}\n${'='.repeat(40)}\n\n`, 'utf8');
      } else if (f === 'srt') {
        await fsp.writeFile(file, '', 'utf8');
      }
      // json 在 stop() 时由流水账汇总，过程中不写
    }

    return this.info();
  }

  info() {
    if (!this.session) return null;
    const s = this.session;
    return {
      id: s.id,
      title: s.title,
      dir: s.dir,
      name: s.name,
      startedAt: s.startedAt,
      formats: s.formats,
      written: s.written,
      pending: s.pending.length,
    };
  }

  /**
   * 收到一条识别结果。译文稍后由 setTranslation 补上。
   * @returns 这条的 id，用来回填译文
   */
  addSegment({ t0, t1, en }) {
    if (!this.session) throw new Error('没有正在进行的记录');
    const id = this.session.nextId++;
    this.session.pending.push({ id, t0, t1, en: String(en || '').trim(), zh: null, done: false });
    // 理论上是有序到达，但音频分段与识别并发时不保证，稳妥起见排一次
    this.session.pending.sort((a, b) => a.t0 - b.t0 || a.id - b.id);
    return id;
  }

  /**
   * 回填译文（zh 为 null 表示翻译失败，也要放行，否则队列会永久卡住）。
   */
  setTranslation(id, zh) {
    if (!this.session) return;
    const row = this.session.pending.find((r) => r.id === id);
    if (!row) return;
    row.zh = zh == null ? '' : String(zh).trim();
    row.done = true;
    this._drain();
  }

  /** 队首齐了就写出去，写到第一条没齐的为止 */
  _drain() {
    const s = this.session;
    if (!s) return;
    while (s.pending.length && s.pending[0].done) {
      const row = s.pending.shift();
      this._writeRow(row);
      s.written += 1;
    }
  }

  _writeRow(row) {
    const s = this.session;
    const rel0 = row.t0 - 0; // 这里的 t0 已经是相对录制开始的毫秒
    const rel1 = row.t1 - 0;

    fs.appendFileSync(s.journalPath, `${JSON.stringify({
      kind: 'seg', id: row.id, t0: row.t0, t1: row.t1, en: row.en, zh: row.zh,
    })}\n`, 'utf8');

    if (s.files.md) {
      fs.appendFileSync(s.files.md,
        `**[${clockTime(rel0)}]** ${row.en}\n\n${row.zh || '　—'}\n\n`, 'utf8');
    }
    if (s.files.txt) {
      fs.appendFileSync(s.files.txt,
        `[${clockTime(rel0)}]\n${row.en}\n${row.zh || ''}\n\n`, 'utf8');
    }
    if (s.files.srt) {
      /* 字幕两行：英文在上、中文在下，播放器会一起显示。
         序号必须连续递增，所以用独立计数器而不是 row.id
         （row.id 在跳过失败条目时会有空洞）。

         起点要被前一条的终点顶住：切分器为了不削掉句首会往前借一点音频
         （VadChunker 的 headMs），于是相邻两条的时间会重叠 100 多毫秒，
         有些播放器会因此报格式错误。 */
      const from = Math.max(rel0, s.srtLastEnd || 0);
      const to = Math.max(rel1, from + 800);
      fs.appendFileSync(s.files.srt,
        `${s.srtIndex}\n${srtTime(from)} --> ${srtTime(to)}\n`
        + `${row.en}\n${row.zh || ''}\n\n`, 'utf8');
      s.srtIndex += 1;
      s.srtLastEnd = to;
    }
  }

  /**
   * 结束记录。把还没等到译文的条目按现状写掉，再生成 json。
   * @returns 这场记录的信息与产出文件
   */
  async stop() {
    const s = this.session;
    if (!s) return null;

    // 别把最后几条卡在队列里丢掉
    for (const row of s.pending) row.done = true;
    this._drain();

    const segments = [];
    try {
      const lines = fs.readFileSync(s.journalPath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.kind === 'seg') segments.push(o);
        } catch { /* 崩溃时可能留下半行，跳过 */ }
      }
    } catch { /* 流水账读不到就只能给空的 */ }

    const durationMs = segments.length ? segments[segments.length - 1].t1 : 0;

    if (s.files.json) {
      await fsp.writeFile(s.files.json, `${JSON.stringify({
        title: s.title,
        startedAt: s.startedAt,
        startedAtHuman: s.startedAtHuman,
        durationMs,
        ...s.meta,
        note: '机器识别 + 机器翻译，术语与数字可能有误',
        segments: segments.map((o) => ({ t0: o.t0, t1: o.t1, en: o.en, zh: o.zh })),
      }, null, 2)}\n`, 'utf8');
    }

    if (s.files.md) {
      await fsp.appendFile(s.files.md,
        `\n---\n\n共 ${segments.length} 条，时长 ${clockTime(durationMs)}。\n`, 'utf8');
    }

    const out = { ...this.info(), segments: segments.length, durationMs, files: { ...s.files } };
    this.session = null;
    return out;
  }

  /* --------------------------------------------------------- 历史记录 */

  /** 列出过往的课堂记录，新的在前 */
  async list(limit = 100) {
    if (!fs.existsSync(this.root)) return [];
    const out = [];
    for (const e of await fsp.readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(this.root, e.name);
      const files = {};
      let segments = 0;
      let durationMs = 0;
      let title = e.name;
      for (const f of await fsp.readdir(dir)) {
        const ext = path.extname(f).slice(1);
        if (FORMATS[ext] && f.startsWith('transcript.')) files[ext] = path.join(dir, f);
      }
      // 条数与时长从流水账数，不依赖成品文件在不在
      try {
        const lines = (await fsp.readFile(path.join(dir, 'journal.jsonl'), 'utf8')).split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o.kind === 'head' && o.title) title = o.title;
            if (o.kind === 'seg') { segments += 1; durationMs = Math.max(durationMs, o.t1 || 0); }
          } catch { /* 忽略坏行 */ }
        }
      } catch { /* 没有流水账的目录也列出来 */ }

      const st = await fsp.stat(dir);
      out.push({
        name: e.name,
        dir,
        title,
        segments,
        durationMs,
        at: st.mtimeMs,
        files,
        // 有流水账但没有 json 成品，说明上次没正常结束
        unfinished: fs.existsSync(path.join(dir, 'journal.jsonl')) && segments > 0
          && !Object.keys(files).length,
      });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /**
   * 从流水账重新生成成品文件。
   * 上次崩溃 / 强退后用得上——流水账一直在，但 md/srt 可能缺尾、json 压根没写。
   */
  async recover(dir, formats = ['md', 'txt', 'srt', 'json']) {
    const jf = path.join(dir, 'journal.jsonl');
    if (!fs.existsSync(jf)) throw new Error('这个目录里没有流水账，恢复不了');

    let head = {};
    const segments = [];
    for (const line of (await fsp.readFile(jf, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.kind === 'head') head = o;
        else if (o.kind === 'seg') segments.push(o);
      } catch { /* 半行跳过 */ }
    }
    if (!segments.length) throw new Error('流水账里没有内容');

    const durationMs = segments[segments.length - 1].t1 || 0;
    const title = head.title || path.basename(dir);
    const human = head.startedAt ? stamp(new Date(head.startedAt)).human : '';
    const written = [];

    for (const f of formats.filter((x) => FORMATS[x])) {
      const file = path.join(dir, `transcript.${FORMATS[f].ext}`);
      if (f === 'md') {
        const body = segments.map((o) => `**[${clockTime(o.t0)}]** ${o.en}\n\n${o.zh || '　—'}\n`).join('\n');
        await fsp.writeFile(file,
          `# ${title}\n\n- 时间：${human}\n- 音频来源：${head.sourceLabel || '未知'}\n`
          + `- 识别模型：${head.asrModel || '-'}　翻译模型：${head.mtModel || '-'}\n\n`
          + '> 机器识别 + 机器翻译，术语与数字可能有误，重要内容请对照原文。\n\n---\n\n'
          + `${body}\n---\n\n共 ${segments.length} 条，时长 ${clockTime(durationMs)}。\n`, 'utf8');
      } else if (f === 'txt') {
        await fsp.writeFile(file,
          `${title}\n${human}\n${'='.repeat(40)}\n\n`
          + segments.map((o) => `[${clockTime(o.t0)}]\n${o.en}\n${o.zh || ''}\n`).join('\n'), 'utf8');
      } else if (f === 'srt') {
        // 同样要把起点钳在前一条的终点之后，理由见 _writeRow 里的注释
        let last = 0;
        await fsp.writeFile(file, segments.map((o, i) => {
          const from = Math.max(o.t0, last);
          const to = Math.max(o.t1, from + 800);
          last = to;
          return `${i + 1}\n${srtTime(from)} --> ${srtTime(to)}\n${o.en}\n${o.zh || ''}\n`;
        }).join('\n'), 'utf8');
      } else if (f === 'json') {
        await fsp.writeFile(file, `${JSON.stringify({
          title, startedAt: head.startedAt, startedAtHuman: human, durationMs,
          asrModel: head.asrModel, mtModel: head.mtModel, sourceLabel: head.sourceLabel,
          note: '机器识别 + 机器翻译，术语与数字可能有误',
          recovered: true,
          segments: segments.map((o) => ({ t0: o.t0, t1: o.t1, en: o.en, zh: o.zh })),
        }, null, 2)}\n`, 'utf8');
      }
      written.push(f);
    }
    return { dir, title, segments: segments.length, durationMs, formats: written };
  }
}

module.exports = { LectureRecorder, FORMATS, srtTime, clockTime, safeName };
