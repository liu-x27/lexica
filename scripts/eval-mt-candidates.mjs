#!/usr/bin/env node
/**
 * 候选翻译模型的对比评测。
 *
 * 现役的 opus-mt-en-zh q8 在学术文本上不堪用——实测不只是术语不准，
 * 而是会把 `code and checkpoints` 译成「密码和检查站」、
 * 把 `from 71.2 to 63.8` 写成「从71.2降低至638」（小数点被吃掉）。
 * 这个脚本用同一批句子跑多个候选，把结果并排列出来，人眼定夺。
 *
 *   node scripts/eval-mt-candidates.mjs --probe            列出各候选要下多少
 *   node scripts/eval-mt-candidates.mjs --fetch nllb       下载某个候选
 *   node scripts/eval-mt-candidates.mjs --run              评测本地已有的候选
 *   node scripts/eval-mt-candidates.mjs --run --only nllb  只评某一个
 *
 * 模型下到 data/model/ 下，和现役模型同一个位置，评完可以直接留用。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { request, proxyUrl } from './lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = path.join(ROOT, 'data', 'model');

/* ------------------------------------------------------------------ 候选 */

/**
 * seq2seq 仓库里通常放着三份 decoder：`decoder_model`、`decoder_with_past_model`、
 * 以及把两者合成一个图的 `decoder_model_merged`。transformers.js 用的是 merged 那份，
 * 另外两份是等价备选——不排掉就白下一倍多的量（NLLB 从 855MB 涨到 1747MB）。
 */
const SEQ2SEQ_WEIGHTS = /^onnx\/(encoder_model|decoder_model_merged)_quantized\.onnx$/;

/**
 * kind 决定怎么调用：
 *   'seq2seq' —— 专用翻译模型，走 translation pipeline
 *   'chat'    —— 指令模型，走 text-generation + 对话模板
 * keep 是要下载的文件筛选函数：仓库里往往同时放着 fp32/fp16/q8/q4 多份权重，
 * 全下会多出几个 GB。
 */
const CANDIDATES = {
  opus: {
    repo: 'Xenova/opus-mt-en-zh',
    label: 'opus-mt-en-zh（现役）',
    kind: 'seq2seq',
    dtype: 'q8',
    keep: (f) => !f.startsWith('onnx/') || SEQ2SEQ_WEIGHTS.test(f),
  },
  nllb: {
    repo: 'Xenova/nllb-200-distilled-600M',
    label: 'NLLB-200-distilled-600M',
    kind: 'seq2seq',
    dtype: 'q8',
    // NLLB 要显式指定语言方向，否则默认不是中文
    opts: { src_lang: 'eng_Latn', tgt_lang: 'zho_Hans' },
    keep: (f) => !f.startsWith('onnx/') || SEQ2SEQ_WEIGHTS.test(f),
  },
  /* Qwen 一律用 q8（对应仓库里的 model_quantized.onnx）。
     q4f16 体积最小，但那是给 WebGPU 的：onnxruntime-node 走 CPU，加载时会炸在
     `SimplifiedLayerNormFusion` 上（Attempting to get index by a name which does not exist）。
     踩过一次，别再改回 q4f16。 */
  qwen05: {
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    label: 'Qwen2.5-0.5B-Instruct',
    kind: 'chat',
    dtype: 'q8',
    keep: (f) => !f.startsWith('onnx/') || /model_quantized\.onnx/.test(f),
  },
  qwen15: {
    repo: 'onnx-community/Qwen2.5-1.5B-Instruct',
    label: 'Qwen2.5-1.5B-Instruct',
    kind: 'chat',
    dtype: 'q8',
    keep: (f) => !f.startsWith('onnx/') || /model_quantized\.onnx/.test(f),
  },
};

/** 挑的都是现役模型翻错过的真实句子，外加两句日常英文做对照 */
const CASES = [
  {
    src: 'We release code and checkpoints to facilitate reproduction.',
    note: '现役译成「我们发布密码和检查站 方便生殖」',
  },
  {
    src: 'Our ablation study indicates that the projection head is critical: removing it degrades linear-probe accuracy from 71.2 to 63.8.',
    note: '现役把 63.8 写成 638，术语也全错',
  },
  {
    src: 'Recent work has shown that large language models can perform in-context learning without any gradient updates.',
    note: '现役译成「大型语文模式」「通俗化学习」',
  },
  {
    src: 'Notably, performance scales log-linearly with the number of negative samples up to 65,536, after which returns diminish.',
    note: '现役把 log-linearly 读成了日志',
  },
  {
    src: 'A contrastive objective, combined with strong augmentation, yields representations that transfer well to downstream tasks.',
    note: '现役译成「强有力的增产」「是产量的表示」',
  },
  {
    src: 'The mitochondria generate adenosine triphosphate through oxidative phosphorylation.',
    note: '现役把 mitochondria 弄丢了',
  },
  { src: 'To the best of our knowledge, this is the first such attempt.', note: '日常学术表达，现役译得不错' },
  { src: 'Could you let me know whether the meeting has been moved to Friday?', note: '日常英文对照' },
];

