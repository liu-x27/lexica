#!/usr/bin/env python3
"""
给 scripts/bench-stream.mjs 跑出来的一轮基准打分。

    python -I scripts/bench-score.py --run dist/bench/opus-cpu --data data/bench/mcif/prepared [--xcomet]
    python -I scripts/bench-score.py --table dist/bench/opus-cpu dist/bench/hymt7b-cpu

输入是应用自己写的流水账（每场一份 journal.jsonl）和那一场的 run.json。
算的东西和口径：

- 时延：OmniSTEval（Polák et al. 2025, arXiv 2509.17349）的 LongYAAL 与 LongLAAL，
  中文按字符算（--char_level）。每个字的出炉时刻：
    CU（不计算力）= 这一段音频的结束位置 t1——流水线要等 VAD 在这里切下去才开始识别；
      流式识别的一条字幕可能话说完好几秒才出，流水账另记了出这一条时已经收到的音频位置 cu，有就用它；
    CA（计算力在内）= 译文真正出来的墙钟时刻 zhAt 减去开始喂音频的时刻。
  IWSLT 2026 同传赛道按 CU 的 LongYAAL 分档：0–2 秒为低时延，2–4 秒为高时延。
  StreamLAAL 没有算：它要 mwerSegmenter（mweralign 只有 Linux 的轮子，本机编不了），
  LongLAAL 是同一个公式，只是重切分用的是 OmniSTEval 自己的 SoftSegmenter。
- 质量：重切分之后的 chrF、BLEU（sacrebleu，zh 分词），可选 XCOMET-XL
  （Unbabel/XCOMET-XL，CC-BY-NC-SA-4.0，只在本机打分，模型不分发）。
- 识别：WER，和 MCIF 官方评测同一套——whisper_normalizer 的 EnglishTextNormalizer
  规整后用 jiwer 按场次合在一起算。
- 流水线自己的数：每段字幕落后多少（中位数、p90）、积压丢弃了几段、
  数字守卫退回兜底模型的句数。

依赖：OmniSTEval==0.1.10、jiwer==3.0.5、whisper-normalizer==0.0.10；
XCOMET-XL 另要 unbabel-comet 和带 CUDA 的 torch。
"""
import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile


def read_jsonl(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # 崩溃时可能留下半行
    return out


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def load_run(run_dir, talks):
    """每场的流水账行（按 t0 排）和喂入开始时刻。没跑完的场次（没有 run.json）跳过"""
    runs = {}
    for t in talks:
        d = os.path.join(run_dir, t["id"])
        rj = os.path.join(d, "run.json")
        if not os.path.exists(rj):
            continue
        with open(rj, encoding="utf-8") as f:
            meta = json.load(f)
        rows = [o for o in read_jsonl(os.path.join(d, "journal.jsonl")) if o.get("kind") == "seg"]
        # 同一个 id 以最后一次为准（和 lecture.js 的 loadTranscript 一致）
        by_id = {}
        for o in rows:
            by_id[o["id"]] = o
        runs[t["id"]] = {"meta": meta, "rows": sorted(by_id.values(), key=lambda o: (o["t0"], o["id"]))}
    return runs


def hypothesis_line(talk, run):
    """
    一场 → OmniSTEval 的一行（SimulEval 风格）。中文按字符算时，units 就是 list(prediction)，
    所以空白一律去掉（参考那边也去了空格），每个字配一个 CU、一个 CA 时刻。
    """
    started = run["meta"]["feed"]["startedAt"]
    speed = run["meta"]["feed"].get("speed", 1) or 1
    chars, cu, ca = [], [], []
    # 输出流按段的顺序算：后一段的译文偶尔比前一段先回来（前一段退回了兜底模型），
    # 但那时前面还缺一句，读者看到的「这一段为止」要等前一段到了才算齐，所以 CA 取累计最大值
    ca_floor = 0.0
    for o in run["rows"]:
        zh = re.sub(r"\s+", "", o.get("zh") or "")
        if not zh:
            continue
        at = o.get("zhAt")
        ca_ms = (at - started) * speed if at else float(o["t1"])
        ca_floor = max(ca_floor, float(ca_ms))
        for ch in zh:
            chars.append(ch)
            cu.append(float(o.get("cu", o["t1"])))
            ca.append(ca_floor)
    return {
        "source": talk["id"] + ".wav",
        "prediction": "".join(chars),
        "delays": cu,
        "elapsed": ca,
        "source_length": talk["seconds"] * 1000.0,
    }


def child_env():
    """子进程的标准输出按 UTF-8 写。中文 Windows 上管道默认是 GBK：OmniSTEval 打印报告时
    碰到译文里的零宽字符（U+200C，opus 偶尔会吐）就 UnicodeEncodeError 退出，分数一个都拿不到。"""
    return {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}


def run_omnisteval(work, seg_file, zh_file, hyp_file):
    out = os.path.join(work, "omnisteval")
    cmd = [sys.executable, "-m", "omnisteval.cli", "longform",
           "--speech_segmentation", seg_file, "--ref_sentences_file", zh_file,
           "--hypothesis_file", hyp_file, "--lang", "zh", "--char_level",
           "--bleu_tokenizer", "zh", "--output_folder", out]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=child_env())
    with open(os.path.join(work, "omnisteval.log"), "w", encoding="utf-8") as f:
        f.write(r.stdout + "\n" + r.stderr)
    if r.returncode != 0:
        raise SystemExit(f"OmniSTEval 失败（退出码 {r.returncode}），见 {os.path.join(work, 'omnisteval.log')}")
    scores = {}
    with open(os.path.join(out, "scores.tsv"), encoding="utf-8") as f:
        next(f)
        for line in f:
            k, v = line.rstrip("\n").split("\t")
            try:
                scores[k] = float(v)
            except ValueError:
                scores[k] = v
    return scores, os.path.join(out, "instances.resegmented.jsonl")


