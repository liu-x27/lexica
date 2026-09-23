'use strict';
/**
 * 桌面版和安卓版共用的业务层：查词、生词本、考纲练习、自定义词表与词条。
 *
 * 这些逻辑原先写了两遍——桌面在 index.js 的 IPC 处理函数里，安卓在
 * lexica-shim.js 里手抄一份。抄的那份已经漏了东西：安卓的词表没有 scope，
 * 从自定义页「去练习」会把练习范围存成空串；安卓的生词本导出少了我的释义、
 * 笔记、出处、例句四列。现在两边都从这里取同一套实现，只各自处理平台的事：
 * 桌面把方法挂到 IPC 通道上、导出走保存对话框；安卓包成 Promise、导出走系统分享。
 *
 * 这里只依赖 DictDB / UserDB / Quiz，不碰 Electron、fs、窗口——
 * 安卓的 WebView 里靠同一个 CommonJS 运行时原样加载它（见 build-android-www.mjs）。
 *
 * `api` 里的方法名与签名就是渲染层看到的 window.lexica 的方法名与签名。
 */
const { parseTranslation } = require('./dict-db');
const { SCOPE_LABELS, KIND_LABELS, checkSpelling } = require('./quiz');
const { parseWordList } = require('./user-db');

/**
 * 把用户自建词条包装成和内置词条一样的结构，
 * 这样渲染层不用为它写第二套逻辑。
 */
function customAsEntry(row) {
  return {
    id: -1,
    word: row.word,
    wkey: row.word,
    isCustom: true,
    note: row.note || null,
    lemmaOf: null,
    weak: false,
    phon: row.phonetic ? { main: row.phonetic, variants: [], us: null } : null,
    phonetic: row.phonetic || null,
    translation: parseTranslation(row.translation),
    translationRaw: row.translation,
    definition: [],
    posRatio: [],
    forms: [],
    tags: [],
    collins: 0,
    oxford: false,
    bnc: 0,
    frq: 0,
    rank: 999999,
    senses: [],
    examples: [],
    examplesByPos: {},
    relations: { synonyms: [], antonyms: [], hypernyms: [], hyponyms: [] },
    etym: null,
    quotes: [],
    confusables: [],
  };
}

const today = () => new Date().toISOString().slice(0, 10);

/** 义项行拼成一格：「n. 苹果；v. …」 */
const joinMeanings = (entry, sep) =>
  entry.translation.map((t) => (t.pos ? `${t.pos}. ${t.text}` : t.text)).join(sep);

/**
 * @param {object} deps
 * @param {import('./dict-db').DictDB} deps.dict
 * @param {import('./user-db').UserDB} deps.user
 * @param {import('./quiz').Quiz} deps.quiz
 * @param {(name: string, payload: unknown) => void} deps.emit  推给渲染层的事件
 */
