/**
 * 开发截图：把界面按脚本走一遍，逐张截图到指定目录。
 *
 * 真正的流程在 src/main/index.js 的 runShotSequence()，这里只是把环境变量设好
 * 再拉起 Electron——手敲 `LEXICA_SHOT=<目录> electron .` 完全等价，加这个入口
 * 只是因为那两个环境变量不写在任何地方，隔一阵就没人记得截图模式存在。
 *
 *   node scripts/shot.mjs                      → dist/shots
 *   node scripts/shot.mjs docs/screenshots     → 指定目录
 *   node scripts/shot.mjs out --audio a.wav    → 连实时字幕、视频字幕悬浮窗一起截
 *
 * --audio 要一段 16k 单声道 wav。没有它就跳过 35~40 那几张：麦克风在自动化里
 * 喂不了，实时字幕那条链路只能靠喂真实语音走通。
 *
 * 跑的时候别动鼠标键盘：capturePage 拿的是「最后呈现的那一帧」，主窗口被别的
 * 窗口盖住时合成器干脆不产新帧，抓到的就是旧帧（runShotSequence 会把这种情况
 * 报成「与上一张字节完全相同」并以非零码退出）。
 *
 * 常驻托盘的正式 Lexica 不用退。截图模式跳过单实例锁、userData 指向临时目录，
 * 不会碰到真实生词本。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `用法: npm run shot -- [输出目录] [--audio <16k 单声道 wav>]

  npm run shot                                     → dist/shots
  npm run shot -- docs/screenshots --audio a.wav   → 连实时字幕、悬浮字幕一起截`;

/* 参数解析得严一点：把没认出来的 --flag 当成输出目录会直接建出一个叫 `--help`
   的目录并跑完整整一轮（八分钟），而不是立刻报错。踩过。 */
const argv = process.argv.slice(2);
let audio = null;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--audio') {
    audio = argv[++i];
    if (!audio) { console.error('--audio 后面要跟文件路径\n\n' + USAGE); process.exit(2); }
  } else if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a.startsWith('-')) {
    console.error(`不认识的参数：${a}\n\n${USAGE}`);
    process.exit(2);
  } else {
    rest.push(a);
  }
}
if (rest.length > 1) {
  console.error(`只接受一个输出目录，收到 ${rest.length} 个\n\n${USAGE}`);
  process.exit(2);
}
const outDir = path.resolve(ROOT, rest[0] || path.join('dist', 'shots'));

if (audio && !fs.existsSync(audio)) {
  console.error(`找不到音频：${audio}`);
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
console.log(`截图输出：${outDir}`);
console.log(audio ? `实时字幕音频：${path.resolve(audio)}` : '未给 --audio，跳过实时字幕相关截图');

const child = spawn(electron, [ROOT], {
  stdio: 'inherit',
  env: {
    ...process.env,
    LEXICA_SHOT: outDir,
    ...(audio ? { LEXICA_SHOT_AUDIO: path.resolve(audio) } : {}),
  },
});

child.on('exit', (code) => {
  const n = fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).length;
  console.log(`\n${n} 张，退出码 ${code}`);
  // runShotSequence 抓到旧帧时会以 1 退出：截图存在但内容是上一步的，不能直接用
  if (code) console.error('非零退出：有截图抓到了旧帧或流程中途出错，别直接拿去用');
  process.exit(code ?? 1);
});