def run_xcomet(work, resegmented, en_lines):
    """XCOMET-XL 走官方的 comet-score：它会把模型转成半精度，3.5B 的权重在 16GB 显卡上放得下"""
    preds = [o["prediction"] for o in read_jsonl(resegmented)]
    refs = [o["reference"] for o in read_jsonl(resegmented)]
    if len(preds) != len(en_lines):
        raise SystemExit(f"重切分后 {len(preds)} 段，英文原文 {len(en_lines)} 行，对不上")
    files = {}
    for k, lines in (("src", en_lines), ("mt", preds), ("ref", refs)):
        p = os.path.join(work, f"xcomet.{k}.txt")
        with open(p, "w", encoding="utf-8") as f:
            # comet-score 按行读，空译文写成一个空格，不然行数会少
            f.write("\n".join((x.replace("\n", " ") or " ") for x in lines) + "\n")
        files[k] = p
    exe = os.path.join(os.path.dirname(sys.executable), "comet-score.exe" if os.name == "nt" else "comet-score")
    out_json = os.path.join(work, "xcomet.json")
    cmd = [exe, "-s", files["src"], "-t", files["mt"], "-r", files["ref"],
           "--model", "Unbabel/XCOMET-XL", "--gpus", "1", "--batch_size", "8", "--to_json", out_json]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=child_env())
    with open(os.path.join(work, "xcomet.log"), "w", encoding="utf-8") as f:
        f.write(r.stdout + "\n" + r.stderr)
    if r.returncode != 0:
        raise SystemExit(f"comet-score 失败（退出码 {r.returncode}），见 {os.path.join(work, 'xcomet.log')}")
    with open(out_json, encoding="utf-8") as f:
        seg = json.load(f)
    # --to_json 写的是 {译文文件: [{src, mt, ref, COMET, …}]}
    scores = [x.get("COMET", x.get("score")) for x in next(iter(seg.values()))]
    return sum(scores) / len(scores)


