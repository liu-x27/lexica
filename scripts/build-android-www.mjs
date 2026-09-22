#!/usr/bin/env node
/**
 * 组装安卓端的 assets/www。
 *
 * 原则：渲染层和查询层都**不复制粘贴**，一律从桌面版的源文件取。
 * 安卓独有的部分放在 android/www-src 下，两边合并出最终产物。
 * 手抄一份的话，改一处忘另一处只是时间问题。
 *
 *   src/renderer/{css,js}   →  www/{css,js}          原样复制
 *   android/www-src/**      →  www/**                原样复制（覆盖同名）
 *   src/main/*.js           →  www/js/core.js        包成 CommonJS 模块
 *
 * 用法：node scripts/build-android-www.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'android/app/src/main/assets/www');

/** 渲染层里要带过去的脚本，顺序与 index.html 里一致 */
const RENDERER_JS = [
  'ui.js', 'entry-view.js',
  /* 安卓没打包翻译模型，但这个文件仍然必须带上：
     从别的应用分享一整句进来时，走的就是长句结果页（术语对照 + 说明没有模型）。
     不带的话 app.js 调 Lx.renderSentence 会直接报 undefined。 */
  'translate-view.js',
  'drill.js', 'custom.js', 'views.js', 'app.js',
];

/** 打进 core.js 的共用模块。名字就是 require 时用的 id */
/* translate-online 和 sentence-split 是安卓在线翻译要的：
   两个都是纯 JS，不碰 Node / Electron 接口，WebView 里原样能跑。 */
const CORE_MODULES = ['dict-db', 'user-db', 'quiz', 'glossary', 'translate-online', 'sentence-split'];

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
}

function copyDir(from, to, filter = () => true) {
  let n = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    if (fs.statSync(src).isDirectory()) {
      const r = copyDir(src, path.join(to, name), filter);
      n += r.n;
      bytes += r.bytes;
    } else if (filter(name)) {
      bytes += copy(src, path.join(to, name));
      n++;
    }
  }
  return { n, bytes };
}

/**
 * 把 CommonJS 源文件包成注册调用。
 *
 * 源文件一个字都不改：包一层函数后，里面的 require / module / exports
 * 拿到的就是 cjs-runtime 提供的那套，和在 Node 里被 require 时形状一致。
 */
function wrapModule(name, source) {
  return [
    `/* ---- ${name} (来自 src/main/${name}.js，未经修改) ---- */`,
    `__cjs.define(${JSON.stringify(name)}, function (module, exports, require) {`,
    source,
    '});',
    '',
  ].join('\n');
}

/** 检查有没有 require 了我们没提供桩的 node 模块——漏一个就是运行时白屏 */
function checkRequires(name, source) {
  const known = new Set(['node:path', 'node:fs', 'node:sqlite', ...CORE_MODULES.map((m) => `./${m}`)]);
  const bad = [];
  for (const m of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!known.has(m[1])) bad.push(m[1]);
  }
  if (bad.length) {
    throw new Error(
      `src/main/${name}.js 里 require 了未提供桩的模块：${[...new Set(bad)].join('、')}\n` +
      '  → 在 android/www-src/js/cjs-runtime.js 里补上对应实现，或把该依赖从共用模块里拆走',
    );
  }
}

/* ------------------------------------------------------------------ */

console.log('组装 assets/www …\n');
reset(OUT);

/* 1. 桌面版的样式。quick.css 是悬浮查词窗专用的，手机上没有那个窗口 */
const css = copyDir(
  path.join(ROOT, 'src/renderer/css'),
  path.join(OUT, 'css'),
  (f) => f.endsWith('.css') && f !== 'quick.css',
);
console.log(`  样式      ${css.n} 个文件  ${(css.bytes / 1024).toFixed(0)} KB`);

/* 2. 桌面版的渲染脚本 */
let rendererBytes = 0;
for (const f of RENDERER_JS) {
  const src = path.join(ROOT, 'src/renderer/js', f);
  if (!fs.existsSync(src)) throw new Error(`缺少渲染脚本：${rel(src)}`);
  rendererBytes += copy(src, path.join(OUT, 'js', f));
}
console.log(`  渲染层    ${RENDERER_JS.length} 个文件  ${(rendererBytes / 1024).toFixed(0)} KB（与桌面版逐字节相同）`);

/* 3. 共用的查询层 / 用户数据层 / 出题引擎 */
const parts = [
  '/* 由 scripts/build-android-www.mjs 生成，请勿直接编辑。',
  '   内容来自 src/main/，桌面版与安卓版共用同一份实现。 */',
  '',
];
for (const name of CORE_MODULES) {
  const src = path.join(ROOT, 'src/main', `${name}.js`);
  const source = fs.readFileSync(src, 'utf8');
  checkRequires(name, source);
  parts.push(wrapModule(name, source));
}
const core = parts.join('\n');
fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'js/core.js'), core, 'utf8');
console.log(`  共用模块  ${CORE_MODULES.length} 个   ${(Buffer.byteLength(core) / 1024).toFixed(0)} KB → js/core.js`);

/* 4. 安卓独有的部分，放最后覆盖同名文件 */
const own = copyDir(path.join(ROOT, 'android/www-src'), OUT);
console.log(`  安卓专有  ${own.n} 个文件  ${(own.bytes / 1024).toFixed(0)} KB`);

/* 5. 自检：index.html 里引用的每个文件都要真的存在 */
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const missing = [];
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^\w+:/.test(m[1])) continue;
  if (!fs.existsSync(path.join(OUT, m[1]))) missing.push(m[1]);
}
if (missing.length) throw new Error(`index.html 引用了不存在的文件：${missing.join('、')}`);

let total = 0;
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else total += st.size;
  }
};
walk(OUT);

console.log(`\n完成：${rel(OUT)}  合计 ${(total / 1024).toFixed(0)} KB`);
