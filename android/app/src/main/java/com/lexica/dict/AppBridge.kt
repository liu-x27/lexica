package com.lexica.dict

import android.content.Intent
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/**
 * 桌面版里由 Electron 提供的那些杂项能力，在安卓上的对应实现。
 *
 * 凡是要返回结果给 JS 的都统一回 JSON 字符串（{ok:…} / {ok:false,error:…}），
 * 和 SqlBridge 保持同一套约定。
 */
class AppBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun version(): String = try {
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "?"
    } catch (_: Exception) { "?" }

    @JavascriptInterface
    fun dataDir(): String = activity.filesDir.absolutePath

    @JavascriptInterface
    fun toast(msg: String) {
        activity.runOnUiThread { Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show() }
    }

    /** 状态栏颜色跟着主题走，否则深色主题下状态栏还是浅的 */
    @JavascriptInterface
    fun setTheme(theme: String) {
        activity.runOnUiThread {
            val dark = theme == "glass"
            val bar = if (dark) 0xFF0E1219.toInt() else 0xFFF4EFE5.toInt()
            activity.window.statusBarColor = bar
            activity.window.navigationBarColor = bar
            @Suppress("DEPRECATION")
            activity.window.decorView.systemUiVisibility =
                if (dark) 0 else android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        }
    }

    /**
     * 导出：写进应用私有目录再用 FileProvider 分享出去。
     *
     * 没有直接写 Downloads，是因为那需要 MediaStore 或存储权限；
     * 走分享面板既不用权限，也让用户自己决定存到哪、发给谁。
     */
    @JavascriptInterface
    fun saveAndShare(filename: String, content: String): String = try {
        val dir = File(activity.filesDir, "export").apply { mkdirs() }
        val f = File(dir, safeName(filename))
        f.writeText(content, Charsets.UTF_8)
        shareFile(f, mimeOf(filename))
        JSONObject().put("ok", true).put("path", f.absolutePath).toString()
    } catch (e: Exception) {
        fail(e)
    }

    /** 备份学习数据：整个 user.db 直接拷走。没开 WAL，主库文件本身就是完整的 */
    @JavascriptInterface
    fun backupUserDb(filename: String): String = try {
        val src = File(activity.filesDir, "user.db")
        if (!src.exists()) throw IllegalStateException("还没有任何学习数据")
        val dir = File(activity.filesDir, "export").apply { mkdirs() }
        val dst = File(dir, safeName(filename))
        src.copyTo(dst, overwrite = true)
        shareFile(dst, "application/octet-stream")
        JSONObject().put("ok", true).put("path", dst.absolutePath).put("bytes", dst.length()).toString()
    } catch (e: Exception) {
        fail(e)
    }

    /**
     * 恢复备份：先落到临时文件校验，确认是 SQLite 且有 wordbook 表再替换。
     * 直接覆盖的话，选错文件就会把现有数据全毁掉，且没有回头路。
     */
    @JavascriptInterface
    fun restoreUserDb(uri: String): String = try {
        val tmp = File(activity.filesDir, "restore.tmp")
        activity.contentResolver.openInputStream(android.net.Uri.parse(uri)).use { input ->
            if (input == null) throw IllegalStateException("读不到所选文件")
            tmp.outputStream().use { input.copyTo(it) }
        }
        verifyUserDb(tmp)

        // 连接还开着的时候不能换文件，先关掉
        activity.closeDatabases()
        val dst = File(activity.filesDir, "user.db")
        File(activity.filesDir, "user.db-journal").delete()
        if (!tmp.renameTo(dst)) {
            tmp.copyTo(dst, overwrite = true)
            tmp.delete()
        }
        JSONObject().put("ok", true).toString()
    } catch (e: Exception) {
        File(activity.filesDir, "restore.tmp").delete()
        fail(e)
    }

    private fun verifyUserDb(f: File) {
        val db = io.requery.android.database.sqlite.SQLiteDatabase.openDatabase(
            f.absolutePath, null,
            io.requery.android.database.sqlite.SQLiteDatabase.OPEN_READONLY,
        )
        db.use {
            it.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='wordbook'", null)
                .use { c -> if (!c.moveToFirst()) throw IllegalStateException("这不是 Lexica 的备份文件") }
        }
    }

    /** 出错时把堆栈也留一份，方便事后从日志里看 */
    @JavascriptInterface
    fun appendLog(line: String) {
        try {
            val f = File(activity.filesDir, "lexica.log")
            // 简单封顶，别让日志无限长
            if (f.length() > 512 * 1024) f.writeText("")
            f.appendText("${java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date())}  $line\n")
        } catch (_: Exception) { /* 记日志失败不该再抛 */ }
    }

    @JavascriptInterface
    fun shareLog(): String = try {
        val f = File(activity.filesDir, "lexica.log")
        if (!f.exists() || f.length() == 0L) {
            JSONObject().put("ok", false).put("error", "还没有记录到错误").toString()
        } else {
            shareFile(f, "text/plain")
            JSONObject().put("ok", true).put("path", f.absolutePath).toString()
        }
    } catch (e: Exception) {
        fail(e)
    }

    /** @param mode "text" 导入词表 / "db" 恢复备份 */
    @JavascriptInterface
    fun pickFile(mode: String) {
        activity.runOnUiThread { activity.pickFile(mode) }
    }

    /** 从「分享 / 处理文本」进来的词。Activity 可能在页面加载完成前就收到了 intent */
    @JavascriptInterface
    fun takePendingText(): String = activity.takePendingText()

    @JavascriptInterface
    fun restart() {
        activity.runOnUiThread {
            val i = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
            i?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(i)
            Runtime.getRuntime().exit(0)
        }
    }

    @JavascriptInterface
    fun exit() {
        activity.runOnUiThread { activity.finish() }
    }

    /* ------------------------------------------------------------------ */

    private fun shareFile(f: File, mime: String) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", f)
        val i = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.runOnUiThread {
            activity.startActivity(Intent.createChooser(i, f.name))
        }
    }

    private fun mimeOf(name: String) = when {
        name.endsWith(".csv") -> "text/csv"
        name.endsWith(".tsv") -> "text/tab-separated-values"
        else -> "text/plain"
    }

    /** 文件名来自 JS，去掉路径分隔符，别让它写到目录外面去 */
    private fun safeName(name: String) =
        name.replace(Regex("[/\\\\:*?\"<>|]"), "_").ifBlank { "lexica.txt" }

    private fun fail(e: Exception) =
        JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName).toString()
}
