pluginManagement {
    repositories {
        // 国内直连 Google/Maven 很慢，优先走阿里云镜像，失败再回落官方源
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
        // requery 的 sqlite-android 只发在 jitpack，Maven Central 上没有
        maven("https://jitpack.io")
    }
}

rootProject.name = "Lexica"
include(":app")
