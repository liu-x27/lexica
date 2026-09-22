# Lexica

A 3.4-million-entry English–Chinese dictionary and a real-time lecture captioner that
both run with the network cable pulled out.

The interesting parts are the constraints. 1,260 MB of merged corpora searched through
SQLite FTS5, with a rule that demotes 3.24 M of the 3.40 M rows — everything carrying no
frequency rank, no Collins rating, no syllabus tag and no WordNet entry — below the 162 K
that keep at least one. Audio-processing throughput went from 0.58× to 4.0× real time on
my own hardware, by moving to a resident `whisper.cpp` server *and* bounding the encoder
context window against chunk length; the second change is the larger half. And both the Windows desktop app and the Android
build come from the same source tree, bridged by a minimal CommonJS runtime and a
`node:sqlite` shim over Kotlin.

*[中文说明见 README.zh-CN.md](README.zh-CN.md) — the app's own UI is Chinese; this file
is the engineering overview.*

![An entry: senses grouped by part of speech, WordNet glosses, examples, frequency ranks](docs/screenshots/entry.png)

## The dictionary

Five open sources — ECDICT, WordNet, Tatoeba, GCIDE and a Chinese Wikipedia page dump
— merged into one 1,260 MB SQLite file: 1.36 M single words and 2.04 M phrases, with
senses grouped by part of speech,
WordNet glosses and example sentences, inflections, frequency ranks from COCA and BNC,
and exam-syllabus tags from middle school through GRE.

**The weak-entry problem.** ECDICT includes a large number of misspellings and bare
inflected forms as first-class entries. Searching naively, a query for a common word
returns a page of near-identical junk. The fix is a rule, not a model: a row is marked
weak when it carries no authority signal at all — no frequency rank, no Collins rating,
no exam-syllabus tag, and no WordNet entry. That is exactly where ECDICT's
web-aggregated misspellings (`recieve`, `wierd`) and bare inflections (`ran`, `mice`)
land, and it demotes 3.24 M of the 3.40 M rows below the 162 K that keep at least one
signal, while leaving every one reachable by exact lookup — so a typo still resolves,
but ranks below the retained headwords instead of above them. Below *those*, which is
not the same as never outranking any real word: a real word no source rated is weak
too. The flag is the `weak` column in `words`; search ranking and the spell-correction
candidate pool both order on it rather than filtering, which is what keeps exact lookup
working.

**No native modules.** SQLite is Node's built-in `node:sqlite`, not `better-sqlite3`.
FTS5, the trigram tokenizer and custom functions all work through it, which means the
app installs on a machine with no MSVC build tools — the reason for the choice in the
first place.

## Real-time captioning

Live bilingual subtitles for a lecture, taken from the microphone, from system audio, or
from an imported recording, written to a file as they go. Entirely offline.

![Live captions: timestamped English lines from whisper.cpp, Chinese under each](docs/screenshots/live-captions.png)

The English line is what the system is judged on. The Chinese under it comes from a
118 MB local `opus-mt` model and is a rough gloss — good enough to follow along, wrong
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
- **Beam search plus domain prompting**, for 0.8% WER — but see the conditions below
  before comparing that to anything.

**What those two numbers were measured on.** Neither is a benchmark result.

| | conditions |
|---|---|
| 0.58× → 4.00× | 5-second chunks, ONNX Whisper against a resident `whisper.cpp` server, my hardware |
| 0.8% WER | one 127-word lecture clip of my own, scored by `scratchpad/asr-quality.mjs`, `small` + beam-5 + domain prompt |

The shipped default is that last configuration, and it runs at **3.7×**, not 4.0× — beam
search and prompting buy accuracy with throughput. The 4.00× is what the runtime change
alone bought, on the faster settings. And throughput is not latency: 3.7× says audio is
processed faster than it arrives, not how far behind a caption appears. The full
per-configuration table, including the two settings that made WER *worse*, is in the
[Chinese README](README.zh-CN.md#识别质量三个可调项的实测).

Silence-based chunking (`src/main/vad-chunker.js`) splits on pauses rather than a fixed
clock, adapts its threshold to the room's noise floor, and keeps a lead-in so the first
syllable of a sentence is not clipped.

## One source tree, two platforms

Not the same feature set on both, and the differences are deliberate:

| | Windows | Android |
|---|---|---|
| Dictionary search, entry view | ✓ | ✓ |
| Wordbook, notes, custom lists | ✓ | ✓ |
| Quiz / drill | ✓ | ✓ |
| Sentence translation (`opus-mt`) | ✓ | — |
| Live lecture captions | ✓ | — |
| Floating quick-lookup window | ✓ | — |

Translation is out on Android on purpose: the model is ~90 MB and WASM inference on a
phone is slow, so `mtStatus()` returns unavailable with a reason and phrases that miss
fall back to a word-by-word breakdown rather than an error. Captions are out because the
whole audio stack — capture worklet, source, subtitle window — is excluded from the
Android bundle; nothing about it was ported and nothing pretends to be.

The Android build reuses the desktop renderer verbatim. `npm run build:www` assembles
`android/app/src/main/assets/www` from `src/renderer`, and a test asserts the shared
files are **byte-identical** between the two — the copy cannot drift silently. What
differs is bridged:

- `cjs-runtime.js` — a minimal CommonJS loader, since the renderer is CJS and a WebView is not
- `android-sqlite.js` — a `node:sqlite`-shaped shim over a Kotlin `SqlBridge`
- Kotlin side: `AppBridge`, `SqlBridge`, `TtsBridge`

The bridge detail that cost the most time is in
[docs/android-port.md](docs/android-port.md): `SQLiteDatabase.execSQL()` refuses any
statement that returns rows, several PRAGMAs do so in their assignment form, and the
error message never mentions PRAGMA.

## Running it

Requires Node 22+ (for `node:sqlite`) and Windows for the desktop app.

```bash
npm install
npm run data     # downloads ~800 MB of corpora, builds data/dict.db (1,260 MB)
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
SQLite PRAGMA note linked above came out of its first launch on one.

The captioning numbers (0.58× → 4.0×, 0.8% WER) come from my own measurements on my own
hardware and lecture recordings, not from a public benchmark.

Dictionary data is redistributed under the licences of the upstream corpora; the
build scripts fetch them rather than vendoring them here.