def wer_scores(talks, runs):
    import jiwer
    from whisper_normalizer.english import EnglishTextNormalizer
    std = EnglishTextNormalizer()
    refs, hyps, per = [], [], {}
    for t in talks:
        if t["id"] not in runs or not t.get("asrRef"):
            continue
        hyp = " ".join(o.get("en") or "" for o in runs[t["id"]]["rows"])
        r, h = std(t["asrRef"]), std(hyp)
        refs.append(r)
        hyps.append(h)
        per[t["id"]] = jiwer.wer(r, h)
    return (jiwer.wer(refs, hyps) if refs else None), per


def pipeline_stats(runs, configured_mt):
    """流水线自己的数：字幕落后多少、丢了几段、哪几句是兜底模型译的"""
    asr_lag, cap_lag, mt_ms = [], [], []
    via, segs, dropped, fed = {}, 0, 0, 0.0
    for run in runs.values():
        started = run["meta"]["feed"]["startedAt"]
        speed = run["meta"]["feed"].get("speed", 1) or 1
        dropped += run["meta"].get("dropped") or 0
        fed += run["meta"]["feed"].get("fedSeconds") or 0
        for o in run["rows"]:
            segs += 1
            # 「这一段音频到手之后多久出来」：whisper 是切下这一块的位置 t1，流式是出这一条时的位置 cu
            ready = o.get("cu", o["t1"])
            if o.get("enAt"):
                asr_lag.append(((o["enAt"] - started) * speed - ready) / 1000)
            if o.get("zhAt"):
                cap_lag.append(((o["zhAt"] - started) * speed - ready) / 1000)
                if o.get("enAt"):
                    mt_ms.append(o["zhAt"] - o["enAt"])
            k = o.get("mt") or "（无译文）"
            via[k] = via.get(k, 0) + 1
    r = lambda x: None if x is None else round(x, 3)  # noqa: E731
    return {
        "segments": segs,
        "dropped_chunks": dropped,
        "audio_hours": round(fed / 3600, 3),
        "en_lag_s": {"median": r(pct(asr_lag, 0.5)), "p90": r(pct(asr_lag, 0.9))},
        "zh_lag_s": {"median": r(pct(cap_lag, 0.5)), "p90": r(pct(cap_lag, 0.9))},
        "mt_ms": {"median": r(pct(mt_ms, 0.5)), "p90": r(pct(mt_ms, 0.9))},
        "translated_by": via,
        "fallback_segments": sum(n for k, n in via.items() if k not in (configured_mt, "（无译文）")),
    }


def score(args):
    with open(os.path.join(args.data, "talks.json"), encoding="utf-8") as f:
        prepared = json.load(f)
    talks = prepared["talks"]
    with open(os.path.join(args.data, "segments.json"), encoding="utf-8") as f:
        segs = json.load(f)
    with open(os.path.join(args.data, "zh.txt"), encoding="utf-8") as f:
        zh = [x.rstrip("\n") for x in f]
    with open(os.path.join(args.data, "en.txt"), encoding="utf-8") as f:
        en = [x.rstrip("\n") for x in f]
    zh, en = zh[:len(segs)], en[:len(segs)]

    runs = load_run(args.run, talks)
    if not runs:
        raise SystemExit(f"{args.run} 里没有跑完的场次")
    done = [t for t in talks if t["id"] in runs]

    # 只跑了一部分场次时，切分和参考也只留那几场（OmniSTEval 要求场次数对得上）
    keep = {t["id"] + ".wav" for t in done}
    idx = [i for i, s in enumerate(segs) if s["wav"] in keep]
    work = os.path.join(args.run, "score")
    os.makedirs(work, exist_ok=True)
    seg_file = os.path.join(work, "segments.json")
    zh_file = os.path.join(work, "zh.txt")
    with open(seg_file, "w", encoding="utf-8") as f:
        json.dump([segs[i] for i in idx], f)
    with open(zh_file, "w", encoding="utf-8") as f:
        f.write("\n".join(zh[i] for i in idx) + "\n")
    en_kept = [en[i] for i in idx]

    hyp_file = os.path.join(work, "hypothesis.jsonl")
    with open(hyp_file, "w", encoding="utf-8") as f:
        for t in done:
            f.write(json.dumps(hypothesis_line(t, runs[t["id"]]), ensure_ascii=False) + "\n")

    if args.dry:
        # 只检查流水账能不能转成 OmniSTEval 的输入，不调外部工具
        print(json.dumps(pipeline_stats(runs, next(iter(runs.values()))["meta"].get("mtModel")),
                         ensure_ascii=False, indent=2))
        print(f"假设文件：{hyp_file}")
        return
    omni, resegmented = run_omnisteval(work, seg_file, zh_file, hyp_file)
    wer, per_talk_wer = wer_scores(done, runs)

    first = next(iter(runs.values()))["meta"]
    result = {
        "run": os.path.basename(os.path.normpath(args.run)),
        "set": prepared.get("set"),
        "talks": len(done),
        "segments_ref": len(idx),
        "asr": first.get("asrModel"),
        "mt": first.get("mtModel"),
        "settings": first.get("settings"),
        # 存全精度：先在这里舍到 4 位、表里再舍到 1 位，会舍错（0.205453 → 0.2055 → 20.6%）
        "wer": wer,
        "wer_per_talk": per_talk_wer,
        "omnisteval": omni,
        "pipeline": pipeline_stats(runs, first.get("mtModel")),
    }
    if args.xcomet:
        result["xcomet_xl"] = round(run_xcomet(work, resegmented, en_kept), 4)
    machine = os.path.join(args.run, "machine.json")
    if os.path.exists(machine):
        with open(machine, encoding="utf-8") as f:
            result["machine"] = json.load(f)

    with open(os.path.join(args.run, "scores.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in result.items() if k not in ("wer_per_talk", "machine")},
                     ensure_ascii=False, indent=2))


