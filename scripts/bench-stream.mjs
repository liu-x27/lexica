#!/usr/bin/env node
/**
 * 字幕基准：把公开测试集（MCIF 的 21 场 ACL 演讲，见 fetch-bench.mjs）按实时节奏
 * 喂进实时字幕的流水线，跑完用 bench-score.py 打分。
 *
 *   npm run bench -- --mt opus                     现役配置：CPU 识别 + opus
 *   npm run bench -- --mt hymt7b                   换成 Hy-MT2-7B（llama-server）
 *   npm run bench -- --mt hymt7b --asr-bin <dir>   识别换成另一个 whisper.cpp 构建（如 CUDA 版）
 *   npm run bench -- --mt opus --talks 2           只跑前两场（试跑用）
 *   npm run bench -- --mt opus --score             跑完接着打分（要 Python 环境，见 README）
 *
 * 真正喂音频的是应用自己（LEXICA_BENCH 模式，src/main/bench.js）：同一个 VadChunker、
 * 同一个识别队列、同一个翻译路由、同一个流水账，这里只负责拉起 Electron、记录机器信息、
 * 盯着显卡。按实时节奏跑，21 场一共约 2 小时；中途断了重跑同一条命令，跑完的场次会跳过。
 *
 * 其他参数：
 *   --name <名字>       输出到 dist/bench/<名字>，默认按配置起名
 *   --speed <倍数>      默认 1。只看质量可以加快，但带计算耗时的延迟（CA）就不能用了
 *   --no-rolling        关掉滚动字幕（它另占一个识别服务和 4 个核）
 *   --title <课程名>    每场的课程名，会拼进识别提示词；默认 ACL research talk
 *   --llama-dir <dir>   llama-server.exe 所在目录（等同 LEXICA_LLAMA_DIR）
 *   --data <dir>        别的测试集整理好的目录（结构同 fetch-bench.mjs 的 prepared/）
 *   --cpu-only          对应用藏起显卡（CUDA_VISIBLE_DEVICES=-1）：llama-server 退回 CPU，
 *                       量「没有独显的机器」上的表现。CUDA 版的 whisper 也会退回 CPU
 *   --allow-shared-gpu  显卡上已经有别的计算进程时照样跑（默认拒绝：别人的时延会被我们拖慢，
 *                       我们的也会被别人拖慢）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);

// 换一套测试集（或者试跑用的小样）时用 --data 指向它整理好的目录
const PREPARED = path.resolve(arg('--data', path.join(ROOT, 'data', 'bench', 'mcif', 'prepared')));

const mt = arg('--mt', 'opus');
const asrBin = arg('--asr-bin');
const llamaDir = arg('--llama-dir', process.env.LEXICA_LLAMA_DIR || null);
const speed = Number(arg('--speed', '1'));
const nTalks = arg('--talks') ? Number(arg('--talks')) : null;
const rolling = !flag('--no-rolling');
const cpuOnly = flag('--cpu-only');
const asrTag = asrBin ? path.basename(path.resolve(asrBin)) : 'cpu';
const name = arg('--name', `${mt}-${asrTag}${cpuOnly ? '-cpuonly' : ''}`
  + `${rolling ? '' : '-norolling'}${speed !== 1 ? `-x${speed}` : ''}`);
const outDir = path.join(ROOT, 'dist', 'bench', name);

const talksFile = path.join(PREPARED, 'talks.json');
if (!fs.existsSync(talksFile)) {
  console.error(`没有整理好的测试集：${path.relative(ROOT, talksFile)}\n先运行 npm run fetch:bench`);
  process.exit(2);
}
if (!(speed > 0)) { console.error('--speed 要是正数'); process.exit(2); }

/** 显卡此刻的占用率和已用显存（MiB）；nvidia-smi 不在就是 null */
function gpuNow() {
  try {
    const [util, mem] = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used',
      '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 15000 }).trim().split(/,\s*/).map(Number);
    return { util, mem };
  } catch {
    return null;
  }
}

/**
 * 看上去在做计算的进程。Windows（WDDM）上 --query-compute-apps 会把每个开着
 * 显卡上下文的程序都列出来（资源管理器、浏览器、聊天软件），没法拿它判断「有没有人在算」，
 * 只按进程名挑出常见的几个给人看。
 */
function computeLike() {
  try {
    return execFileSync('nvidia-smi', ['--query-compute-apps=pid,process_name', '--format=csv,noheader'],
      { encoding: 'utf8', timeout: 15000 }).split(/\r?\n/)
      .filter((l) => /python|llama|whisper|ollama|torch|comet/i.test(l)).map((l) => l.trim());
  } catch {
    return [];
  }
}

function gpuName() {
  try {
    return execFileSync('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
      { encoding: 'utf8', timeout: 15000 }).trim();
  } catch {
    return null;
  }
}

/* 这一轮会不会用显卡：Hy-MT2（llama-server -ngl 999）一定用；换了识别构建的，
   多半是 CUDA 版。用的话先看一眼，显卡在忙就停——别人的时延会被我们拖慢，
   我们的也会被别人拖慢。判据是占用率和显存，不是进程列表（理由见 computeLike）。
   空闲时本机桌面程序常驻约 2.5GB 显存、占用率个位数。 */