/* ------------------------------------------------------------- 下载 */

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** 用 HF 的 API 拿文件清单与大小，别去猜文件名 */
async function listFiles(repo, proxy) {
  const urls = [
    `https://hf-mirror.com/api/models/${repo}?blobs=true`,
    `https://huggingface.co/api/models/${repo}?blobs=true`,
  ];
  let lastErr = null;
  for (const url of urls) {
    for (const useProxy of [null, proxy]) {
      try {
        const { res } = await request(url, { proxy: useProxy });
        const chunks = [];
        for await (const c of res) chunks.push(c);
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return (json.siblings || []).map((s) => ({ path: s.rfilename, size: s.size || 0 }));
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw new Error(`取不到 ${repo} 的文件清单：${lastErr?.message}`);
}

/** 除权重外，配置与分词器文件都要 */
const isAux = (f) => /\.(json|txt|spm|model)$/.test(f) && !f.includes('/');

async function plan(key, proxy) {
  const c = CANDIDATES[key];
  const all = await listFiles(c.repo, proxy);
  const want = all.filter((f) => (isAux(f.path) || f.path.startsWith('onnx/')) && c.keep(f.path));
  return { ...c, key, files: want, bytes: want.reduce((s, f) => s + f.size, 0) };
}

async function download(key, proxy) {
  const p = await plan(key, proxy);
  const out = path.join(MODEL_DIR, p.repo);
  console.log(`\n下载 ${p.label}  共 ${p.files.length} 个文件 / ${mb(p.bytes)}`);
  console.log(`  → ${out}\n`);

  for (const f of p.files) {
    const dest = path.join(out, f.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && (await fsp.stat(dest)).size === f.size && f.size > 0) {
      console.log(`  ✓ 已存在  ${f.path}`);
      continue;
    }

    const mirrors = [
      `https://hf-mirror.com/${p.repo}/resolve/main/${f.path}`,
      `https://huggingface.co/${p.repo}/resolve/main/${f.path}`,
    ];
    let ok = false;
    let lastErr = null;
    for (const url of mirrors) {
      for (const useProxy of [null, proxy]) {
        try {
          const { res, total } = await request(url, { proxy: useProxy });
          let got = 0;
          let tick = 0;
          const t0 = Date.now();
          res.on('data', (ch) => {
            got += ch.length;
            const now = Date.now();
            if (now - tick > 500) {
              tick = now;
              const pct = total ? ((got / total) * 100).toFixed(0) : '?';
              const kbs = (got / 1024 / ((now - t0) / 1000)).toFixed(0);
              process.stdout.write(`\r    ${f.path}  ${mb(got)}/${mb(total)}  ${pct}%  ${kbs} KB/s   `);
            }
          });
          await streamPipeline(res, fs.createWriteStream(`${dest}.part`));
          process.stdout.write(`\r${' '.repeat(88)}\r`);
          await fsp.rename(`${dest}.part`, dest);
          console.log(`  ✓ ${f.path}  ${mb((await fsp.stat(dest)).size)}`);
          ok = true;
          break;
        } catch (e) {
          lastErr = e;
          await fsp.rm(`${dest}.part`, { force: true });
        }
      }
      if (ok) break;
    }
    if (!ok) throw new Error(`${f.path} 下载失败：${lastErr?.message}`);
  }
  console.log(`\n${p.label} 就绪`);
}

/* ------------------------------------------------------------- 评测 */

function present(key) {
  const dir = path.join(MODEL_DIR, CANDIDATES[key].repo, 'onnx');
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.endsWith('.onnx'));
}

async function run(only) {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.localModelPath = MODEL_DIR;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;

  const keys = Object.keys(CANDIDATES).filter((k) => (!only || k === only) && present(k));
  if (!keys.length) {
    console.error('本地没有可评测的模型，先运行 --fetch <id>');
    process.exit(1);
  }
  console.log(`评测：${keys.map((k) => CANDIDATES[k].label).join('、')}\n`);

  const results = new Map();
  for (const key of keys) {
    const c = CANDIDATES[key];
    process.stdout.write(`加载 ${c.label} …`);
    const t0 = Date.now();
    let call;
    try {
      if (c.kind === 'seq2seq') {
        const pipe = await pipeline('translation', c.repo, { dtype: c.dtype });
        call = async (text) => {
          const out = await pipe(text, {
            ...(c.opts || {}),
            // 与 translate-worker.js 的 budgetFor 保持一致，否则会误把截断当成模型缺陷
            max_new_tokens: Math.max(96, Math.min(512, text.split(/\s+/).length * 3 + 48)),
          });
          return Array.isArray(out) ? out[0]?.translation_text : out?.translation_text;
        };
      } else {
        const pipe = await pipeline('text-generation', c.repo, { dtype: c.dtype });
        call = async (text) => {
          /* 指令模型要压住它的话痨倾向，否则会附上解释和注音。
             系统提示写死「只输出译文」，实测能显著减少多余内容。 */
          const messages = [
            { role: 'system', content: '你是专业的学术翻译。把用户给的英文准确译成简体中文，专业术语用学界通用译名，数字与单位必须原样保留。只输出译文，不要任何解释。' },
            { role: 'user', content: text },
          ];
          const out = await pipe(messages, {
            max_new_tokens: Math.min(512, text.split(/\s+/).length * 3 + 32),
            do_sample: false,
          });
          const gen = out[0]?.generated_text;
          if (Array.isArray(gen)) return String(gen.at(-1)?.content || '').trim();
          return String(gen || '').trim();
        };
      }
      console.log(` ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log(` 失败：${e.message}`);
      continue;
    }

    const rows = [];
    for (const [i, c2] of CASES.entries()) {
      const t = Date.now();
      let text = '';
      try {
        text = await call(c2.src);
      } catch (e) {
        text = `【出错：${e.message}】`;
      }
      const ms = Date.now() - t;
      rows.push({ ms, text });
      process.stdout.write(`\r  ${i + 1}/${CASES.length}  ${ms}ms      `);
    }
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
    results.set(key, rows);
  }

  /* ---- 并排输出 ---- */
  console.log('\n' + '='.repeat(96));
  for (const [i, c2] of CASES.entries()) {
    console.log(`\n【${i + 1}】 ${c2.src}`);
    console.log(`      （${c2.note}）`);
    for (const key of keys) {
      const r = results.get(key)?.[i];
      if (!r) continue;
      console.log(`  ${CANDIDATES[key].label.padEnd(26)} ${String(r.ms).padStart(6)}ms  ${r.text}`);
    }
  }

  console.log('\n' + '='.repeat(96));
  console.log('\n平均耗时与磁盘占用：');
  for (const key of keys) {
    const rows = results.get(key);
    if (!rows) continue;
    const avg = Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length);
    let bytes = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else bytes += fs.statSync(p).size;
      }
    };
    walk(path.join(MODEL_DIR, CANDIDATES[key].repo));
    console.log(`  ${CANDIDATES[key].label.padEnd(26)} ${String(avg).padStart(6)}ms/句   ${mb(bytes)}`);
  }
}

/* ------------------------------------------------------------- 入口 */

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

if (argv.includes('--probe')) {
  const proxy = proxyUrl();
  console.log('各候选的下载量（只算配置 + 选定精度的权重）：\n');
  for (const key of Object.keys(CANDIDATES)) {
    try {
      const p = await plan(key, proxy);
      const have = present(key) ? '  [本地已有]' : '';
      console.log(`  ${key.padEnd(8)} ${p.label.padEnd(28)} ${mb(p.bytes).padStart(10)}  ${p.files.length} 个文件${have}`);
      for (const f of p.files.filter((f) => f.path.startsWith('onnx/'))) {
        console.log(`           ${f.path}  ${mb(f.size)}`);
      }
    } catch (e) {
      console.log(`  ${key.padEnd(8)} 探测失败：${e.message}`);
    }
  }
} else if (arg('--fetch')) {
  const key = arg('--fetch');
  if (!CANDIDATES[key]) {
    console.error(`未知候选 ${key}，可选：${Object.keys(CANDIDATES).join(' / ')}`);
    process.exit(1);
  }
  await download(key, proxyUrl());
} else if (argv.includes('--run')) {
  await run(arg('--only'));
} else {
  console.log('用法：--probe | --fetch <id> | --run [--only <id>]');
  console.log(`候选：${Object.keys(CANDIDATES).join(' / ')}`);
}
