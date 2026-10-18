#!/usr/bin/env node
/**
 * 下载并整理字幕基准用的公开测试集：MCIF 里带中文参考译文的那 21 场 ACL 2023 演讲。
 *
 *   npm run fetch:bench             下载（约 217 MB）并整理到 data/bench/mcif/prepared/
 *   npm run fetch:bench -- --probe  只列出要下什么、多大
 *   npm run fetch:bench -- --prepare  不下载，只用已有的原始文件重新整理
 *
 * 来源和许可：
 *   - MCIF（FBK-MT/MCIF，CC-BY-4.0，Papi et al. 2025, arXiv 2507.19634）：
 *     100 场演讲里只有 21 场有转写和中文译文（约 2 小时），其余 79 场只做摘要。
 *     这里只下这 21 个 wav（16k 单声道）和两份参考（英文转写、中文译文）。
 *     版本钉在 HF 的提交 e24065b，每个文件按 LFS 记录的 sha256 核。
 *   - 句级时间戳：MCIF 本身不带。IWSLT 2025 同传赛道的基线仓库
 *     （pe-trik/iwslt25-baselines，data/mcif_translation.yaml）用重切分工具对齐出来的，
 *     919 段、21 场；该仓库没有声明许可证，所以只在本机用，不进版本库、不转发。
 *     IWSLT 2026 同传赛道的开发集就是 MCIF，按 LongYAAL 分档也用这套切分。
 *
 * 整理出的东西（scripts/bench-stream.mjs 和 bench-score.py 读它们）：
 *   prepared/talks.json     每场：id、wav 路径、时长、段数、英文转写参考（算 WER）
 *   prepared/segments.json  句级切分，和 YAML 同序（OmniSTEval 吃 JSON）
 *   prepared/zh.txt         每段一行中文参考，与 segments.json 一一对应
 *   prepared/en.txt         每段一行英文原文（给 XCOMET 当 src）
 * 中文参考的行数和每场的段数必须一一对上，对不上就报错退出，不会悄悄错位。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { grabVerified, mb } from './lib/fetch-verified.mjs';
import { samples, parseSegYaml, alignTalks } from './lib/mcif.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = path.join(ROOT, 'data', 'bench', 'mcif');
const RAW = path.join(BASE, 'raw');
const OUT = path.join(BASE, 'prepared');

const HF_REV = 'e24065b919758263cfe5d157057278affe76ea7b';
const hf = (p) => [
  `https://huggingface.co/datasets/FBK-MT/MCIF/resolve/${HF_REV}/${p}`,
  `https://hf-mirror.com/datasets/FBK-MT/MCIF/resolve/${HF_REV}/${p}`,
];

/** [HF 上的路径, 字节, sha256]，取自 HF 的 tree API（LFS 记录） */
const MCIF_FILES = [
  ['MCIF.long.en.ref.xml.gz', 89618, '15bcc57e9ec3d223cbaa89b998480e723f24d525529b578bdf81c648bf4e45aa'],
  ['MCIF.long.zh.ref.xml.gz', 133531, 'e764266d0861bb9b39f576201406cd818f5d0dca8568f1e9aa2013879a173f2a'],
  ...[
    ['DyXpuURBMP', 12862884, 'fb24e4bc542efc6d818a59029af8f9ec7df9ad12fd91a1d95e752e43533bd3db'],
    ['ERmKpJPPDc', 10890318, '9e38e8df0c16f430fa8c35b9274e2de86cf2f49bf369709f69e7f6a99d155a2e'],
    ['EqmWoxNDIr', 9632088, '584f600cb98ed52df02f609eda50e49317dbbaa93ba610adaa4fc0179b9734fb'],
    ['ICWfTnUMio', 11129934, '981fe1070cde97f765230acb9adfd7021d0b41d73c6a690131fbbe14c4cf493b'],
    ['JRrbTnEZbF', 9607886, '3dec4d4ee0e4f37aa2ffa84e70197916006db7a24ef643b1a93c0a6e77bab5f7'],
    ['JhbtCwcsWY', 11441514, 'eddaed93ed3d04531a18019c6ea262d7619d9b0549d9994bdb9cbc9612d1ddc9'],
    ['MjDvRpkOFq', 11189326, '7b045fb3c7a302a90e2ab7666215e83ad73e411a8ccb9439054c65e644f15d32'],
    ['OiqEWDVtWk', 9568186, '672a8849698f6db702ec930e917b4cb6cd3523f41e93390521760b977dfe6a16'],
    ['QTlIuodOsA', 9334862, '973a9d36e1c28d4c894ecc4aa241ce78d25e9cc435156ce575be612f5e858ada'],
    ['UOlPKyCVgg', 9573796, '52793303ef8e090ecc23bda7d03f57c1958206d56e614bc48f7339e998e29709'],
    ['ccpXHNfaoy', 11520148, '3066419f93974ff56a5c6878e612471c765109b77d33cedb1de24ccdca9b8c30'],
    ['csJIsDTYMW', 11277918, '4fbbb6398f3d4078d5a94d9f26f0ce9066ee0a6e5a7a75255710788872f9d9b4'],
    ['krJSAnVcGR', 9732132, '850ef7caf4b56b8f902508e0a17539ea43d62bd89edb501d2cf16597c602c290'],
    ['miPjvjWOvI', 11494884, '04597e319dbb444e4a45bfd7055d0bffe9b4f907155bc2c16fd61597b3068d37'],
    ['myfXyntFYL', 8865188, 'c50fb5d24490ba33851585939a57ae08113c9ecb57f181be6c422f61a05b22b8'],
    ['rOwZgUjcwB', 11162746, 'a733ef06c03b7bb9bf90788f3f30a4797a02fe4c546e8930fb13cd44992680e1'],
    ['rxrToXvRyM', 13625938, '9ccc27917580959598c023fe5da4f5f23157696005c685445b15324e3cb3010b'],
    ['vrydRuOXbT', 11464782, 'fbeb8c3b7e3ab1afec2a7decbbf005c9189326587557709e1b76374c63b18b0a'],
    ['wJAPXMIoIG', 10660600, '8df5c75d3273455a2df2702784cf9fd9f5a82ed2fe64f27ef3179e4f08ea77c6'],
    ['xhjBHGVOyQ', 11123366, 'f0ee15e29c39840aae75eb6e02b7b7eb801cfe9587e9ac4a0f733ddfc13eeab0'],
    ['xiSxNRoOzm', 11220274, '7e78cf589a277f1e452004acd97276aa703639808aaf2fd1c6edd36fb98666dd'],
  ].map(([id, bytes, sha]) => [`MCIF_DATA/LONG_AUDIOS/${id}.wav`, bytes, sha]),
];