const usesGpu = !cpuOnly && (mt.startsWith('hymt') || !!asrBin);
const BUSY = { util: 20, mem: 4500 };
if (usesGpu) {
  const g = gpuNow();
  if (g && (g.util > BUSY.util || g.mem > BUSY.mem) && !flag('--allow-shared-gpu')) {
    console.error(`显卡在忙（占用 ${g.util}%，显存 ${g.mem} MiB），这一轮要用显卡，先不跑。`);
    for (const a of computeLike()) console.error(`  可能是：${a}`);
    console.error('等它空下来，或者确认可以共用后加 --allow-shared-gpu。');
    process.exit(3);
  }
}

const prepared = JSON.parse(fs.readFileSync(talksFile, 'utf8'));
const talks = (nTalks ? prepared.talks.slice(0, nTalks) : prepared.talks).map((t) => ({ id: t.id, wav: t.wav }));

fs.mkdirSync(outDir, { recursive: true });
const plan = {
  outDir,
  speed,
  // 每场的课程名：应用会把它拼进识别提示词（Lecture: <课程名>.），和真实上课一样
  title: arg('--title', 'ACL research talk'),
  settings: {
    asrModel: 'small',          // 应用默认：small + beam5 + 领域提示词
    lectureMtModel: mt,
    mtOnline: false,
    lectureRolling: rolling,
  },
  talks,
};
const planPath = path.join(outDir, 'plan.json');
fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

let commit = null;
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* 不是仓库 */ }
let dirty = null;
try { dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0; } catch { /* 忽略 */ }
fs.writeFileSync(path.join(outDir, 'machine.json'), `${JSON.stringify({
  startedAt: new Date().toISOString(),
  set: prepared.set,
  talks: talks.length,
  mt,
  asrBin: asrBin ? path.resolve(asrBin) : null,
  llamaDir: llamaDir ? path.resolve(llamaDir) : null,
  speed,
  rolling,
  cpuOnly,
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  ramGB: +(os.totalmem() / 2 ** 30).toFixed(1),
  gpu: gpuName(),
  os: `${os.type()} ${os.release()}`,
  node: process.version,
  commit,
  dirty,
}, null, 2)}\n`);

const totalSec = prepared.talks.filter((t) => talks.some((x) => x.id === t.id)).reduce((s, t) => s + t.seconds, 0);
console.log(`基准：${talks.length} 场，音频 ${(totalSec / 60).toFixed(1)} 分钟，${speed} 倍速，翻译 ${mt}`
  + `${asrBin ? `，识别构建 ${asrBin}` : ''}${rolling ? '' : '，不开滚动字幕'}`);
console.log(`输出：${path.relative(ROOT, outDir)}（中途断了重跑同一条命令即可接着跑）\n`);

/* 显卡每 5 秒记一次：证明识别/翻译真的在显卡上跑，也看得出中途有没有别人来抢 */
const gpuLog = path.join(outDir, 'gpu.csv');
let gpuTimer = null;
if (gpuNow() !== null) {
  if (!fs.existsSync(gpuLog)) fs.writeFileSync(gpuLog, 'time,util_pct,mem_used_mib,compute_like\n');
  gpuTimer = setInterval(() => {
    const g = gpuNow();
    if (!g) return;   // 偶尔超时就跳过这一拍
    const apps = computeLike().map((a) => path.basename(a.split(',')[1]?.trim() || '')).join(' ');
    fs.appendFileSync(gpuLog, `${new Date().toISOString()},${g.util},${g.mem},${apps}\n`);
  }, 5000);
}

const log = fs.createWriteStream(path.join(outDir, 'electron.log'), { flags: 'a' });
const child = spawn(electron, [ROOT], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    LEXICA_BENCH: planPath,
    ...(llamaDir ? { LEXICA_LLAMA_DIR: path.resolve(llamaDir) } : {}),
    ...(asrBin ? { LEXICA_ASR_BIN: path.resolve(asrBin) } : {}),
    // 只能写 -1：设成空串时 CUDA 照样看得见显卡
    ...(cpuOnly ? { CUDA_VISIBLE_DEVICES: '-1' } : {}),
  },
});
const relay = (d) => {
  log.write(d);
  // 控制台只留每场的开始/结束和报错，逐句的 [lat] 在 electron.log 里
  for (const line of String(d).split(/\r?\n/)) {
    if (/\[bench\]|\[lecture\] 记录结束|失败|error|Error|\[mt-llama\] 就绪|\[asr\].*就绪/.test(line)) console.log(line);
  }
};
child.stdout.on('data', relay);
child.stderr.on('data', relay);

child.on('exit', (code) => {
  if (gpuTimer) clearInterval(gpuTimer);
  log.end();
  const progress = path.join(outDir, 'progress.jsonl');
  const done = fs.existsSync(progress)
    ? fs.readFileSync(progress, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const ok = done.filter((p) => p.kind === 'done').length;
  const bad = done.filter((p) => p.kind === 'error');
  console.log(`\nElectron 退出码 ${code}；本轮完成 ${ok} 场，失败 ${bad.length} 场`);
  for (const b of bad) console.log(`  ✗ ${b.id}：${b.message}`);
  if (code || !flag('--score')) process.exit(code || 0);

  const py = arg('--python', process.env.LEXICA_BENCH_PYTHON || 'python');
  const score = spawn(py, ['-I', path.join(ROOT, 'scripts', 'bench-score.py'), '--run', outDir,
    '--data', PREPARED, ...(flag('--xcomet') ? ['--xcomet'] : [])], { stdio: 'inherit' });
  score.on('exit', (c) => process.exit(c ?? 1));
});