def table(run_dirs):
    """几轮放一张 markdown 表，README 里那张就是它出的"""
    rows = []
    for d in run_dirs:
        with open(os.path.join(d, "scores.json"), encoding="utf-8") as f:
            rows.append(json.load(f))
    get = lambda r, k: r["omnisteval"].get(k)  # noqa: E731
    fmt = lambda x, n=1: "—" if x is None else f"{x:.{n}f}"  # noqa: E731
    print("| 配置 | WER | BLEU | chrF | XCOMET-XL | LongYAAL CU / CA (s) | LongLAAL CU / CA (s) | 中文晚到 中位 / p90 (s) | 兜底句数 |")
    print("|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        p = r["pipeline"]
        yaal = f"{fmt(get(r, 'LongYAAL (CU)') / 1000, 2)} / {fmt(get(r, 'LongYAAL (CA)') / 1000, 2)}"
        laal = f"{fmt(get(r, 'LongLAAL (CU)') / 1000, 2)} / {fmt(get(r, 'LongLAAL (CA)') / 1000, 2)}"
        lag = f"{fmt(p['zh_lag_s']['median'], 2)} / {fmt(p['zh_lag_s']['p90'], 2)}"
        wer = "—" if r.get("wer") is None else f"{r['wer'] * 100:.1f}%"
        xc = "—" if r.get("xcomet_xl") is None else f"{r['xcomet_xl'] * 100:.1f}"
        print(f"| {r['run']} | {wer} | {fmt(get(r, 'BLEU'))} | {fmt(get(r, 'chrF'))} | {xc} | {yaal} | {laal} | {lag} | "
              f"{p['fallback_segments']}/{p['segments']} |")


def main():
    # 中文 Windows 上管道默认按 GBK 编码，打出来的中文会乱
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--run", help="bench-stream.mjs 的输出目录")
    ap.add_argument("--data", help="data/bench/mcif/prepared")
    ap.add_argument("--xcomet", action="store_true", help="另算 XCOMET-XL（要显卡和 unbabel-comet）")
    ap.add_argument("--table", nargs="+", metavar="RUN", help="把几轮已经打过分的结果排成一张表")
    ap.add_argument("--dry", action="store_true", help="只生成 OmniSTEval 的输入，不打分（检查转换用）")
    args = ap.parse_args()
    if args.table:
        return table(args.table)
    if not args.run or not args.data:
        ap.error("要么给 --run 和 --data，要么给 --table")
    return score(args)


if __name__ == "__main__":
    main()
