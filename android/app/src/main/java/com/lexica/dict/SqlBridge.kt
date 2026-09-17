package com.lexica.dict

import android.webkit.JavascriptInterface
import io.requery.android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject

/**
 * 暴露给 WebView 的同步 SQL 接口。
 *
 * JavascriptInterface 的调用在 JS 侧是同步的（会阻塞 WebView 的 JS 线程直到返回），
 * 正好能让桌面版的查询层原封不动地跑起来——它期待的是 node:sqlite 那种
 * `prepare(sql).get()/all()/run()` 的同步形状。
 *
 * 用 requery 的 SQLiteDatabase 而不是系统自带的：系统 SQLite 版本跟 Android 版本走，
 * Android 12 只有 3.32，而 trigram 分词器要 3.34+，低版本手机会直接查崩。
 *
 * 参数与结果都走 JSON 字符串，因为 JavascriptInterface 只能传基本类型。
 */
class SqlBridge(private val dictPath: String, private val userPath: String) {

    private var dict: SQLiteDatabase? = null
    private var user: SQLiteDatabase? = null

    fun openAll() {
        dict = SQLiteDatabase.openDatabase(dictPath, null, SQLiteDatabase.OPEN_READONLY)
        user = SQLiteDatabase.openOrCreateDatabase(userPath, null)
        // 手机内存有限，别把缓存开太大；mmap 让只读的大词库省一次拷贝
        dict?.let {
            pragma(it, "PRAGMA cache_size = -16384")
            pragma(it, "PRAGMA mmap_size = 134217728")
        }
        /* 故意不开 WAL：开了之后连接池会用多条连接，而下面把 BEGIN/COMMIT 映射到
           beginTransaction() 依赖「写操作都落在同一条连接上」。单线程访问的手机端
           WAL 带来的并发收益为零，不值得为它换来一类难查的事务错乱。 */
    }

    /**
     * 执行一条 PRAGMA。
     *
     * 必须走 rawQuery：不少 PRAGMA 的赋值形式也会回一行（`mmap_size`、`journal_mode`
     * 都是），而 execSQL 见到会返回数据的语句就抛
     * 「Queries can be performed using SQLiteDatabase query or rawQuery methods only」。
     * 报错里完全看不出是 PRAGMA 的问题，别再改回 execSQL。
     */
    private fun pragma(db: SQLiteDatabase, sql: String) {
        db.rawQuery(sql, null).use { it.moveToFirst() }
    }

    fun close() {
        dict?.close(); dict = null
        user?.close(); user = null
    }

    private fun dbOf(which: String) = if (which == "user") user else dict

    /** SQLite 版本，启动时打日志用，便于排查分词器可用性 */
    @JavascriptInterface
    fun sqliteVersion(): String {
        val c = dict?.rawQuery("SELECT sqlite_version()", null) ?: return "?"
        c.use { return if (it.moveToFirst()) it.getString(0) else "?" }
    }

    /**
     * 查询。
     * @param which  "dict" 只读词库 / "user" 可写用户库
     * @param sql    SQL 语句，占位符用 ?
     * @param args   JSON 数组形式的参数
     * @return       JSON：{ ok, rows:[{col:val}] } 或 { ok:false, error }
     */
    @JavascriptInterface
    fun query(which: String, sql: String, args: String): String {
        val db = dbOf(which) ?: return err("数据库未打开")
        return try {
            db.rawQuery(sql, bindArgs(args)).use { c ->
                val rows = JSONArray()
                val n = c.columnCount
                val names = Array(n) { c.getColumnName(it) }
                while (c.moveToNext()) {
                    val o = JSONObject()
                    for (i in 0 until n) {
                        when (c.getType(i)) {
                            android.database.Cursor.FIELD_TYPE_NULL -> o.put(names[i], JSONObject.NULL)
                            android.database.Cursor.FIELD_TYPE_INTEGER -> o.put(names[i], c.getLong(i))
                            android.database.Cursor.FIELD_TYPE_FLOAT -> o.put(names[i], c.getDouble(i))
                            else -> o.put(names[i], c.getString(i))
                        }
                    }
                    rows.put(o)
                }
                JSONObject().put("ok", true).put("rows", rows).toString()
            }
        } catch (e: Exception) {
            err("${e.message} :: ${sql.take(160)}")
        }
    }

