/* 版本对齐本机 Gradle 缓存里已有的（AGP 8.5.0 / Kotlin 2.0.0）。
   国内直连 Google Maven 很不稳，用缓存里现成的版本能免掉一次下载。 */
plugins {
    id("com.android.application") version "8.5.0" apply false
    id("org.jetbrains.kotlin.android") version "2.0.0" apply false
}
