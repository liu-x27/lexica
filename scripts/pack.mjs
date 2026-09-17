/**
 * 手工打包免安装绿色版。
 *
 * 不用 electron-builder：它在本机会因 winCodeSign 解压需要创建符号链接而失败
 * （需要管理员权限或开发者模式）。这里直接复制 Electron 运行时并组装 app 目录，
 * 产出 dist/Lexica-win-x64/，双击 Lexica.exe 即可运行。
 *
 *   node scripts/pack.mjs              连词库一起打包（约 1.3 GB）
 *   node scripts/pack.mjs --no-db      不含词库，首次运行时提示用户放入
 *   node scripts/pack.mjs --keep-locales   保留全部语言包
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist');
const APP_NAME = 'Lexica';
const TARGET = path.join(OUT_DIR, `${APP_NAME}-win-x64`);

const withDb = !process.argv.includes('--no-db');
const keepLocales = process.argv.includes('--keep-locales');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const mb = (n) => (n / 1024 / 1024).toFixed(0).padStart(5) + ' MB';

/* ------------------------------------------------------------------ 工具 */

async function dirSize(dir) {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await fsp.stat(p)).size;
  }
  return total;
}

/** 带进度的大文件复制（词库 1.2 GB，静默复制会让人以为卡死） */
async function copyBig(src, dest, label) {
  const total = (await fsp.stat(src)).size;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const rs = fs.createReadStream(src, { highWaterMark: 8 << 20 });
  const ws = fs.createWriteStream(dest);
  let done = 0;
  let tick = 0;
  rs.on('data', (c) => {
    done += c.length;
    const now = Date.now();
    if (now - tick > 400) {
      tick = now;
      process.stdout.write(`\r    ${label} ${mb(done)} / ${mb(total)}  ${((done / total) * 100).toFixed(0)}%   `);
    }
  });
  await new Promise((res, rej) => {
    rs.pipe(ws);
    ws.on('finish', res);
    ws.on('error', rej);
    rs.on('error', rej);
  });
  process.stdout.write('\r' + ' '.repeat(70) + '\r');
  console.log(`    ${label} ${mb(total)} 完成`);
}

/* -------------------------------------------------- 翻译依赖的裁剪复制 */

/**
 * 不需要打进产物的包。
 * 注意 onnxruntime-common 是 onnxruntime-node 的依赖，不能跳——
 * 一开始误把它一起排除了，打包版启动就报 Cannot find module 'onnxruntime-common'。
 */
const DEP_SKIP = new Set([
  // 我们走 onnxruntime-node 原生后端，浏览器的 WASM 版用不到（实测移走仍能正常翻译，省 128MB）
  'onnxruntime-web',
]);

/** 收集一个包的传递依赖（只看 dependencies，devDependencies 不进产物） */
function collectDeps(root, names, seen = new Set()) {
  for (const name of names) {
    if (seen.has(name) || DEP_SKIP.has(name)) continue;
    const dir = path.join(root, 'node_modules', name);
    if (!fs.existsSync(dir)) continue;
    seen.add(name);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const next = [
        ...Object.keys(pkg.dependencies || {}),
        // 可选依赖多是各平台的原生包，只跟当前平台那个
        ...Object.keys(pkg.optionalDependencies || {}).filter((d) => d.includes('win32') || !d.match(/darwin|linux|android/)),
      ];
      collectDeps(root, next, seen);
    } catch { /* 没有 package.json 就当叶子 */ }
  }
  return seen;
}

