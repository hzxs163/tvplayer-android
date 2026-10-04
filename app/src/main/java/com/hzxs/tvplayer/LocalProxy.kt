package com.hzxs.tvplayer

import android.os.ParcelFileDescriptor
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset
import java.util.concurrent.Executors

/**
 * App 内置代理，替代原来的 Cloudflare Pages Functions。
 *
 * 页面挂在 https://appassets.androidplatform.net 上，script.js 里那些相对的
 * /api/play、/api/proxy 请求会被 MainActivity 拦到这里，由手机自己直连源站取数据，
 * 不经过任何第三方服务器；源站的防盗链头与 m3u8 地址重写都在这里完成。
 */
object LocalProxy {

    private const val PLAY_PREFIX = "/api/play?url="
    private const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    private const val CONNECT_MS = 15000
    private const val READ_MS = 30000
    private const val MAX_REDIRECT = 5
    private val KEY_URI = Regex("URI=\"([^\"]+)\"")

    // 一次搜索并发 6 路、播放时分片也是并发取，线程数跟着请求走比排队划算
    private val pool = Executors.newCachedThreadPool { r ->
        Thread(r, "LocalProxy").apply { isDaemon = true }
    }

    fun handle(request: WebResourceRequest): WebResourceResponse {
        val uri = request.url
        val target = uri.getQueryParameter("url")
        if (target.isNullOrBlank()) return plain(400, "缺少 url 参数")

        val path = uri.path ?: ""
        return try {
            when (path) {
                "/api/play" -> media(target, headerOf(request.requestHeaders, "Range"))
                "/api/proxy" -> passthrough(target)
                else -> plain(404, "未知接口")
            }
        } catch (e: Exception) {
            plain(502, "代理请求失败: " + (e.message ?: e.javaClass.simpleName))
        }
    }

    // ============================================================
    //  播放：m3u8 读全文并重写内部地址，其余字节流原样透传
    // ============================================================
    private fun media(target: String, range: String?): WebResourceResponse {
        val playlist = target.contains(".m3u8") || target.contains(".m3u")
        val extra = HashMap<String, String>()
        // 清单要整体重写地址，带 Range 取清单会让重写结果和字节区间对不上
        if (!range.isNullOrBlank() && !playlist) extra["Range"] = range

        val conn = open(target, extra)
        val code = conn.responseCode
        val upstreamType = conn.contentType.orEmpty()

        if (playlist || upstreamType.contains("mpegurl")) {
            if (code !in 200..299) {
                conn.disconnect()
                return plain(code, "源站返回错误: $code")
            }
            val text = readText(conn)
            val base = conn.url.toString()
            if (text == null) {
                conn.disconnect()
                return plain(code, "源站没有返回清单")
            }
            val body = if (text.trimStart().startsWith("#EXTM3U")) rewriteM3u8(text, base) else text
            val bytes = body.toByteArray(Charsets.UTF_8)
            val headers = headersOf(conn, bytes.size.toLong())
            conn.disconnect()
            return WebResourceResponse(
                "application/vnd.apple.mpegurl", "utf-8", 200, "OK",
                headers, ByteArrayInputStream(bytes)
            )
        }

        val headers = headersOf(conn, conn.contentLength.toLong())
        val stream: InputStream = bodyStream(conn) ?: ByteArrayInputStream(ByteArray(0))
        // 这里不能 disconnect：流要交给 WebView 边读边播
        return WebResourceResponse(
            mimeOf(target, upstreamType), null, statusOf(code), reasonOf(code), headers, stream
        )
    }

    // ============================================================
    //  源站接口（CMS JSON）：回调立刻返回，取数据在后台线程并行做
    // ============================================================
    /**
     * WebView 的 shouldInterceptRequest 是在一条私有线程上串行调用的。在这里等源站，
     * 页面同时发出的其它请求就全排在后面 —— 多源搜索是 6 路并发、每路 15 秒超时，
     * 结果就是慢源把快源一起拖死，网页端 7 条到 App 里只剩 1 条。
     * 所以这里只交出一根管道，真正的请求丢给线程池，回调一微秒都不多待。
     */
    private fun passthrough(target: String): WebResourceResponse {
        // 用系统管道而不是内存缓冲：回调交出去的是读端，写端在后台线程边收边灌
        val fds = ParcelFileDescriptor.createPipe()
        val readEnd = ParcelFileDescriptor.AutoCloseInputStream(fds[0])
        val writeEnd = ParcelFileDescriptor.AutoCloseOutputStream(fds[1])
        pool.execute {
            var opened: HttpURLConnection? = null
            try {
                val conn = open(target, mapOf("Accept" to "application/json, text/plain, */*"))
                opened = conn
                val code = conn.responseCode
                val body = bodyStream(conn)
                when {
                    code !in 200..299 -> writeJsonError(writeEnd, code, "源站返回错误: " + code)
                    body == null -> writeJsonError(writeEnd, 502, "源站没有返回内容")
                    else -> {
                        // 按源站声明的字符集转成 UTF-8 再交出去：「解析播放」那条路走的是
                        // resp.text()，编码对不上就是一屏乱码，正则也捞不到 m3u8
                        val charset = charsetOf(conn).toCharset()
                        val text = body.use { String(it.readBytes(), charset) }
                        writeEnd.write(text.toByteArray(Charsets.UTF_8))
                    }
                }
            } catch (e: Exception) {
                writeJsonError(writeEnd, 502, "代理请求失败: " + (e.message ?: e.javaClass.simpleName))
            } finally {
                runCatching { writeEnd.close() }
                opened?.disconnect()
            }
        }
        // 状态码只能先定成 200：页面用 resp.json() 取数据，源站的失败已经变成
        // {"code":...,"msg":...} 写在正文里了，和原 proxy.js 的错误契约一致
        return WebResourceResponse("application/json", "utf-8", 200, "OK", headersOf(null, -1L), readEnd)
    }

