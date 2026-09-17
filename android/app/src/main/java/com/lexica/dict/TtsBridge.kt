package com.lexica.dict

import android.content.Context
import android.speech.tts.TextToSpeech
import android.webkit.JavascriptInterface
import java.util.Locale

/**
 * 朗读。
 *
 * 不用 Web Speech API：安卓 WebView 里的 speechSynthesis 在很多机型上
 * 要么没有语音、要么静默失败，而系统 TextToSpeech 是稳的。
 */
class TtsBridge(context: Context) {

    /* 回调在 TTS 服务线程上触发，available()/speak() 在 WebView 的 JS 线程上读，
       所以要 volatile，否则 JS 线程可能一直看不到 ready 变 true。 */
    @Volatile private var ready = false

    /* 显式标类型：不写的话初始化 lambda 里引用 tts 会让类型推断成环。
       语言不在这里设——回调可能早于构造赋值完成，而 speak() 每次都会设。 */
    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
    }

    @JavascriptInterface
    fun available(): Boolean = ready

    /** @param accent "uk" 或 "us" */
    @JavascriptInterface
    fun speak(text: String, accent: String, rate: Float) {
        if (!ready || text.isBlank()) return
        tts.language = if (accent == "uk") Locale.UK else Locale.US
        tts.setSpeechRate(if (rate <= 0f) 1f else rate)
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "lexica")
    }

    @JavascriptInterface
    fun stop() {
        if (ready) tts.stop()
    }
}