/** 句级切分。git blob 659fe912，和 GitHub tree API 上的记录一致 */
const YAML = {
  name: 'mcif_translation.yaml',
  urls: [
    'https://raw.githubusercontent.com/pe-trik/iwslt25-baselines/master/data/mcif_translation.yaml',
    'https://web.engr.oregonstate.edu/~agostinv/mcif_translation.yaml',
  ],
  bytes: 79498,
  sha256: 'd50212b4bac17e42deffb832b766497f3a88fbaed261ccafd8fffa71a899e3a0',
};

const rawPath = (p) => path.join(RAW, ...p.split('/'));

/* ------------------------------------------------------------ 整理 */

/** wav 头：要 16k 单声道 16-bit，否则实时字幕那边喂不进去 */
function wavInfo(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4096);
  fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  let pos = 12;
  let fmt = null;
  let dataBytes = 0;
  while (pos + 8 <= head.length) {
    const id = head.toString('ascii', pos, pos + 4);
    const sz = head.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = { format: head.readUInt16LE(pos + 8), channels: head.readUInt16LE(pos + 10),
        rate: head.readUInt32LE(pos + 12), bits: head.readUInt16LE(pos + 22) };
    } else if (id === 'data') { dataBytes = sz; break; }
    pos += 8 + sz + (sz % 2);
  }
  return { ...fmt, seconds: dataBytes / 2 / 16000 };
}

