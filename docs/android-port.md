# Porting the renderer to Android

The desktop app and the Android app run the same renderer sources. `renderer/` is
byte-identical between the two and a test asserts it, so the copy cannot drift silently.
Three pieces bridge the gap:

- `cjs-runtime.js` — a minimal CommonJS loader, since the renderer is CJS and a WebView is not
- `android-sqlite.js` — a `node:sqlite`-shaped shim over a Kotlin `SqlBridge`
- Kotlin side: `AppBridge`, `SqlBridge`, `TtsBridge`

## The PRAGMA trap

This one cost the most time on first launch on a real device, because the error message
points nowhere near the cause.

`SQLiteDatabase.execSQL()` refuses any statement that returns rows. Several PRAGMAs
return a row in their *assignment* form, not just their query form — `PRAGMA mmap_size = N`
and `PRAGMA journal_mode = X` both do. So the call fails with:

```
Queries can be performed using SQLiteDatabase query or rawQuery methods only
```

which never mentions PRAGMA, and reads like a misuse of the query API rather than a
statement that happens to return a row. Every PRAGMA now goes through
`rawQuery(sql, null)`.

The general shape is worth keeping: an API that partitions statements by whether they
return rows will misclassify anything whose row-returning behaviour depends on its
arguments, and its error message will describe the partition rather than the statement.