function createCore({ dict, user, quiz, emit }) {
  const wbChanged = () => emit('wb:changed', user.counts());

  const api = {
    /* ---- 词典 ---- */

    lookup(word, opts) {
      // 自定义词条优先：用户特意补的词，说明内置词库没有或不满意
      const custom = user.customEntry(word);
      if (custom) {
        if (!opts?.noHistory) user.pushHistory(custom.word);
        const built = dict.lookup(word);
        return {
          status: 'ok',
          entry: customAsEntry(custom),
          // 内置词库里也有的话，一并告知，让用户能切过去看
          alsoBuiltin: built.status === 'ok' ? built.entry.word : null,
          saved: user.isSaved(custom.word),
          mine: user.entry(custom.word),
          corrections: [],
          weak: false,
        };
      }

      const res = dict.lookup(word);
      if (res.status === 'ok') {
        if (!opts?.noHistory) user.pushHistory(res.entry.word);
        res.saved = user.isSaved(res.entry.word);
        // 生词本上的笔记与自有释义是叠加的，词条页要单独排一块
        res.mine = user.entry(res.entry.word);
      }
      return res;
    },

    suggest(q, limit) {
      const res = dict.suggest(q, limit);
      // 自建词条排在最前面：用户自己录的，优先级最高
      const mine = user.customPrefix(q, 5);
      if (mine.length) {
        res.groups.unshift({
          kind: 'custom',
          title: '我的词条',
          items: mine.map((r) => ({
            word: r.word,
            phonetic: r.phonetic,
            brief: r.translation.slice(0, 60),
            tags: [],
            collins: 0,
            oxford: false,
          })),
        });
      }
      return res;
    },

    search: (q, limit) => dict.search(q, limit),
    random: () => dict.randomWord(),
    // 抽出任意文本里词库收录的术语，翻译页要用
    sentenceTerms: (text) => dict.termsIn(text),

    /* ---- 生词本 ---- */

    wbToggle(word) {
      const r = user.toggle(word);
      wbChanged();
      return r;
    },
    wbIsSaved: (word) => user.isSaved(word),

    wbList(opts) {
      // 补上中文释义与难度标签，生词本列表才有内容可看。
      // 用 briefMany 一次批量取：逐个 lookup() 会连义项、例句、词源一起查出来，
      // 而列表只用得上音标和前两条释义。
      const rows = user.list(opts);
      const brief = dict.briefMany(rows.map((r) => r.word));
      return rows.map((row) => {
        const b = brief.get(String(row.word).toLowerCase());
        const mine = user.customEntry(row.word);
        return {
          ...row,
          myDef: row.my_def || null,
          phonetic: b?.phonetic || mine?.phonetic || null,
          /* 列表只有一行位置，优先给自己写的——那是用户特意记下来的，
             而词库释义在词条页随时能看到。 */
          brief: row.my_def || b?.brief || mine?.translation || '',
          /* 词库里到底有没有这个词，界面要能区分：
             自己加的词组点进去是没有词条页的，得给不同的提示。 */
          inDict: !!b,
          tags: b?.tags.map((t) => t.code) || [],
          collins: b?.collins || 0,
        };
      });
    },

    /** 单条生词本记录（编辑框要用），连词库摘要一起给 */
    wbGet(word) {
      const row = user.entry(word);
      const b = dict.briefMany([word]).get(String(word || '').toLowerCase());
      return {
        row: row || null,
        saved: !!row,
        dictBrief: b?.brief || null,
        phonetic: b?.phonetic || null,
        inDict: !!b,
      };
    },

    /** 手动添加。词库里没有的词组只能走这条路进生词本 */
    wbAdd(payload) {
      const r = user.addWord(payload?.word, { note: payload?.note, myDef: payload?.myDef });
      if (r.ok) wbChanged();
      return r;
    },

    /**
     * 带语境收藏：在字幕、翻译页、历史转写稿里点词，按下「收进生词本」走这里。
     * 语境单独存（wordbook.contexts），不碰用户自己写的笔记。
     */
    wbAddContext(payload) {
      const r = user.addContext(payload?.word, {
        en: payload?.en, zh: payload?.zh, src: payload?.src,
      });
      if (r.ok) wbChanged();
      return r;
    },
    wbRemoveContext: (word, index) => user.removeContext(word, index),

    /** 写/改注释（笔记 + 我的释义） */
    wbAnnotate(payload) {
      const r = user.annotate(payload?.word, { note: payload?.note, myDef: payload?.myDef });
      if (r.ok) wbChanged();
      return r;
    },

    wbRemove(word) {
      const r = user.remove(word);
      wbChanged();
      return r;
    },
    wbCounts: () => user.counts(),

    wbDue(limit) {
      return user.dueQueue(limit).map((row) => {
        const r = dict.lookup(row.word, { noHistory: true });
        /* 自己加的词组词库里查不到，entry 会是 null。
           这时用自建词条兜一层，否则复习卡上一个字都没有，卡片没法答。 */
        let entry = r.status === 'ok' ? r.entry : null;
        if (!entry) {
          const mine = user.customEntry(row.word);
          if (mine) entry = customAsEntry(mine);
        }
        return { card: row, entry, myDef: row.my_def || null, note: row.note || null };
      });
    },

    wbGrade(word, grade) {
      const r = user.grade(word, grade);
      wbChanged();
      return r;
    },

    /* ---- 考纲练习 ---- */

    drillScopes: () => quiz.scopes().map((s) => ({ ...s, progress: user.scopeProgress(s.scope) })),
    drillProgress: (scope) => user.scopeProgress(scope),
    drillStudy: (scope, count) => quiz.studyBatch(scope, count),
    drillQuiz: (scope, count, kinds) => quiz.batch(scope, count, { kinds }),
    drillAssess: (scope, count) => quiz.assessmentBatch(scope, count),

    drillAnswer(payload) {
      user.recordAnswer(payload);
      return { ok: true };
    },

    drillFinish(payload) {
      user.saveSession(payload);
      return user.scopeProgress(payload.scope);
    },

    drillMark(word, scope, known) {
      user.markWord(word, scope, known);
      // 标记为不认识的词直接进生词本，省一步操作
      if (!known && !user.isSaved(word)) {
        user.toggle(word);
        wbChanged();
      }
      return { ok: true, saved: user.isSaved(word) };
    },

    drillWeak(scope, limit) {
      return user.weakWords(scope, limit).map((r) => {
        const res = dict.lookup(r.word, { noHistory: true });
        return { ...r, entry: res.status === 'ok' ? res.entry : null };
      });
    },

    /** 错题重练：拿错得最多的词现场出题 */
    drillWeakQuiz(scope, count) {
      const rows = user.weakWords(scope, count * 3);
      const out = [];
      for (const r of rows) {
        if (out.length >= count) break;
        const row = dict.q.exact.get(String(r.word).toLowerCase());
        if (!row) continue;
        for (const kind of ['en2zh', 'zh2en', 'cloze']) {
          const q = quiz.makeQuestion(scope, row, kind);
          if (q) { out.push(q); break; }
        }
      }
      return out;
    },

    drillLabels: () => ({ scopes: SCOPE_LABELS, kinds: KIND_LABELS }),
    drillCheckSpell: (input, answer) => checkSpelling(input, answer),

    /* ---- 自定义词表与词条 ---- */

    /* 每个词表带上它在练习里的范围名：自定义页「去练习」要拿它切到练习页。
       安卓那份抄漏了这一项，按钮拿到的 scope 是空串，还会被存进设置。 */
    lists: () => user.lists().map((l) => ({ ...l, scope: `list:${l.id}` })),

    listCreate(name, text, note) {
      const r = user.createList(name, text, note);
      if (r.ok) quiz.invalidateCustom();
      return r;
    },

    listDelete(id) {
      const r = user.deleteList(id);
      if (r.ok) quiz.invalidateCustom();
      return r;
    },

    /** 导入前先告诉用户：解析出多少词、词库里能查到多少 */
    listPreview(text) {
      const words = parseWordList(text);
      /* 先用一次批量查把绝大多数词判掉，剩下的才逐个走 lookup()。
         lookup() 能处理变形与拼写纠错，但每个词都要查十几张表——
         导入几千行的词表时，全走 lookup 会卡住整个界面。 */
      const brief = dict.briefMany(words);
      let known = 0;
      const missing = [];
      for (const w of words) {
        if (brief.has(w) || dict.lookup(w, { noHistory: true }).status === 'ok') known++;
        else if (missing.length < 12) missing.push(w);
      }
      return { total: words.length, known, missing };
    },

    customAll: (limit) => user.customEntries(limit || 500),
    customGet: (word) => user.customEntry(word),
    customPut: (entry) => user.putCustomEntry(entry),
    customDelete: (word) => user.deleteCustomEntry(word),

    /* ---- 统计与历史 ---- */

    heatmap: (days) => user.heatmap(days),
    recent: (limit) => user.recent(limit),
    clearHistory() {
      user.clearHistory();
      return { ok: true };
    },
  };

  /**
   * 生词本导出的文件内容。存到哪里是平台的事：桌面弹保存对话框，安卓走系统分享。
   * @returns {{ok: true, filename: string, content: string, count: number} | {ok: false, reason: string}}
   */
  function wordbookFile(format) {
    const words = user.allWords();
    if (!words.length) return { ok: false, reason: '生词本还是空的' };

    const isAnki = format === 'anki';
    const esc = (s) => {
      const v = String(s ?? '');
      return isAnki ? v.replace(/[\t\n\r]+/g, ' ') : `"${v.replace(/"/g, '""')}"`;
    };
    const sep = isAnki ? '\t' : ',';
    const lines = [];
    if (!isAnki) {
      lines.push(['单词', '音标', '释义', '我的释义', '我的笔记', '出处', '例句', '难度标签', '加入时间', '复习次数']
        .map(esc).join(sep));
    }

    for (const w of words) {
      const r = dict.lookup(w.word, { noHistory: true });
      const e = r.status === 'ok' ? r.entry : null;
      const mine = e ? null : user.customEntry(w.word);
      const dictMean = e ? joinMeanings(e, isAnki ? '<br>' : '；') : (mine?.translation || '');
      const ex = e?.examples?.[0] ? `${e.examples[0].en}${e.examples[0].zh ? (isAnki ? '<br>' : ' ') + e.examples[0].zh : ''}` : '';
      /* Anki 那边列数固定（正面/背面…），自己写的内容拼进背面，
         不能多加两列——多了导入时字段会错位。
         出处：在哪句话里遇到的。Anki 背面只放最近一条，放多了反而干扰；
         CSV 里给全。 */
      const ctxs = (w.contexts || []).map((c) => `${c.en}${c.src ? `（${c.src}）` : ''}`);
      const anki = [
        w.word,
        e?.phonetic || mine?.phonetic || '',
        [w.my_def, dictMean, w.note && `【笔记】${w.note}`, ctxs[0] && `【出处】${ctxs[0]}`]
          .filter(Boolean).join('<br>'),
        ex,
        (e?.tags || []).map((t) => t.label).join(' '),
        new Date(w.added_at).toISOString().slice(0, 10),
        w.reps,
      ];
      const csv = [
        w.word,
        e?.phonetic || mine?.phonetic || '',
        dictMean,
        w.my_def || '',
        w.note || '',
        ctxs.join(' / '),
        ex,
        (e?.tags || []).map((t) => t.label).join(' '),
        new Date(w.added_at).toISOString().slice(0, 10),
        w.reps,
      ];
      lines.push((isAnki ? anki : csv).map(esc).join(sep));
    }

    return {
      ok: true,
      filename: `lexica-wordbook-${today()}.${isAnki ? 'tsv' : 'csv'}`,
      // Excel 打开 CSV 需要 BOM 才能正确识别 UTF-8
      content: (isAnki ? '' : '﻿') + lines.join('\r\n'),
      count: words.length,
    };
  }

  /**
   * 练习进度导出：范围汇总 + 错题明细，一份 CSV。存到哪里同样是平台的事。
   * @returns {{ok: true, filename: string, content: string, scopes: number, weak: number} | {ok: false, reason: string}}
   */
  function drillFile(onlyScope) {
    const scopes = quiz.scopes().filter((s) => !onlyScope || s.scope === onlyScope);
    if (!scopes.length) return { ok: false, reason: '没有可导出的范围' };

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [];
    let weakTotal = 0;

    lines.push('# 范围汇总');
    lines.push(['范围', '可练词量', '已掌握', '待巩固', '累计答题', '正确率', '上次检测掌握率', '检测时间']
      .map(esc).join(','));
    for (const s of scopes) {
      const p = user.scopeProgress(s.scope);
      lines.push([
        s.label,
        s.quizzable,
        p.mastered,
        p.shaky,
        p.answered,
        p.accuracy == null ? '' : `${Math.round(p.accuracy * 100)}%`,
        p.lastAssessment ? `${Math.round(p.lastAssessment.rate * 100)}%` : '',
        p.lastAssessment ? new Date(p.lastAssessment.at).toLocaleString('zh-CN') : '',
      ].map(esc).join(','));
    }

    lines.push('');
    lines.push('# 错题明细');
    lines.push(['范围', '单词', '音标', '释义', '答题次数', '答对', '答错', '难度标签']
      .map(esc).join(','));
    for (const s of scopes) {
      for (const w of user.weakWords(s.scope, 500)) {
        const r = dict.lookup(w.word, { noHistory: true });
        const e = r.status === 'ok' ? r.entry : null;
        lines.push([
          s.label,
          w.word,
          e?.phon?.main || '',
          e ? joinMeanings(e, '；') : '',
          w.seen,
          w.hit,
          w.miss,
          (e?.tags || []).map((t) => t.label).join(' '),
        ].map(esc).join(','));
        weakTotal++;
      }
    }

    const name = onlyScope ? `lexica-${onlyScope}` : 'lexica-练习进度';
    return {
      ok: true,
      filename: `${name}-${today()}.csv`,
      // Excel 打开 CSV 需要 BOM 才能认出 UTF-8
      content: `﻿${lines.join('\r\n')}`,
      scopes: scopes.length,
      weak: weakTotal,
    };
  }

  return { api, wordbookFile, drillFile };
}

