#!/usr/bin/env node
/**
 * 打安卓包。做三件事：把词库放进 assets、调 Gradle、报告产物。
 *
 * 词库不进版本库也不常驻 assets/：它有 383MB，留在那儿会让每次
 * Gradle 同步都去校验一遍，也容易误提交。构建时拷进去，位置对不上就直接报错。
 *
 * 用法：node scripts/build-apk.mjs [--debug]
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const SRC_DB = path.join(ROOT, 'data/dict-mobile-slim.db');
const DST_DB = path.join(ANDROID, 'app/src/main/assets/dict.db');

const debug = process.argv.includes('--debug');
const variant = debug ? 'Debug' : 'Release';

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/* ---- 1. 词库 ---- */
if (!fs.existsSync(SRC_DB)) {
  console.error(`找不到移动版词库：${path.relative(ROOT, SRC_DB)}`);
  console.error('  → 先运行 npm run build:db:mobile');
  process.exit(1);
}

const src = fs.statSync(SRC_DB);
const needCopy = !fs.existsSync(DST_DB) || fs.statSync(DST_DB).size !== src.size;
if (needCopy) {
  console.log(`拷贝词库 ${mb(src.size)} → assets/dict.db …`);
  fs.mkdirSync(path.dirname(DST_DB), { recursive: true });
  fs.copyFileSync(SRC_DB, DST_DB);
} else {
  console.log(`词库已就位（${mb(src.size)}）`);
}

/* ---- 2. Gradle ---- */
console.log(`\n构建 ${variant} …\n`);
try {
  /* 必须经 shell：Node 18.20 / 20.12 起（修 CVE-2024-27980）不再允许不经 shell
     直接 spawn .bat / .cmd，否则这里会以 EINVAL 失败。
     参数直接拼进命令字符串，不走 args 数组——shell 模式下 args 本来就是拼接而非
     转义，分开传只会多一条 DEP0190 警告。这里的参数全是写死的常量。 */
  execSync(`"${path.join(ANDROID, 'build.bat')}" :app:assemble${variant} --no-daemon`, {
    stdio: 'inherit',
    cwd: ANDROID,
  });
} catch {
  console.error('\nGradle 构建失败，上面有具体原因。');
  process.exit(1);
}

/* ---- 3. 产物 ---- */
const outDir = path.join(ANDROID, 'app/build/outputs/apk', debug ? 'debug' : 'release');
const apk = fs.readdirSync(outDir).find((f) => f.endsWith('.apk'));
if (!apk) {
  console.error(`构建报告成功，但 ${path.relative(ROOT, outDir)} 里没有 apk`);
  process.exit(1);
}
const p = path.join(outDir, apk);
console.log(`\n完成：${path.relative(ROOT, p)}  ${mb(fs.statSync(p).size)}`);
console.log('用 adb install -r 这个文件，或直接传到手机上安装。');