async function prepare() {
  const zhXml = zlib.gunzipSync(fs.readFileSync(rawPath('MCIF.long.zh.ref.xml.gz'))).toString('utf8');
  const enXml = zlib.gunzipSync(fs.readFileSync(rawPath('MCIF.long.en.ref.xml.gz'))).toString('utf8');
  const segs = parseSegYaml(fs.readFileSync(path.join(RAW, YAML.name), 'utf8'));

  const { talks: aligned, zh: zhAll, en: enAll, problems } = alignTalks(
    segs,
    samples(zhXml).filter((s) => s.task === 'TRANS'),
    samples(enXml).filter((s) => s.task === 'ASR'),
  );
  const talks = [];
  for (const t of aligned) {
    if (!t.asrRef) problems.push(`${t.wav}：英文转写参考里没有这一场`);
    const file = path.join(RAW, 'MCIF_DATA', 'LONG_AUDIOS', t.wav);
    const info = wavInfo(file);
    if (info.format !== 1 || info.rate !== 16000 || info.channels !== 1 || info.bits !== 16) {
      problems.push(`${t.wav}：不是 16k 单声道 16-bit（${JSON.stringify(info)}）`);
    }
    talks.push({ id: t.wav.replace(/\.wav$/, ''), wav: file, seconds: +info.seconds.toFixed(3),
      segments: t.segments, asrRef: t.asrRef });
  }

  if (problems.length) {
    throw new Error(`参考和切分对不上，没有生成任何东西：\n  ${problems.join('\n  ')}`);
  }

  await fsp.mkdir(OUT, { recursive: true });
  await fsp.writeFile(path.join(OUT, 'segments.json'), `${JSON.stringify(segs, null, 1)}\n`);
  await fsp.writeFile(path.join(OUT, 'zh.txt'), `${zhAll.join('\n')}\n`, 'utf8');
  await fsp.writeFile(path.join(OUT, 'en.txt'), `${enAll.join('\n')}\n`, 'utf8');
  await fsp.writeFile(path.join(OUT, 'talks.json'), `${JSON.stringify({
    set: 'MCIF long-form EN→ZH (21 talks with references)',
    hfRevision: HF_REV,
    segmentation: 'pe-trik/iwslt25-baselines data/mcif_translation.yaml',
    talks,
  }, null, 2)}\n`, 'utf8');
  const hours = talks.reduce((s, t) => s + t.seconds, 0) / 3600;
  console.log(`\n整理完：${talks.length} 场，${segs.length} 段，${hours.toFixed(2)} 小时 → ${path.relative(ROOT, OUT)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const total = MCIF_FILES.reduce((s, f) => s + f[1], 0) + YAML.bytes;
  console.log('字幕基准：MCIF 里带中文参考的 21 场演讲\n');
  console.log(`  ${MCIF_FILES.length - 2} 个 wav + 两份参考  ← huggingface.co/datasets/FBK-MT/MCIF@${HF_REV.slice(0, 7)}（CC-BY-4.0）`);
  console.log(`  ${YAML.name}  ← github.com/pe-trik/iwslt25-baselines（未声明许可证，只在本机用）`);
  console.log(`  合计 ${mb(total)} → ${path.relative(ROOT, BASE)}\n`);
  if (argv.includes('--probe')) return;

  if (!argv.includes('--prepare')) {
    let i = 0;
    for (const [p, bytes, sha256] of MCIF_FILES) {
      i += 1;
      await grabVerified(hf(p), rawPath(p), { bytes, sha256, label: `[${i}/${MCIF_FILES.length}] ${path.basename(p)}` });
    }
    await grabVerified(YAML.urls, path.join(RAW, YAML.name), { ...YAML, label: YAML.name });
  }
  await prepare();
}

main().catch((e) => {
  console.error('\n失败：', e.message);
  process.exit(1);
});