/**
 * 桌面版的 IPC 通道 → api 方法名。index.js 照着这张表挂处理函数，
 * 测试拿它和 preload.js 逐条对账：api 里多一个方法而这里漏了、
 * 或 preload 调的通道这里没有，测试都会失败，而不是等到用户点了没反应。
 * 安卓直接调 api，用不上这张表。
 *
 * `wb:removeContext` 不在表里：preload 把它的两个参数包成了一个对象，index.js 单独拆开。
 */
const IPC_CHANNELS = {
  'dict:lookup': 'lookup',
  'dict:suggest': 'suggest',
  'dict:search': 'search',
  'dict:random': 'random',
  'dict:terms': 'sentenceTerms',

  'wb:toggle': 'wbToggle',
  'wb:isSaved': 'wbIsSaved',
  'wb:list': 'wbList',
  'wb:get': 'wbGet',
  'wb:add': 'wbAdd',
  'wb:addContext': 'wbAddContext',
  'wb:annotate': 'wbAnnotate',
  'wb:remove': 'wbRemove',
  'wb:counts': 'wbCounts',
  'wb:due': 'wbDue',
  'wb:grade': 'wbGrade',

  'drill:scopes': 'drillScopes',
  'drill:progress': 'drillProgress',
  'drill:study': 'drillStudy',
  'drill:quiz': 'drillQuiz',
  'drill:assess': 'drillAssess',
  'drill:answer': 'drillAnswer',
  'drill:finish': 'drillFinish',
  'drill:mark': 'drillMark',
  'drill:weak': 'drillWeak',
  'drill:weakQuiz': 'drillWeakQuiz',
  'drill:labels': 'drillLabels',
  'drill:checkSpell': 'drillCheckSpell',

  'list:all': 'lists',
  'list:create': 'listCreate',
  'list:delete': 'listDelete',
  'list:preview': 'listPreview',
  'custom:all': 'customAll',
  'custom:get': 'customGet',
  'custom:put': 'customPut',
  'custom:delete': 'customDelete',

  'stats:heatmap': 'heatmap',
  'hist:recent': 'recent',
  'hist:clear': 'clearHistory',
};

module.exports = { createCore, customAsEntry, IPC_CHANNELS };
