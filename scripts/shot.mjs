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
 *   node scripts/shot.mjs out --online         → 临时打开在线翻译，验证那条通道
 *
 * --audio 要一段 16k 单声道 wav。没有它就跳过 35~40 那几张：麦克风在自动化里
 * 喂不了，实时字幕那条链路只能靠喂真实语音走通。
 *
 * 跑的时候可以照常用电脑：截图模式关了后台节流，窗口被盖住也照样出帧；最小化会被
 * 立刻还原。只是别在 Lexica 窗口里点东西、打字，会打乱脚本的步骤。万一某一步窗口
 * 没在出帧，runShotSequence 不存那张图、以非零码退出，不会拿旧画面冒充。
 * 截图模式还强制开了「减弱动效」，入场动画直接是终态——截出来的就是静止后的样子。
 *
 * 常驻托盘的正式 Lexica 不用退。截图模式跳过单实例锁、userData 指向临时目录，
 * 不会碰到真实生词本。临时目录**每次运行都是新建的**（tmp/lexica-shot-XXXX），
 * 两轮同时跑也互不干扰；想复用某个目录可以设 LEXICA_SHOT_PROFILE。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `用法: npm run shot -- [输出目录] [--audio <16k 单声道 wav>] [--online]

  npm run shot                                     → dist/shots
  npm run shot -- docs/screenshots --audio a.wav   → 连实时字幕、悬浮字幕一起截
  npm run shot -- dist/shots --online              → 临时开在线翻译验证那条通道

--online 只影响这一次运行，不写进设置。在线翻译平时默认关着，
而截图模式每次都是全新 profile，不给这个开关就永远验不到那条链路。`;

/* 参数解析得严一点：把没认出来的 --flag 当成输出目录会直接建出一个叫 `--help`
   的目录并跑完整整一轮（八分钟），而不是立刻报错。踩过。 */
const argv = process.argv.slice(2);
let audio = null;
let useOnline = false;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--audio') {
    audio = argv[++i];
    if (!audio) { console.error('--audio 后面要跟文件路径\n\n' + USAGE); process.exit(2); }
  } else if (a === '--online') {
    useOnline = true;
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
if (useOnline) console.log('在线翻译：本次临时开启（不写进设置）');

const child = spawn(electron, [ROOT], {
  stdio: 'inherit',
  env: {
    ...process.env,
    LEXICA_SHOT: outDir,
    ...(audio ? { LEXICA_SHOT_AUDIO: path.resolve(audio) } : {}),
    ...(useOnline ? { LEXICA_SHOT_ONLINE: '1' } : {}),
  },
});

child.on('exit', (code) => {
  const n = fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).length;
  console.log(`\n${n} 张，退出码 ${code}`);
  // runShotSequence 发现有截图不可信（旧帧或窗口没在出帧）时以 1 退出
  if (code) console.error('非零退出：有截图不可信或流程中途出错，别直接拿去用');
  process.exit(code ?? 1);
});
