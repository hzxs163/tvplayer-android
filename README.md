# TVPlayer 安卓壳

把 `tvplayer-cf` 的网页原样装进一个 APK，**不依赖任何外部代理服务器**：取流、防盗链头、m3u8 地址重写全部在手机本地做。

`tvplayer-cf` 仓库的代码一行都不用改，这个目录是完全独立的工程。

## 架构

```
WebView  (页面挂在 https://appassets.androidplatform.net/)
   ├── /index.html /script.js ...   → APK 内的 assets（= tvplayer-cf 的静态文件，逐字节相同）
   └── /api/play?url=…  /api/proxy?url=…
                                    → LocalProxy.handle()  ← 拦在这里
                                    → HttpURLConnection 直接连源站（补 UA/Referer、透传 Range、
                                       手动跟随跨协议重定向、m3u8 里的分片与 KEY 地址重写回 /api/play）
```

页面挂在一个真实的 https 域名上（而不是 `file://`），是为了让原代码里的相对路径和 `window.location.origin` 都照常工作，因此不需要改动 `script.js`。

| 原来的 | 现在 |
| --- | --- |
| `functions/api/play.js` | `LocalProxy.media()` |
| `functions/api/proxy.js` | `LocalProxy.passthrough()` |
| Cloudflare 边缘缓存 | 无（本机直连，不需要） |

## 构建 APK（云端，本机不用装 Android SDK）

这台机器只需要 git。GitHub Actions 会拉 JDK 17 + Android SDK 34 + Gradle 8.7，跑 `assembleDebug`，产物以 artifact 形式给出。

1. 在 GitHub 网页上新建一个空仓库（比如 `tvplayer-android`），不要初始化 README。
2. 推送本工程（本目录已经 `git init` 并提交过，只需加 remote）：

```bash
cd tvplayer-android
git remote add origin git@github.com:你的账号/tvplayer-android.git
git push -u origin main
```

没有初始化过时：

```bash
git init -b main && git add -A && git commit -m "安卓壳：内置本地代理，原样承载 tvplayer-cf 网页"
```

3. 仓库页面 Actions → 「构建 APK」→ 跑完在 Artifacts 里下载 `TVPlayer-v<版本号>`，解压出来就是 `TVPlayer-v1.0.4.apk` 这样的文件名。
   版本号取自 `app/build.gradle` 的 `versionName`，只维护这一处：每次改完代码顺手把它和 `versionCode` 往上加一位，CI 出的包名和安装后的版本就跟着变，不会再出现一堆同名的 `app-debug.apk`。
4. 手机装：允许「安装未知来源」，直接传到手机点开，或 `adb install TVPlayer-v1.0.4.apk`。

调试签名（Gradle 自带 debug keystore）就能装，但**上不了 Google Play**——影视聚合类应用基本会被拒，这个项目本来就是自用。

## 更新网页内容

`tvplayer-cf` 改过之后，重新同步一次再推：

```bash
bash tools/sync-web.sh ../tvplayer-cf
```

脚本会逐个文件比对 sha256，保证进 APK 的字节和仓库里完全一致。

## 已知的行为差异

- 数据在 WebView 的 localStorage 里，按 `appassets.androidplatform.net` 这个域存，**和网页版不互通**；覆盖安装不动数据，卸载重装会清掉源列表和播放进度，卸载前先「导出/备份」。
- Service Worker 在 WebView 里不支持，`sw.js` 注册会失败并被现有 catch 吞掉，无影响。
- `<video>` 没有 `poster` 时，Android WebView 会垫一张系统默认封面（又糊又大的灰圆+黑三角），它在 DOM 里没有任何节点，样式表管不着；`WebChromeClient.getDefaultVideoPoster()` 返回一张全透明 1x1 图把它换掉，观感和网页端一致。
- 转到横屏不会自动全屏是 Chrome 自己做的事，WebView 不做。`onConfigurationChanged` 里注入脚本：先试标准 Fullscreen API，400ms 内没进全屏就退化成给 `#player-section` 打一段撑满视口的样式；转回竖屏时把两者都撤掉。
- **开着系统方向锁也一样能横过来播**：锁定时 Activity 根本不会收到 `onConfigurationChanged`，光靠上面那条等于失效。所以宿主自己读重力传感器（`OrientationEventListener`），播放中检测到横着拿就 `requestedOrientation = SCREEN_ORIENTATION_SENSOR_LANDSCAPE` —— 这个方向是「无视用户旋转锁」的一族，和 Chrome 全屏放视频用的是同一个口子；手动点视频的全屏按钮也走同一处。竖过来、退出全屏时才还原成 `SCREEN_ORIENTATION_USER`（继续听系统的锁）。只有 `#player-section` 带 `open` 时才扳，否则会把浏览页一起转成横屏。
- 「本地导入」用的是 `<input type="file">`，WebView 必须由宿主实现 `onShowFileChooser` 才会弹系统文件选择器，已经接上了；挑 `.json` 即可。
- 「新窗口播放」不再走复制兜底，而是把片源地址交给系统，用外部播放器或浏览器打开。注意它拿到的是源站原始地址，不带 App 里的防盗链 Referer，查 Referer 的源站可能拒绝。
- 源站是 http 的片子能直接放（`usesCleartextTraffic` + 允许混合内容），这点比浏览器版宽松。
- CI 出的是 debug 签名包。签名文件已从 Actions cache 复用，新包可以直接覆盖安装；只有第一次（或缓存被清理后）签名变了，需要先卸载旧版本再装。

## 内置代理的一条硬约束

`shouldInterceptRequest` 在 WebView 里是**一条私有线程串行调用**的：回调里等多久，页面同时发出的其它请求就排多久的队。页面的多源搜索是 6 路并发、每路 15 秒超时，所以 `/api/proxy` 绝不能在回调里同步等源站 —— 否则一个慢源会把所有快源一起拖死（表现就是网页端 7 条结果、App 里只剩 1 条）。现在的路子是回调立刻交出一根 `ParcelFileDescriptor` 管道的读端，真正的请求丢给线程池并行做。

## 安全说明

`LocalProxy` 拿到的 `url` 参数是外部数据，所以：

- 只允许 http/https，禁止 `file://`、`content://` 之类协议。
- 拦掉 `127.0.0.0/8`、`::1`、`0.0.0.0`、`169.254.0.0/16`（含云主机元数据地址），不让恶意源列表探测手机自身服务。
- **故意放行** `192.168.x.x`、`10.x` 这些局域网地址：很多人把 CMS 源站或片源放在家里 NAS 上，网页版走 Cloudflare 时够不着，App 里能够得着，这是它相对网页版的一个额外好处。

`MainActivity` 里 `DEBUG_INSPECT = true`，允许电脑用 `chrome://inspect` 调试手机上的页面；不想开放就改成 `false` 再构建。