    /** 写不进去一般说明页面已经把这个请求作废了（切页/重新搜索），没有可补救的 */
    private fun writeJsonError(out: OutputStream, code: Int, message: String) {
        val body = ("{\"code\":" + code + ",\"msg\":" + jsonQuote(message) + "}").toByteArray(Charsets.UTF_8)
        runCatching { out.write(body) }
    }

    private fun jsonQuote(s: String): String {
        val escaped = s.replace("\\", "\\\\").replace("\"", "\\\"").filter { it.code >= 32 }
        return "\"" + escaped + "\""
    }


    // ============================================================
    //  发起请求：伪装浏览器头 + 手动跟随跨协议重定向
    // ============================================================
    private fun open(rawTarget: String, extra: Map<String, String>): HttpURLConnection {
        var current = rawTarget
        var hops = 0
        while (true) {
            val url = URL(current)
            val proto = url.protocol.lowercase()
            if (proto != "http" && proto != "https") throw IllegalArgumentException("仅支持 http/https 协议")
            if (isBlockedHost(url.host)) throw SecurityException("禁止访问本机回环地址: " + url.host)

            val conn = url.openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = CONNECT_MS
            conn.readTimeout = READ_MS
            conn.requestMethod = "GET"
            conn.useCaches = false

            // 明确不要压缩：透明 gzip 会让 Content-Length 与实际字节数不一致，拖动进度条时错位
            conn.setRequestProperty("Accept-Encoding", "identity")
            conn.setRequestProperty("User-Agent", UA)
            conn.setRequestProperty("Accept", "*/*")
            conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            applyAntiLeech(conn, url)
            for ((k, v) in extra) conn.setRequestProperty(k, v)

            val code = conn.responseCode
            if (code in 300..399 && hops < MAX_REDIRECT) {
                val location = conn.getHeaderField("Location")
                conn.disconnect()
                if (location.isNullOrBlank()) throw IllegalStateException("源站重定向缺少 Location")
                current = resolve(location, conn.url.toString()) ?: location
                hops++
                continue
            }
            return conn
        }
    }

    /** 部分源站查 Referer 防盗链，按原 proxy.js 的主机表补齐 */
    private fun applyAntiLeech(conn: HttpURLConnection, url: URL) {
        val host = url.host.lowercase()
        val fake: String? = when {
            host.contains("huyall.com") || host.contains("baisiweiting.com") -> "https://1080p.huyall.com"
            host.contains("jisuzyv.com") || host.contains("jisuts.com") -> "https://vv.jisuzyv.com"
            host.contains("ffzy") -> "https://ffzy5.tv"
            else -> null
        }
        val origin = fake ?: (url.protocol + "://" + url.host + if (url.port > 0 && url.port != url.defaultPort) ":" + url.port else "")
        conn.setRequestProperty("Referer", origin + "/")
        conn.setRequestProperty("Origin", origin)
        if (host.contains("m3u8") || url.path.endsWith(".ts")) {
            conn.setRequestProperty("Accept", "application/vnd.apple.mpegurl, video/mp2t, */*;q=0.9")
        }
    }

    private fun headersOf(conn: HttpURLConnection?, contentLength: Long): Map<String, String> {
        val h = HashMap<String, String>()
        h["Access-Control-Allow-Origin"] = "*"
        h["Access-Control-Allow-Methods"] = "GET, OPTIONS"
        h["Cache-Control"] = "no-store"
        h["X-Cache"] = "LOCAL"
        if (conn != null) {
            for (name in arrayOf("Content-Range", "Accept-Ranges", "ETag", "Last-Modified")) {
                conn.getHeaderField(name)?.let { h[name] = it }
            }
        }
        if (contentLength >= 0) h["Content-Length"] = contentLength.toString()
        return h
    }