    /**
     * 写入。返回受影响行数与最后插入的 rowid。
     *
     * 必须按语句类型二选一地执行：executeUpdateDelete() 和 executeInsert() 都会
     * 真正跑一遍语句，两个都调等于执行两次——history / quiz_log 这类没有主键的表
     * 会凭空多出重复行。
     */
    @JavascriptInterface
    fun exec(which: String, sql: String, args: String): String {
        val db = dbOf(which) ?: return err("数据库未打开")

        // 事务语句交给框架：直接 execSQL("BEGIN") 的话，BEGIN 和后续写入可能
        // 落在连接池里不同的连接上，事务边界就散了。
        when (verbOf(sql)) {
            "BEGIN" -> return runCatching { db.beginTransaction(); ok(0, -1) }
                .getOrElse { err(it.message ?: "开启事务失败") }
            "COMMIT", "END" -> return runCatching { db.setTransactionSuccessful(); db.endTransaction(); ok(0, -1) }
                .getOrElse { err(it.message ?: "提交事务失败") }
            "ROLLBACK" -> return runCatching { db.endTransaction(); ok(0, -1) }
                .getOrElse { err(it.message ?: "回滚事务失败") }
        }

        return try {
            val st = db.compileStatement(sql)
            bindArgs(args).forEachIndexed { i, v ->
                val p = i + 1
                when (v) {
                    null -> st.bindNull(p)
                    is Long -> st.bindLong(p, v)
                    is Double -> st.bindDouble(p, v)
                    else -> st.bindString(p, v.toString())
                }
            }
            val result = when (verbOf(sql)) {
                "INSERT", "REPLACE" -> {
                    val rowid = st.executeInsert()
                    // ON CONFLICT DO NOTHING 没插进去时 executeInsert 返回 -1，
                    // 而 DO UPDATE 分支确实改了行却也不更新 last_insert_rowid，
                    // 所以 changes 单独问一次才准。
                    ok(changesOf(db), rowid)
                }
                "UPDATE", "DELETE" -> ok(st.executeUpdateDelete(), -1)
                else -> { st.execute(); ok(0, -1) }
            }
            st.close()
            result
        } catch (e: Exception) {
            err("${e.message} :: ${sql.take(160)}")
        }
    }

    /** 不带参数、可能含多条语句的 DDL */
    @JavascriptInterface
    fun execScript(which: String, sql: String): String {
        val db = dbOf(which) ?: return err("数据库未打开")
        return try {
            // execSQL 一次只认一条语句，按分号切开逐条执行
            for (stmt in splitStatements(sql)) {
                if (stmt.isBlank()) continue
                if (verbOf(stmt) == "PRAGMA") pragma(db, stmt) else db.execSQL(stmt)
            }
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            err(e.message ?: "执行失败")
        }
    }

    private fun changesOf(db: SQLiteDatabase): Int =
        db.rawQuery("SELECT changes()", null).use { if (it.moveToFirst()) it.getInt(0) else 0 }

    private fun ok(changes: Int, rowid: Long) =
        JSONObject().put("ok", true).put("changes", changes).put("lastInsertRowid", rowid).toString()

    private fun err(msg: String) = JSONObject().put("ok", false).put("error", msg).toString()

    /** 取语句的首个关键字，跳过前导空白与注释 */
    private fun verbOf(sql: String): String {
        var i = 0
        while (i < sql.length) {
            val c = sql[i]
            when {
                c.isWhitespace() -> i++
                c == '-' && i + 1 < sql.length && sql[i + 1] == '-' -> {
                    while (i < sql.length && sql[i] != '\n') i++
                }
                c == '/' && i + 1 < sql.length && sql[i + 1] == '*' -> {
                    i += 2
                    while (i + 1 < sql.length && !(sql[i] == '*' && sql[i + 1] == '/')) i++
                    i += 2
                }
                else -> {
                    val start = i
                    while (i < sql.length && sql[i].isLetter()) i++
                    return sql.substring(start, i).uppercase()
                }
            }
        }
        return ""
    }

    /**
     * JSON 参数转绑定值。保持原本的类型：整数走 bindLong、小数走 bindDouble。
     * 全按字符串绑的话，写进 REAL/INTEGER 列要靠列亲和性回转，而没有亲和性的
     * 表达式比较（比如子查询结果）就会变成文本比较，静默算错。
     */
    private fun bindArgs(json: String): Array<Any?> {
        if (json.isBlank()) return emptyArray()
        val arr = JSONArray(json)
        return Array(arr.length()) { i ->
            when {
                arr.isNull(i) -> null
                else -> when (val v = arr.get(i)) {
                    is Int -> v.toLong()
                    is Long -> v
                    is Double -> v
                    is Boolean -> if (v) 1L else 0L
                    else -> v.toString()
                }
            }
        }
    }

    /** 按分号切分，跳过字符串字面量与注释里的分号 */
    private fun splitStatements(sql: String): List<String> {
        val out = mutableListOf<String>()
        val sb = StringBuilder()
        var i = 0
        while (i < sql.length) {
            val c = sql[i]
            when {
                c == '\'' -> {
                    sb.append(c); i++
                    while (i < sql.length) {
                        sb.append(sql[i])
                        if (sql[i] == '\'') {
                            // '' 是转义的单引号，不算字符串结束
                            if (i + 1 < sql.length && sql[i + 1] == '\'') { sb.append(sql[i + 1]); i++ }
                            else { i++; break }
                        }
                        i++
                    }
                }
                c == '-' && i + 1 < sql.length && sql[i + 1] == '-' -> {
                    while (i < sql.length && sql[i] != '\n') i++
                }
                c == '/' && i + 1 < sql.length && sql[i + 1] == '*' -> {
                    i += 2
                    while (i + 1 < sql.length && !(sql[i] == '*' && sql[i + 1] == '/')) i++
                    i += 2
                }
                c == ';' -> { out.add(sb.toString()); sb.setLength(0); i++ }
                else -> { sb.append(c); i++ }
            }
        }
        out.add(sb.toString())
        return out
    }
}