/** 复制翻译所需依赖，并裁掉非 win32-x64 的原生二进制 */
async function copyTranslatorDeps(appDir) {
  console.log('    复制翻译依赖…');
  const deps = collectDeps(ROOT, ['@huggingface/transformers']);
  const destRoot = path.join(appDir, 'node_modules');

  for (const name of deps) {
    const from = path.join(ROOT, 'node_modules', name);
    const to = path.join(destRoot, name);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.cp(from, to, { recursive: true });
  }

  // onnxruntime-node 自带四个平台的二进制，只留 win32/x64（其余 150MB 是白搭）
  const napi = path.join(destRoot, 'onnxruntime-node', 'bin', 'napi-v6');
  if (fs.existsSync(napi)) {
    for (const plat of await fsp.readdir(napi)) {
      if (plat !== 'win32') {
        await fsp.rm(path.join(napi, plat), { recursive: true, force: true });
        continue;
      }
      const archDir = path.join(napi, plat);
      for (const arch of await fsp.readdir(archDir)) {
        if (arch !== 'x64') await fsp.rm(path.join(archDir, arch), { recursive: true, force: true });
      }
    }
  }

  const size = await dirSize(destRoot);
  console.log(`    翻译依赖 ${deps.size} 个包，${mb(size)}`);
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log(`${APP_NAME} 免安装版打包\n`);

  const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(electronDist)) {
    throw new Error('找不到 Electron 运行时，先执行 npm install');
  }

  const dbSrc = path.join(ROOT, 'data', 'dict.db');
  if (withDb && !fs.existsSync(dbSrc)) {
    throw new Error('找不到 data/dict.db，先执行 npm run data，或加 --no-db 跳过');
  }

  // 1. 清理并复制 Electron 运行时
  //    只保留 resources/data（词库 800MB+，复制一次就够，反复打包不必重来）
  console.log('[1/6] 复制 Electron 运行时…');
  if (fs.existsSync(TARGET)) {
    for (const e of await fsp.readdir(TARGET)) {
      if (e === 'resources') continue;
      await fsp.rm(path.join(TARGET, e), { recursive: true, force: true });
    }
    const resDir = path.join(TARGET, 'resources');
    if (fs.existsSync(resDir)) {
      for (const e of await fsp.readdir(resDir)) {
        if (e === 'data') continue;
        await fsp.rm(path.join(resDir, e), { recursive: true, force: true });
      }
    }
  }
  await fsp.mkdir(TARGET, { recursive: true });
  await fsp.cp(electronDist, TARGET, { recursive: true, force: true });

  // 2. 改名为应用名
  console.log('[2/6] 重命名可执行文件…');
  const exeSrc = path.join(TARGET, 'electron.exe');
  const exeDest = path.join(TARGET, `${APP_NAME}.exe`);
  if (fs.existsSync(exeSrc)) await fsp.rename(exeSrc, exeDest);

  // 3. 精简语言包（Electron 默认带 50+ 个 pak，占 ~10MB）
  if (!keepLocales) {
    console.log('[3/6] 精简语言包…');
    const localeDir = path.join(TARGET, 'locales');
    const keep = new Set(['en-US.pak', 'zh-CN.pak']);
    let removed = 0;
    for (const f of await fsp.readdir(localeDir)) {
      if (!keep.has(f)) { await fsp.rm(path.join(localeDir, f)); removed++; }
    }
    console.log(`    移除 ${removed} 个语言包`);
  } else {
    console.log('[3/6] 保留全部语言包');
  }

  // 4. 组装 app 目录（不用 asar，方便用户查看与改动）
  // 划词辅助脚本含中文，没有 BOM 的话 PowerShell 5.1 会按 GBK 解码直接解析失败
  console.log('[4/6] 组装应用代码…');
  {
    const check = path.join(ROOT, 'scripts', 'check-bom.mjs');
    if (fs.existsSync(check)) {
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync(process.execPath, ['--no-warnings', check], { stdio: 'pipe' });
      } catch {
        throw new Error('有 .ps1 缺少 UTF-8 BOM，先运行 node scripts/check-bom.mjs --fix');
      }
    }
  }
  const appDir = path.join(TARGET, 'resources', 'app');
  await fsp.mkdir(appDir, { recursive: true });
  await fsp.cp(path.join(ROOT, 'src'), path.join(appDir, 'src'), { recursive: true });

  const assetsSrc = path.join(ROOT, 'assets');
  if (fs.existsSync(assetsSrc)) {
    await fsp.cp(assetsSrc, path.join(appDir, 'assets'), { recursive: true });
  }

  /* 词典本身运行时零依赖（SQLite 走内置 node:sqlite），
     但机器翻译的工作进程需要 transformers.js 及其依赖。
     只在装了模型时才复制，并且只留 win32-x64 的原生二进制。 */
  if (fs.existsSync(path.join(ROOT, 'data', 'model'))) {
    await copyTranslatorDeps(appDir);
  }

  const runtimePkg = {
    name: pkg.name,
    productName: APP_NAME,
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    author: pkg.author || '',
  };
  await fsp.writeFile(path.join(appDir, 'package.json'), JSON.stringify(runtimePkg, null, 2), 'utf8');

  // 5. 词库
  if (withDb) {
    console.log('[5/6] 复制词库…');
    const dbDest = path.join(TARGET, 'resources', 'data', 'dict.db');
    const srcStat = await fsp.stat(dbSrc);
    let same = false;
    try {
      const d = await fsp.stat(dbDest);
      same = d.size === srcStat.size && d.mtimeMs >= srcStat.mtimeMs;
    } catch { /* 目标不存在 */ }
    if (same) console.log('    已是最新，跳过复制');
    else await copyBig(dbSrc, dbDest, 'dict.db');

    /* 翻译模型与语音识别组件都是可选的，装了才打包。
       按目录总字节比对来决定跳不跳——这两个目录加起来能有 1.2GB，
       每次打包都重新复制太慢。 */
    for (const [name, label] of [['model', '翻译模型'], ['asr', '语音识别组件']]) {
      const src = path.join(ROOT, 'data', name);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(TARGET, 'resources', 'data', name);
      const srcSize = await dirSize(src);
      let destSize = 0;
      try { destSize = await dirSize(dest); } catch { /* 不存在 */ }
      if (destSize === srcSize) {
        console.log(`    ${label}已是最新，跳过`);
      } else {
        await fsp.rm(dest, { recursive: true, force: true });
        await fsp.cp(src, dest, { recursive: true });
        console.log(`    ${label} ${mb(srcSize)} 完成`);
      }
    }
  } else {
    console.log('[5/6] 跳过词库（--no-db）');
    await fsp.mkdir(path.join(TARGET, 'resources', 'data'), { recursive: true });
    await fsp.writeFile(
      path.join(TARGET, 'resources', 'data', '把 dict.db 放在这里.txt'),
      ['本目录需要放入 dict.db 才能查词。',
       '',
       '生成方式：在项目源码目录执行',
       '  npm run fetch',
       '  npm run build:db',
       '然后把 data/dict.db 复制到本目录。',
      ].join('\r\n'),
      'utf8',
    );
  }

  // 6. 图标与版本信息
  console.log('[6/6] 写入图标与版本信息…');

  // 图标不存在就先生成（需要 Electron 栅格化，nativeImage 不认 SVG）
  const icoPath = path.join(ROOT, 'assets', 'icon.ico');
  if (!fs.existsSync(icoPath)) {
    console.log('    图标不存在，先生成…');
    try {
      const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
      await new Promise((res, rej) => {
        const cp = spawn(electronBin, [path.join(ROOT, 'scripts', 'make-icon.js')], { stdio: 'inherit' });
        cp.on('exit', (code) => (code === 0 ? res() : rej(new Error(`make-icon 退出码 ${code}`))));
        cp.on('error', rej);
      });
      // 生成到源码 assets/，同步一份到打包目录
      for (const f of ['icon.ico', 'tray.png']) {
        const src = path.join(ROOT, 'assets', f);
        if (fs.existsSync(src)) await fsp.copyFile(src, path.join(appDir, 'assets', f));
      }
    } catch (e) {
      console.log(`    图标生成失败（${e.message}），继续打包`);
    }
  }

  try {
    // rcedit 5.x 是 ESM，require() 拿不到，用动态 import；
    // 包名历史上有 rcedit 与 @electron/rcedit 两种，哪个装了用哪个。
    let mod;
    try { mod = await import('rcedit'); } catch { mod = await import('@electron/rcedit'); }
    // 5.x 只导出具名的 rcedit，没有 default 导出
    const rcedit = mod.rcedit || mod.default || mod;
    if (typeof rcedit !== 'function') throw new Error('rcedit 导出形状不符合预期');
    await rcedit(exeDest, {
      'version-string': {
        CompanyName: 'Lexica',
        FileDescription: `${APP_NAME} 离线词典`,
        ProductName: APP_NAME,
        LegalCopyright: '词库数据版权归各开源项目所有',
        OriginalFilename: `${APP_NAME}.exe`,
      },
      'file-version': pkg.version,
      'product-version': pkg.version,
      ...(fs.existsSync(icoPath) ? { icon: icoPath } : {}),
    });
    console.log(`    已写入版本信息${fs.existsSync(icoPath) ? ' 与图标' : '（无图标）'}`);
  } catch (e) {
    console.log(`    跳过（${e.message}）—— exe 属性仍显示 Electron，不影响运行`);
  }

  // 附一个说明文件
  await fsp.writeFile(
    path.join(TARGET, '使用说明.txt'),
    [
      `${APP_NAME} 离线词典 v${pkg.version}`,
      '',
      '双击 Lexica.exe 启动，全部数据都在本地，不联网。',
      '',
      '快捷键',
      '  Ctrl+Alt+Space  在任何程序里唤起悬浮查词窗（可在设置里改）',
      '  Ctrl + K      聚焦搜索框',
      '  Ctrl + D      把当前词加入生词本',
      '  Alt + ←/→     前后翻查词历史',
      '  复习时 1/2/3/4 快速评分，空格显示释义',
      '',
      '数据来源',
      '  ECDICT       MIT 协议，释义 / 词频 / 考纲标签 / 词形变化',
      '  WordNet 3.1  Princeton WordNet License，义项与词汇网络',
      '  Tatoeba      CC BY 2.0 FR，例句与中英对照',
      '',
      '生词本与设置保存在：',
      '  %APPDATA%\\lexica\\',
    ].join('\r\n'),
    'utf8',
  );

  const size = await dirSize(TARGET);
  console.log(`\n打包完成：${TARGET}`);
  console.log(`  总体积 ${mb(size)}`);
  console.log(`  启动方式：双击 ${APP_NAME}.exe`);
}

main().catch((e) => {
  console.error('\n打包失败：', e.message);
  process.exit(1);
});
