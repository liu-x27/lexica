# Lexica 安卓版

桌面版的移植。**查询层、出题引擎、用户数据层、整个渲染层都是同一份源码**，
不存在两份实现——`scripts/build-android-www.mjs` 在构建时从 `src/` 组装出
`app/src/main/assets/www`，测试里有一条断言专门盯着这件事：
`www` 里的渲染层必须和 `src/renderer/js` 逐字节相同。

## 构建

```bash
npm run build:db:mobile   # 从 dict.db 裁出移动版（383MB），只需要跑一次
npm run apk               # 组装 www + 拷词库 + Gradle 打包
```

产物在 `app/build/outputs/apk/release/app-release.apk`，约 392MB
（其中词库 383MB）。用的是 debug 签名，自己装够用；上架要另配签名。

### 两个必须知道的坑

**代理只能走命令行。** 用户级 `~/.gradle/gradle.properties` 里写死了
`127.0.0.1:7897`（本机实际监听 7890），而用户级配置的优先级**高于**项目级，
在 `android/gradle.properties` 里改是没用的。`build.bat` 用 `-D` 参数覆盖，
这是唯一压得住它的层级。症状是各种 "plugin not found"，看着像仓库配错了。

**`build.bat` 必须保持纯 ASCII。** cmd.exe 按系统 ANSI 代码页（GBK）解码 `.bat`，
UTF-8 的中文注释会被拆成乱码字节，其中某些字节让 `REM` 提前结束，
后半截被当命令执行。中文说明写在这个文件里就是这个原因。

## 结构

| 层 | 位置 | 说明 |
|---|---|---|
| Activity / 桥 | `app/src/main/java/com/lexica/dict/` | Kotlin，见下 |
| 安卓专有前端 | `www-src/` | 移动布局、shim、桥的 JS 封装 |
| 共用源码 | `../src/` | 构建时组装进 `assets/www` |

### Kotlin 侧

- **`SqlBridge`** — 同步的 JSON-over-JavascriptInterface SQL 通道。
  用 `io.requery:sqlite-android` 自带的 SQLite 而不是系统的：系统版本跟着
  Android 版本走，Android 12 只有 3.32，而拼写纠错用的 trigram 分词器要 3.34+。
  `BEGIN`/`COMMIT` 映射到 `beginTransaction()`——直接 `execSQL("BEGIN")` 的话，
  事务和后续写入可能落在连接池里不同的连接上。也正因如此**刻意不开 WAL**。
- **`AppBridge`** — 导出、备份、日志、重启。导出统一走 FileProvider + 分享面板，
  不申请任何存储权限。
- **`TtsBridge`** — 系统 TextToSpeech。WebView 里的 `speechSynthesis` 在很多机型上
  存在但没有任何 voice，调用静默失败。
- **`MainActivity`** — 首启把词库从 assets 拷到 `filesDir`（SQLite 读不了 APK 里的
  asset），带进度条；`ACTION_PROCESS_TEXT` / `ACTION_SEND` 是手机上取代划词的取词入口。

### JS 侧

`android-sqlite.js` 把桥包装成 `node:sqlite` 的 `DatabaseSync` 形状，
`cjs-runtime.js` 提供极小的 CommonJS 运行时和 `node:fs`/`node:path`/`node:sqlite` 桩，
于是 `dict-db.js` / `user-db.js` / `quiz.js` 一个字不用改就能在 WebView 里跑。
`lexica-shim.js` 把桌面版主进程的 IPC handler 就地重新实现成 `window.lexica`。

## 与桌面版的差异

砍掉的都是平台本身没有的：全局热键、托盘常驻、开机自启、悬浮查词窗、
UI Automation 划词、剪贴板监听。手机上取词靠系统的「分享 / 处理文本」菜单。

**机器翻译没有内置**——模型约 90MB，且在手机上跑 WASM 推理很慢。
查不到的词组仍然会给出逐词拆解，那部分是词典数据，本来就比机器翻译可靠。

## 测试

`test/android-bridge.test.mjs` 用 `node:sqlite` 搭了一个与 `SqlBridge.kt`
同构的桩，把 `assets/www` 里真正会被加载的文件按同样顺序跑一遍。
**改了 Kotlin 那边的分发逻辑，这个桩也要跟着改**，否则测试过而真机崩。

本机没有 AVD 也没有设备，所以只验到「能编译 + JS 层逻辑正确 + 布局在 375×812 下不溢出」，
真机行为未经验证。
