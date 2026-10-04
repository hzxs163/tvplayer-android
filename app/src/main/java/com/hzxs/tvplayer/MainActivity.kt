package com.hzxs.tvplayer

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.WebViewAssetLoader

/**
 * WebView 宿主：把 assets 里的原样网页挂在 https://appassets.androidplatform.net 上，
 * 页面里所有相对的 /api/... 请求交给 LocalProxy 在手机上直接取源站。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var root: FrameLayout
    private var assetLoader: WebViewAssetLoader? = null
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var savedSystemUi = 0
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    companion object {
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://appassets.androidplatform.net/index.html"
        // 允许 chrome://inspect 连进来调试；不想开放就改成 false
        private const val DEBUG_INSPECT = true
        private const val REQ_FILE = 1001

        /**
         * 转横屏时把视频顶成全屏。Chrome 网页版是浏览器自己做的这件事，WebView 不做。
         * 先走标准 Fullscreen API（能走通就由 UA 自己合成全屏），拿不到全屏再退化成
         * 注入一段样式把播放区撑满视口 —— 两条路都不用模拟点击，任何 WebView 版本都成立。
         */
        private const val LANDSCAPE_JS = """
(function () {
    var sec = document.getElementById('player-section');
    var v = document.getElementById('player');
    if (!sec || !v || !sec.classList.contains('open')) return;
    if (document.fullscreenElement) return;
    function theater() {
        if (document.fullscreenElement) return;
        var s = document.getElementById('tv-landscape');
        if (!s) { s = document.createElement('style'); s.id = 'tv-landscape'; document.head.appendChild(s); }
        s.textContent = '#player-section{position:fixed!important;top:0;left:0;width:100vw!important;'
            + 'height:100vh!important;max-height:none!important;aspect-ratio:auto!important;'
            + 'border:0!important;border-radius:0!important;background:#000!important;z-index:2147483647!important}'
            + 'header,main>*:not(#player-section){display:none!important}';
    }
    try {
        var p = v.requestFullscreen({ navigationUI: 'hide' });
        if (p && p['catch']) p['catch'](theater);
    } catch (e) { theater(); }
    setTimeout(theater, 400);
})();
"""

        private const val PORTRAIT_JS = """
(function () {
    var s = document.getElementById('tv-landscape');
    if (s) s.remove();
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
})();
"""
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = FrameLayout(this)
        root.setBackgroundColor(Color.parseColor("#f5f0e8"))
        setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_HOST)
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            // 源列表、播放进度、分类缓存全在 localStorage，这个开关决定重装前数据还在不在
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            javaScriptCanOpenWindowsAutomatically = true
            useWideViewPort = true
            loadWithOverviewMode = true
            cacheMode = WebSettings.LOAD_DEFAULT
            // 兜底线路会把 http 的片子塞进 iframe，https 页面默认会当成混合内容拦掉
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        if (DEBUG_INSPECT) WebView.setWebContentsDebuggingEnabled(true)

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                val path = uri.path ?: return null
                if (!APP_HOST.equals(uri.host, true)) return null
                if (path.startsWith("/api/")) return LocalProxy.handle(request)
                return assetLoader?.shouldInterceptRequest(request.url)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
                enterFullscreen(view, callback)
            }

            override fun onHideCustomView() {
                exitFullscreen()
            }

            // <video> 没写 poster 时，Android WebView 会自己垫一张系统默认封面 ——
            // 就是那个又糊又大的灰圆+黑三角，网页端没有。样式表管不到它（不在 DOM 里），
            // 只能宿主还它一张全透明的图。
            override fun getDefaultVideoPoster(): Bitmap =
                Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)

            // 网页里的 <input type="file">（本地导入）必须宿主把选择器拉起来，
            // 不实现的话点按钮完全没有反应，页面也不会报错
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: WebChromeClient.FileChooserParams
            ): Boolean {
                // 上一次没结算掉的先清掉，否则页面会永远等在那里
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "*/*"
                    addCategory(Intent.CATEGORY_OPENABLE)
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
                }
                return try {
                    startActivityForResult(Intent.createChooser(intent, "选择源文件"), REQ_FILE)
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    false
                }
            }

            // 页面用 window.open 把片源丢到新窗口（「新窗口播放」）。
            // 不接这个回调时 WebView 直接返回 null，页面会当成弹窗被拦，
            // 所以建一个壳 WebView 只为拿到目标地址，再交给外部播放器/浏览器。
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message
            ): Boolean {
                val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
                val popup = WebView(this@MainActivity)
                popup.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        openExternal(request.url)
                        webView.post { runCatching { popup.destroy() } }
                        return true
                    }
                }
                transport.webView = popup
                resultMsg.sendToTarget()
                return true
            }
        }

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(START_URL)
        }
    }

    /**
     * 选择器返回后必须把结果结算给页面，一次都不漏。
     * 漏掉的话这个 input 会永远挂在等待状态，之后再点按钮同样没反应。
     */
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE) return
        val callback = filePathCallback
        filePathCallback = null
        if (callback == null) return
        val uris = if (resultCode == RESULT_OK) extractUris(data) else null
        callback.onReceiveValue(if (uris == null || uris.isEmpty()) null else uris)
    }

    // 单选从 data 回来，部分文件管理器即使单选也塞在 clipData 里，两边都收
    private fun extractUris(data: Intent?): Array<Uri> {
        val list = ArrayList<Uri>()
        data?.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { list.add(it) }
        }
        data?.data?.let { list.add(it) }
        return list.toTypedArray()
    }

    private fun openExternal(raw: Uri) {
        // 页面偶尔会把 /api/play?url=X 这种本机地址丢出来，外部应用不认识这个域名，
        // 所以要还原成真正的源站地址再交给系统
        val target = if (APP_HOST.equals(raw.host, true)) {
            raw.getQueryParameter("url") ?: raw.toString()
        } else {
            raw.toString()
        }
        if (target.isBlank()) return
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(target))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startActivity(intent)
        } catch (e: Exception) {
            webView.evaluateJavascript(
                "if (typeof toast === 'function') toast('没有能打开该地址的应用', 'error');", null
            )
        }
    }

    private fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (customView != null) {
            callback.onCustomViewHidden()
            return
        }
        customView = view
        customViewCallback = callback
        savedSystemUi = window.decorView.systemUiVisibility
        webView.visibility = View.GONE
        root.addView(
            view, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER
            )
        )
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    private fun exitFullscreen() {
        val view = customView ?: return
        root.removeView(view)
        customView = null
        webView.visibility = View.VISIBLE
        window.decorView.systemUiVisibility = savedSystemUi
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
    }

    override fun onBackPressed() {
        when {
            customView != null -> exitFullscreen()
            webView.canGoBack() -> webView.goBack()
            else -> super.onBackPressed()
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 等页面按新视口重排完再动，否则量到的还是旧布局
        webView.postDelayed({
            webView.evaluateJavascript(
                if (newConfig.orientation == Configuration.ORIENTATION_LANDSCAPE) LANDSCAPE_JS else PORTRAIT_JS,
                null
            )
        }, 260)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        webView.stopLoading()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }
}