    // ============================================================
    //  m3u8 内部地址重写：分片与加密 KEY 都指回本机代理
    // ============================================================
    private fun rewriteM3u8(content: String, baseUrl: String): String {
        val out = ArrayList<String>()
        for (line in content.split("\n")) {
            val t = line.trim()
            when {
                t.isEmpty() -> out.add(line)
                t.startsWith("#EXT-X-KEY") -> out.add(
                    KEY_URI.replace(line) { m ->
                        val abs = resolve(m.groupValues[1], baseUrl)
                        if (abs == null) m.value else "URI=\"" + PLAY_PREFIX + enc(abs) + "\""
                    }
                )
                t.startsWith("#") -> out.add(line)
                t.startsWith("http://") || t.startsWith("https://") -> out.add(PLAY_PREFIX + enc(t))
                else -> {
                    val abs = resolve(t, baseUrl)
                    out.add(if (abs != null) PLAY_PREFIX + enc(abs) else line)
                }
            }
        }
        return out.joinToString("\n")
    }

    private fun resolve(path: String, base: String): String? = try {
        URL(URL(base), path).toString()
    } catch (e: Exception) {
        null
    }

    /** 与 JS encodeURIComponent 等价，保证 & = : 等字符不会破坏 query */
    private fun enc(s: String): String {
        val sb = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xFF
            val keep = (c in 97..122) || (c in 65..90) || (c in 48..57) ||
                c == 45 || c == 95 || c == 46 || c == 33 || c == 126 || c == 42 ||
                c == 39 || c == 40 || c == 41
            if (keep) sb.append(c.toChar()) else sb.append('%').append(String.format("%02X", c))
        }
        return sb.toString()
    }

    private fun readText(conn: HttpURLConnection): String? =
        readBytes(conn)?.let { String(it, charsetOf(conn).toCharset()) }

    private fun readBytes(conn: HttpURLConnection): ByteArray? =
        try { bodyStream(conn)?.use { it.readBytes() } } catch (e: Exception) { null }

    private fun bodyStream(conn: HttpURLConnection): InputStream? =
        try { conn.inputStream } catch (e: Exception) { conn.errorStream }

    private fun charsetOf(conn: HttpURLConnection): String {
        val raw = conn.contentType.orEmpty()
        val cs = raw.substringAfter("charset=", "").substringBefore(";").trim().trim('"')
        return if (cs.isEmpty()) "UTF-8" else cs
    }

    private fun String.toCharset(): Charset = try {
        Charset.forName(this)
    } catch (e: Exception) {
        Charsets.UTF_8
    }

    private fun mimeOf(target: String, upstream: String): String {
        val type = upstream.substringBefore(';').trim()
        if (type.isNotEmpty() && !type.equals("application/octet-stream", true)) return type
        val ext = target.substringBefore('?').substringAfterLast('.', "").lowercase()
        return when (ext) {
            "ts" -> "video/mp2t"
            "m3u8", "m3u" -> "application/vnd.apple.mpegurl"
            "mp4" -> "video/mp4"
            "mkv" -> "video/x-matroska"
            "js" -> "text/javascript"
            "json" -> "application/json"
            else -> "application/octet-stream"
        }
    }

    private fun headerOf(headers: Map<String, String>?, name: String): String? {
        if (headers == null) return null
        for ((k, v) in headers) if (k.equals(name, true)) return v
        return null
    }

    private fun plain(status: Int, message: String): WebResourceResponse {
        val bytes = message.toByteArray(Charsets.UTF_8)
        return WebResourceResponse(
            "text/plain", "utf-8", statusOf(status), reasonOf(status),
            headersOf(null, bytes.size.toLong()), ByteArrayInputStream(bytes)
        )
    }

    private fun statusOf(code: Int): Int = if (code in 100..599) code else 200

    private fun reasonOf(code: Int): String = when (code) {
        200 -> "OK"
        206 -> "Partial Content"
        301, 302, 307, 308 -> "Redirect"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        416 -> "Range Not Satisfiable"
        500 -> "Internal Server Error"
        502 -> "Bad Gateway"
        else -> "OK"
    }

    /**
     * 回环与链路本地必须拦：源列表是外部数据，不能让站点探测手机自己的服务。
     * 192.168./10. 这些局域网地址故意放行，很多人把源站和片源放在家里 NAS 上。
     */
    private fun isBlockedHost(host: String): Boolean {
        val h = host.lowercase().trim('[', ']', '.')
        if (h == "localhost" || h.endsWith(".localhost")) return true
        if (h == "::" || h == "::1" || h.startsWith("0:0:0:0:0:0:0:")) return true
        if (h.startsWith("127.")) return true
        if (h.startsWith("169.254.")) return true
        if (h == "0.0.0.0") return true
        return false
    }
}
