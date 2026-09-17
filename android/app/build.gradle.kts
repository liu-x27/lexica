plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.lexica.dict"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.lexica.dict"
        minSdk = 26          // Android 8.0：WebView 版本够新，SQLite 也带 FTS5
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    androidResources {
        // 词库必须以未压缩形式打进 APK：
        // 压缩过的 asset 只能顺序流式读取，没法 seek，
        // 首次启动往内部存储拷贝时会慢得多（而且拷完还得再解压一遍）
        noCompress += listOf("db")
    }

    buildTypes {
        release {
            isMinifyEnabled = false   // 只有一个 Activity 和几个桥接类，没必要混淆
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    packaging {
        resources.excludes += setOf("META-INF/*")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.0")

    /* 自带一份 SQLite，而不是用系统的。
       系统 SQLite 的版本跟着 Android 版本走：Android 12 是 3.32，
       而拼写纠错用的 trigram 分词器要 3.34+ 才有。用系统的话
       低版本手机一查就崩，且没法在编译期发现。这个库带 3.4x，全版本行为一致。 */
    implementation("com.github.requery:sqlite-android:3.45.0")
}
