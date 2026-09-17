package com.lexica.dict

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/**
 * 唯一的 Activity：一个全屏 WebView，界面完全复用桌面版的渲染层。
 *
 * 首次启动要把 APK 里的词库拷到内部存储——SQLite 必须从真实文件读，
 * 没法直接读 APK 里的 asset。拷贝期间显示进度，别让人以为卡死了。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "Lexica"
        private const val DB_ASSET = "dict.db"
        private const val DB_NAME = "dict.db"
    }

    private lateinit var web: WebView
    private lateinit var splash: View
    private lateinit var splashText: TextView
    private lateinit var splashBar: ProgressBar
    private var bridge: SqlBridge? = null

    /** 页面还没加载完就收到的取词请求，等前端起来后主动来取 */
    private var pendingText: String? = null

    /** WebView 里最早的一条 console 错误，白屏时拿它当诊断信息 */
    private var firstWebError: String? = null

    /** 当前这次文件选择是给谁用的："text" 导入词表 / "db" 恢复备份 */
    private var pickMode: String = "text"

    private val picker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        onFilePicked(uri)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        web = WebView(this).apply { visibility = View.GONE }
        splash = buildSplash()
        root.addView(splash, LinearLayout.LayoutParams(-1, -1))
        root.addView(web, LinearLayout.LayoutParams(-1, -1))
        setContentView(root)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            // 全部资源都在 assets 里，不需要任何网络能力
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
            // 字号缩放由应用内的「正文字号」设置管，别再叠一层系统缩放
            textZoom = 100
        }
        WebView.setWebContentsDebuggingEnabled(true)

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d(TAG, "[web] ${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                // CSP 拦截、脚本报错都只在 console 里出现，页面上是纯白的。
                // 留最早的一条：后面的报错通常是它的连带反应。
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR && firstWebError == null) {
                    firstWebError = "${m.message()}  (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})"
                }
                return true
            }
        }

        // intent 可能比页面先到，先存下来
        pendingText = extractText(intent)

        CoroutineScope(Dispatchers.Main).launch { prepareAndStart() }
    }

    private fun buildSplash(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setBackgroundColor(0xFFFAF7F1.toInt())
            setPadding(64, 0, 64, 0)
        }
        splashText = TextView(this).apply {
            text = getString(R.string.preparing)
            textSize = 15f
            setTextColor(0xFF5A534A.toInt())
            gravity = android.view.Gravity.CENTER
        }
        splashBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = false
        }
        box.addView(splashText)
        box.addView(splashBar, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 36 })
        return box
    }

    private suspend fun prepareAndStart() {
        val dbFile = File(filesDir, DB_NAME)
        try {
            if (!isDbReady(dbFile)) {
                withContext(Dispatchers.IO) { copyDatabase(dbFile) }
            }
        } catch (e: Exception) {
            splashText.text = "词库准备失败：${e.message}"
            Log.e(TAG, "copy failed", e)
            return
        }

        val userFile = File(filesDir, "user.db")
        bridge = SqlBridge(dbFile.absolutePath, userFile.absolutePath).also {
            try {
                it.openAll()
            } catch (e: Exception) {
                splashText.text = "词库打开失败：${e.message}"
                Log.e(TAG, "open failed", e)
                return
            }
            web.addJavascriptInterface(it, "AndroidSql")
        }
        Log.i(TAG, "SQLite ${bridge?.sqliteVersion()}")

        web.addJavascriptInterface(TtsBridge(this), "AndroidTts")
        web.addJavascriptInterface(AppBridge(this), "AndroidApp")

        splash.visibility = View.GONE
        web.visibility = View.VISIBLE
        web.loadUrl("file:///android_asset/www/index.html")
        web.postDelayed({ checkBooted() }, 6000)
    }

    /**
     * 白屏兜底。
     *
     * CSP 拦掉脚本、或者哪个 js 抛在了顶层，页面就是一片空白，什么线索都没有，
     * 手机上又看不了 logcat。这里过几秒问一句前端起没起来，没起来就把
     * console 里最早的那条错误显示出来。
     */
    private fun checkBooted() {
        web.evaluateJavascript("!!(window.lexica && window.Lx)") { r ->
            if (r == "true") return@evaluateJavascript
            val why = firstWebError ?: "页面脚本没有执行（常见原因是 index.html 的 CSP 拦掉了 file: 脚本）"
            Log.e(TAG, "boot failed: $why")
            web.visibility = View.GONE
            splash.visibility = View.VISIBLE
            splashBar.visibility = View.GONE
            splashText.text = "界面启动失败\n\n$why"
        }
    }

    /** 拷过一次就不再拷；用大小比对，避免升级后用了旧库 */
    private fun isDbReady(f: File): Boolean {
        if (!f.exists()) return false
        val expected = assets.openFd(DB_ASSET).use { it.length }
        return f.length() == expected
    }

    private fun copyDatabase(dest: File) {
        val fd = assets.openFd(DB_ASSET)
        val total = fd.length
        fd.close()

        dest.parentFile?.mkdirs()
        val tmp = File(dest.parentFile, "${dest.name}.part")
        assets.open(DB_ASSET, android.content.res.AssetManager.ACCESS_STREAMING).use { input ->
            tmp.outputStream().use { out ->
                val buf = ByteArray(1 shl 20)
                var done = 0L
                var lastPct = -1
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    done += n
                    val pct = ((done * 100) / total).toInt()
                    if (pct != lastPct) {
                        lastPct = pct
                        runOnUiThread {
                            splashBar.progress = pct
                            splashText.text = "正在准备词库…  $pct%"
                        }
                    }
                }
            }
        }
        if (dest.exists()) dest.delete()
        if (!tmp.renameTo(dest)) throw IllegalStateException("无法写入词库文件")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val text = extractText(intent) ?: return
        // 页面已经在跑了就直接送过去，否则留着等它来取
        if (web.visibility == View.VISIBLE) {
            web.evaluateJavascript(
                "window.__lexicaLookup && window.__lexicaLookup(${JSONObject.quote(text)})", null,
            )
        } else {
            pendingText = text
        }
    }

    /** 别的应用选中文字后「分享到 Lexica」或用「处理文本」菜单，这是手机上的取词方式 */
    private fun extractText(intent: Intent?): String? = when (intent?.action) {
        Intent.ACTION_PROCESS_TEXT -> intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
        Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
        else -> null
    }?.trim()?.take(80)?.ifBlank { null }

    fun takePendingText(): String {
        val t = pendingText ?: return ""
        pendingText = null
        return t
    }

    /* ------------------------------------------------------- 文件选择 */

    fun pickFile(mode: String) {
        pickMode = mode
        /* 词表可能是 .txt/.csv/.md，备份是 .db。很多文件管理器给自定义扩展名的
           MIME 是 application/octet-stream 甚至空，按扩展名过滤会让文件选不中，
           所以放开类型，由下面的内容校验来把关。 */
        picker.launch(arrayOf("*/*"))
    }

    private fun onFilePicked(uri: Uri?) {
        val json = if (uri == null) {
            JSONObject().put("ok", false).put("error", "已取消")
        } else {
            try {
                if (pickMode == "db") {
                    // 备份文件可能很大，不读进内存，把 uri 交给 AppBridge 去流式拷贝
                    JSONObject().put("ok", true).put("uri", uri.toString())
                } else {
                    val text = contentResolver.openInputStream(uri)!!.use {
                        it.readBytes().toString(Charsets.UTF_8)
                    }
                    JSONObject().put("ok", true).put("text", text).put("name", displayName(uri))
                }
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: "读取失败")
            }
        }
        web.evaluateJavascript(
            "window.__lexicaFilePicked && window.__lexicaFilePicked(${JSONObject.quote(json.toString())})", null,
        )
    }

    private fun displayName(uri: Uri): String {
        contentResolver.query(uri, null, null, null, null)?.use { c ->
            val i = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (i >= 0 && c.moveToFirst()) return c.getString(i) ?: "词表"
        }
        return "词表"
    }

    /** 恢复备份要先放开 user.db 的文件句柄 */
    fun closeDatabases() {
        bridge?.close()
        bridge = null
    }

    override fun onDestroy() {
        bridge?.close()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // 交给页面自己处理返回（词条历史、退出练习等），页面处理不了再退出
        web.evaluateJavascript("window.__lexicaBack ? window.__lexicaBack() : false") { r ->
            if (r != "true") {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }
}
