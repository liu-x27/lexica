# Lexica

A 3.4-million-entry English–Chinese dictionary and a real-time lecture captioner that
both run with the network cable pulled out.

The interesting parts are the constraints. 814 MB of merged corpora searched through
SQLite FTS5, with a classifier that demotes 3.24 M of the 3.40 M rows below the 162 K it
judges to be real headwords. Speech recognition moved from 0.58× to 4.0× real time by replacing ONNX Whisper
with a resident `whisper.cpp` server. And both the Windows desktop app and the Android
build come from the same source tree, bridged by a minimal CommonJS runtime and a
`node:sqlite` shim over Kotlin.

*[中文说明见 README.zh-CN.md](README.zh-CN.md) — the app's own UI is Chinese; this file
is the engineering overview.*

![An entry: senses grouped by part of speech, WordNet glosses, examples, frequency ranks](docs/screenshots/entry.png)

## The dictionary

Four open corpora — ECDICT, WordNet, Tatoeba and GCIDE — merged into one 814 MB SQLite
file: 1.36 M single words and 2.04 M phrases, with senses grouped by part of speech,
WordNet glosses and example sentences, inflections, frequency ranks from COCA and BNC,
and exam-syllabus tags from middle school through GRE.

**The weak-entry problem.** ECDICT includes a large number of misspellings and bare
inflected forms as first-class entries. Searching naively, a query for a common word
returns a page of near-identical junk. A classifier scores each row on where it came
from, whether it has a real definition, and whether it reduces to another entry, and
demotes 3.24 M of the 3.40 M rows below the 162 K that survive as headwords, while
keeping every one reachable by exact lookup — so a typo still resolves, but never
outranks a real word. The flag is the `weak` column in `words`, and search orders on it
rather than filtering, which is what makes exact lookup still work.

**No native modules.** SQLite is Node's built-in `node:sqlite`, not `better-sqlite3`.
FTS5, the trigram tokenizer and custom functions all work through it, which means the
app installs on a machine with no MSVC build tools — the reason for the choice in the
first place.

## Real-time captioning

Live bilingual subtitles for a lecture, taken from the microphone, from system audio, or
from an imported recording, written to a file as they go. Entirely offline.

![Live captions: timestamped English lines from whisper.cpp, Chinese under each](docs/screenshots/live-captions.png)

The English line is what the system is judged on. The Chinese under it comes from a
117 MB local `opus-mt` model and is a rough gloss — good enough to follow along, wrong
often enough that the transcript keeps both languages rather than replacing one with the
other.

Getting it usable took three changes:

- **ONNX Whisper → a resident `whisper.cpp` server.** The ONNX path ran at 0.58× real
  time, i.e. falling behind a speaker permanently. Keeping a `whisper.cpp` process warm
  and streaming chunks into it reaches 4.0×.
- **Bounding `--audio-ctx` against chunk length.** Shrinking the encoder context window
  is most of the speedup, but set it too small for a given chunk and the decoder
  degenerates into repeating the same phrase forever — with no error. The window is now
  derived from chunk length rather than fixed.
- **Beam search plus domain prompting**, for a measured 0.8% WER on lecture audio.

Silence-based chunking (`src/main/vad-chunker.js`) splits on pauses rather than a fixed
clock, adapts its threshold to the room's noise floor, and keeps a lead-in so the first
syllable of a sentence is not clipped.

## One source tree, two platforms

The Android build reuses the desktop renderer verbatim. `npm run build:www` assembles
`android/app/src/main/assets/www` from `src/renderer`, and a test asserts the shared
files are **byte-identical** between the two — the copy cannot drift silently. What
differs is bridged:

- `cjs-runtime.js` — a minimal CommonJS loader, since the renderer is CJS and a WebView is not
- `android-sqlite.js` — a `node:sqlite`-shaped shim over a Kotlin `SqlBridge`
- Kotlin side: `AppBridge`, `SqlBridge`, `TtsBridge`

One bridge detail worth naming, because the error message points nowhere near it:
`SQLiteDatabase.execSQL()` refuses any statement that returns rows, and several PRAGMAs
return a row in their *assignment* form — `PRAGMA mmap_size = N` and
`PRAGMA journal_mode = X` both do. It fails with
`Queries can be performed using SQLiteDatabase query or rawQuery methods only`, which
never mentions PRAGMA. Every PRAGMA now goes through `rawQuery(sql, null)`.

## Running it

Requires Node 22+ (for `node:sqlite`) and Windows for the desktop app.

```bash
npm install
npm run data     # downloads ~250 MB of corpora, builds data/dict.db (814 MB)
npm start
npm test         # 188 tests, no data needed
```

`npm run data` is a one-time cost and the only step that touches the network. The
download script falls back through `gh-proxy.com` and `ghfast.top` before hitting
GitHub directly, which on a Chinese connection is the difference between minutes and
hours.

For Android: `npm run build:db:mobile` (a 383 MB slim database), then `npm run apk`.

## Layout

```
src/main/        electron main process — dict-db, asr, lecture, vad-chunker,
                 glossary, quiz, user-db, selection (Windows UI Automation)
src/renderer/    the UI, shared verbatim with Android
scripts/         corpus download, database build, mobile slim build, APK build,
                 MT and ASR model evaluation harnesses
android/         Kotlin host + generated www assets
test/            188 tests across 37 suites, node:test, no network or data required
```

## Status

The desktop app is what I use daily. The Android build runs on a physical device — the
SQLite PRAGMA note above came out of its first launch on one.

The captioning numbers (0.58× → 4.0×, 0.8% WER) come from my own measurements on my own
hardware and lecture recordings, not from a public benchmark.

Dictionary data is redistributed under the licences of the upstream corpora; the
build scripts fetch them rather than vendoring them here.
