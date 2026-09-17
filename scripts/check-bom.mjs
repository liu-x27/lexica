/**
 * 校验（并按需修复）.ps1 文件的 UTF-8 BOM。
 *
 * PowerShell 5.1 读取没有 BOM 的 .ps1 时按系统 ANSI 代码页（中文机器上是 GBK）解码，
 * 文件里的中文注释会被解成乱码字节，轻则注释花掉，重则把字符串引号拆断导致整个脚本
 * 解析失败——而且报错位置指向别处，很难往编码上想。这个坑踩过不止一次，
 * 所以放进构建与测试里自动校验。
 *
 *   node scripts/check-bom.mjs        只检查，有问题就非零退出
 *   node scripts/check-bom.mjs --fix  就地补上 BOM
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const fix = process.argv.includes('--fix');

/** 递归收集 .ps1，跳过 node_modules 与产物目录 */
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'data' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.ps1')) out.push(p);
  }
  return out;
}

const files = collect(ROOT);
const bad = [];

for (const f of files) {
  const buf = fs.readFileSync(f);
  if (buf.subarray(0, 3).equals(BOM)) continue;
  bad.push(f);
  if (fix) {
    fs.writeFileSync(f, Buffer.concat([BOM, buf]));
    console.log(`已补 BOM: ${path.relative(ROOT, f)}`);
  }
}

if (!bad.length) {
  console.log(`BOM 检查通过（${files.length} 个 .ps1）`);
  process.exit(0);
}

if (fix) process.exit(0);

console.error('以下 .ps1 缺少 UTF-8 BOM，PowerShell 5.1 会按 GBK 解码：');
for (const f of bad) console.error(`  ${path.relative(ROOT, f)}`);
console.error('\n运行 node scripts/check-bom.mjs --fix 修复');
process.exit(1);
