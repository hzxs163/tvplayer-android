// ============================================================
//  CONFIG
// ============================================================
const PROXY = (url) => '/api/proxy?url=' + encodeURIComponent(url);
const PLAY_PROXY = (url) => '/api/play?url=' + encodeURIComponent(url);
const CONCURRENCY = 6;
const FETCH_TIMEOUT = 15000;
const STORAGE_KEY = 'tv_data';
const STORAGE_SOURCES_KEY = 'tv_sources';
const STORAGE_DISCLAIMER_KEY = 'tv_disclaimer_agreed';
const STORAGE_PLAY_PROGRESS_KEY = 'tv_play_progress';
const STORAGE_VOLUME_KEY = 'tv_volume';
const STORAGE_RATE_KEY = 'tv_playback_rate';

// 共享 HLS 配置（消除重复，统一调优）
const HLS_CONFIG = {
    enableWorker: true,
    // 缓冲目标：原来要攒够 60 秒才稳，分片又都是串行取，起播与缓冲条涨得慢。
    // 降到 15 秒（上限 30 秒）先能播能拖，后续按需要再调大。
    maxBufferLength: 15,
    maxMaxBufferLength: 30,
    maxBufferSize: 20 * 1000 * 1000,
    maxBufferHole: 1.0,
    lowLatencyMode: false,
    liveBackBufferLength: 60,
    // 不要开 progressive：它让 hls.js 用 fetch 流式喂解复用器且分片之间不 flush，
    // 拖动进度时被打断的那一半数据会留在缓冲区里拼到下一片前面，
    // 表现为画面卡住、声音却从头播（浏览器原生播放器没这问题，实测拖动顺滑）
    fragLoadingMaxRetry: 8,
    fragLoadingRetryDelay: 500,
    fragLoadingMaxRetryTimeout: 180000,
    manifestLoadingMaxRetry: 6,
    manifestLoadingRetryDelay: 500,
    levelLoadingMaxRetry: 6,
    levelLoadingRetryDelay: 500,
    startFragPrefetch: true,
    testBandwidth: false,
    abrEwmaFastLive: 0.1,
    abrEwmaSlowLive: 1,
    abrEwmaFastVoD: 0.1,
    abrEwmaSlowVoD: 1,
    // 起播时的带宽猜测：5 Mbps 对经 CF 绕行的链路偏乐观，容易一上来挑高码率线路导致边播边掉缓冲
    abrEwmaDefaultEstimate: 2.5e6,
    abrBandWidthFactor: 0.7,
    abrBandWidthUpFactor: 0.95,
    xhrSetup: function(xhr, xhrUrl) {
        try {
            const urlObj = new URL(xhrUrl);
            xhr.setRequestHeader('Referer', urlObj.origin + '/');
            xhr.setRequestHeader('Origin', urlObj.origin);
            xhr.setRequestHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        } catch (e) {}
    }
};

function createHls() {
    return new Hls(HLS_CONFIG);
}

// ============================================================
//  直连探测：很多源站已经允许跨域，浏览器自己取片比走 /api/play 快得多
//  （少一跳，也不受 Cloudflare 出口 IP 被源站拒绝的影响）
// ============================================================
const directProbeCache = new Map();

async function canPlayDirect(url) {
    let host;
    try {
        host = new URL(url).host;
    } catch (e) {
        return false;
    }
    if (directProbeCache.has(host)) return directProbeCache.get(host);

    let ok = false;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const resp = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
        clearTimeout(timer);
        ok = resp.ok;
    } catch (e) {
        ok = false; // CORS 被拒或网络失败
    }
    directProbeCache.set(host, ok);
    return ok;
}

// ============================================================
//  续播定位：清单刚解析时 video.duration 常常还是 NaN，
//  此时直接赋 currentTime 会被夹回 0（表现为"声音从头播"），
//  所以等 duration 就绪再跳
// ============================================================
function seekWhenReady(video, at) {
    const apply = function () {
        if (video.duration > at + 1) {
            cleanup();
            try { video.currentTime = at; } catch (e) {}
        }
    };
    const cleanup = function () {
        video.removeEventListener('durationchange', apply);
        clearTimeout(giveUp);
    };
    const giveUp = setTimeout(cleanup, 10000);
    video.addEventListener('durationchange', apply);
    apply();
}

// ============================================================
//  挂载 HLS：useDirect 为 true 时清单与分片全部浏览器直连
//  出错按「原地恢复 -> 换路重来 -> 提示换线路」三级处理，
//  已经能播的片子不会因为一次拉取失败就被拆掉
// ============================================================
function attachHls(url, title, video, useDirect, allowSwitch, resumeAt) {
    if (state.hlsInstance) {
        state.hlsInstance.destroy();
        state.hlsInstance = null;
    }

    const hls = createHls();
    state.hlsInstance = hls;

    let started = false;   // 清单是否解析成功过（解析过说明这条路本身走得通）
    let netRetry = 0;
    let mediaRetry = 0;

    hls.on(Hls.Events.MANIFEST_PARSED, function () {
        started = true;
        video.style.minHeight = '';
        hidePlayerLoading();
        if (resumeAt > 1) seekWhenReady(video, resumeAt);
        video.play().catch(function () {});
        console.log(useDirect ? '✅ 直连 HLS 播放成功' : '✅ 代理 HLS 播放成功');
    });

    hls.on(Hls.Events.ERROR, function (e, data) {
        video.style.minHeight = '';
        console.warn('⚠️ HLS 错误:', data.details, data.type);
        if (!data.fatal) return;

        // 1) 解码/缓冲类错误：hls.js 自带恢复，不打断播放进度
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetry < 3) {
            mediaRetry++;
            console.warn('恢复媒体错误', mediaRetry);
            hls.recoverMediaError();
            return;
        }

        // 2) 网络类错误但已经播过：先原地重拉，别急着换路（拖动进度时最常见的就是单次超时）
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && started && netRetry < 2) {
            netRetry++;
            console.warn('重拉分片', netRetry);
            hls.startLoad();
            return;
        }

        // 3) 这条路确实走不通：换另一条，并接着刚才的进度继续
        if (allowSwitch) {
            const at = video.currentTime || 0;
            toast(useDirect ? '直连取片失败，改用代理续播' : '代理失败，改回直连续播', 'info');
            hls.destroy();
            if (state.hlsInstance === hls) state.hlsInstance = null;
            attachHls(url, title, video, !useDirect, false, at);
            return;
        }

        toast('这条路走不通（' + data.details + '），请换一条线路', 'error');
        startPlayerInIframe(url, title);
    });

    hls.loadSource(useDirect ? url : PLAY_PROXY(url));
    hls.attachMedia(video);
}

// ============================================================
//  播放器偏好：音量 / 速度记忆
// ============================================================
function applySavedVolume() {
    try {
        const v = parseFloat(localStorage.getItem(STORAGE_VOLUME_KEY));
        if (!isNaN(v) && v >= 0 && v <= 1) {
            dom.player.volume = v;
        }
    } catch (e) {}
}

function restorePlaybackSpeed() {
    try {
        const r = parseFloat(localStorage.getItem(STORAGE_RATE_KEY));
        if (!isNaN(r) && r >= 0.5 && r <= 2) {
            dom.player.playbackRate = r;
            const sel = document.getElementById('rateSelect');
            if (sel) sel.value = String(r);
        }
    } catch (e) {}
}

function changePlaybackRate(rate) {
    rate = parseFloat(rate) || 1;
    dom.player.playbackRate = rate;
    try {
        localStorage.setItem(STORAGE_RATE_KEY, String(rate));
    } catch (e) {}
    toast('播放速度: ' + rate + 'x', 'info');
}

// ============================================================
//  API 适配器 - 自动探测不同影视站点的参数格式
// ============================================================
const API_ADAPTERS = {
    // 红牛/苹果CMS风格：ac=videolist
    'videolist': {
        detect: (data) => data && data.list && data.class && data.pagecount,
        list: (api, page, category) => {
            let url = `${api}?ac=videolist&pg=${page}`;
            if (category) url += `&t=${category}`;
            return url;
        },
        search: (api, keyword) => `${api}?ac=list&wd=${encodeURIComponent(keyword)}`,
        detail: (api, id) => `${api}?ac=detail&ids=${id}`,
        extractClass: (data) => data.class || [],
        extractList: (data) => data.list || [],
        extractPageCount: (data) => parseInt(data.pagecount) || 1,
    },
    // 通用风格：ac=list
    'list': {
        detect: (data) => data && data.list && data.code === 1 && !data.class,
        list: (api, page, category) => {
            let url = `${api}?ac=list&pg=${page}`;
            if (category) url += `&t=${category}`;
            return url;
        },
        search: (api, keyword) => `${api}?ac=search&wd=${encodeURIComponent(keyword)}`,
        detail: (api, id) => `${api}?ac=detail&ids=${id}`,
        extractClass: (data) => data.class || [],
        extractList: (data) => data.list || [],
        extractPageCount: (data) => parseInt(data.pagecount) || 1,
    },
    // 默认适配器（自动适配）
    'auto': {
        detect: () => true,
        list: (api, page, category) => {
            return `${api}?ac=videolist&pg=${page}`;
        },
        search: (api, keyword) => `${api}?ac=list&wd=${encodeURIComponent(keyword)}`,
        detail: (api, id) => `${api}?ac=detail&ids=${id}`,
        extractClass: (data) => data.class || [],
        extractList: (data) => data.list || [],
        extractPageCount: (data) => parseInt(data.pagecount) || parseInt(data.total) || 1,
    }
};

// ============================================================
//  探测缓存
// ============================================================
const _adapterCache = new Map();

// ============================================================
//  分类缓存（新增）
// ============================================================
const _classCache = new Map();

// ============================================================
//  分类缓存 - localStorage 持久化（永久有效）
// ============================================================
const CLASS_CACHE_KEY = 'tv_class_cache';

function getClassCache(api) {
    try {
        const raw = localStorage.getItem(CLASS_CACHE_KEY);
        if (!raw) return null;
        const cache = JSON.parse(raw);
        const item = cache[api];
        if (!item) return null;
        return item.data;
    } catch (e) {
        return null;
    }
}

function setClassCache(api, classes) {
    try {
        const raw = localStorage.getItem(CLASS_CACHE_KEY);
        const cache = raw ? JSON.parse(raw) : {};
        cache[api] = {
            data: classes,
            time: Date.now()
        };
        localStorage.setItem(CLASS_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {}
}

function clearClassCache() {
    if (confirm('确定要清空所有分类缓存吗？')) {
        localStorage.removeItem(CLASS_CACHE_KEY);
        if (typeof _classCache !== 'undefined') {
            _classCache.clear();
        }
        toast('✅ 分类缓存已清空', 'success');
        if (state.source) {
            loadBrowse(state.source);
        }
    }
}

window.clearClassCache = clearClassCache;

function showClassCache() {
    try {
        const raw = localStorage.getItem(CLASS_CACHE_KEY);
        if (!raw) {
            toast('📭 分类缓存为空', 'info');
            console.log('📭 分类缓存为空');
            return;
        }
        const cache = JSON.parse(raw);
        const keys = Object.keys(cache);
        let msg = `📦 已缓存 ${keys.length} 个源的分类\n`;
        keys.forEach(key => {
            const item = cache[key];
            const time = new Date(item.time).toLocaleString();
            const count = item.data?.length || 0;
            const name = key.replace(/^https?:\/\//, '').replace(/\/api\.php.*$/, '').substring(0, 30);
            msg += `\n  ${name}: ${count} 个分类 (${time})`;
        });
        console.log(msg);
        toast(`📦 已缓存 ${keys.length} 个源的分类`, 'info');
    } catch (e) {
        toast('查看缓存失败', 'error');
        console.warn(e);
    }
}

window.showClassCache = showClassCache;

async function detectAdapter(api) {
    if (_adapterCache.has(api)) return _adapterCache.get(api);
    
    // 先尝试 ac=videolist
    try {
        const data = await fetchProxy(`${api}?ac=videolist&pg=1`);
        if (data) {
            for (const [name, adapter] of Object.entries(API_ADAPTERS)) {
                if (name !== 'auto' && adapter.detect(data)) {
                    _adapterCache.set(api, adapter);
                    console.log(`✅ 探测到适配器: ${name}`);
                    return adapter;
                }
            }
        }
    } catch (e) {}
    
    // 再尝试 ac=list
    try {
        const data = await fetchProxy(`${api}?ac=list&pg=1`);
        if (data) {
            for (const [name, adapter] of Object.entries(API_ADAPTERS)) {
                if (name !== 'auto' && adapter.detect(data)) {
                    _adapterCache.set(api, adapter);
                    console.log(`✅ 探测到适配器: ${name}`);
                    return adapter;
                }
            }
        }
    } catch (e) {}
    
    // 默认自动适配器
    console.log('⚠️ 使用自动适配器');
    _adapterCache.set(api, API_ADAPTERS.auto);
    return API_ADAPTERS.auto;
}

// ============================================================
//  智能 API 请求
// ============================================================
async function smartApiRequest(source, action, params = {}) {
    const { api } = source;
    const { page = 1, category = null, keyword = null, id = null } = params;
    
    const adapter = await detectAdapter(api);
    
    let url = '';
    switch (action) {
        case 'list':
            url = adapter.list(api, page, category);
            break;
        case 'search':
            url = adapter.search(api, keyword);
            break;
        case 'detail':
            url = adapter.detail(api, id);
            break;
        default:
            url = `${api}?ac=videolist&pg=${page}`;
    }
    
    const data = await fetchProxy(url);
    if (!data) return null;
    
    return {
        list: adapter.extractList(data),
        class: adapter.extractClass(data),
        pagecount: adapter.extractPageCount(data),
        raw: data,
    };
}

// ============================================================
//  STATE
// ============================================================
const state = {
    sources: [],
    source: null,
    category: null,
    page: 1,
    totalPages: 1,
    categories: [],
    movies: [],
    searchResults: [],
    searchSeq: 0,
    currentVod: null,
    currentSource: null,
    currentLines: [],
    currentLineIndex: 0,
    currentEpisodes: [],
    currentEpisodeName: '',
    currentUrl: '',
    favorites: [],
    history: [],
    isPlaying: false,
    isLoading: false,
    editingKey: null,
    hlsInstance: null,
    currentController: null,
};

// ============================================================
//  DOM REFS
// ============================================================
const $ = (id) => document.getElementById(id);
const dom = {
    sourceSelect: $('sourceSelect'),
    searchInput: $('searchInput'),
    searchBtn: $('searchBtn'),
    status: $('status'),

    pageBrowse: $('pageBrowse'),
    pageSearch: $('pageSearch'),

    categoryNav: $('categoryNav'),
    browseGrid: $('browseGrid'),
    browseTitle: $('browseTitle'),
    browseBadge: $('browseBadge'),
    browseInfo: $('browseInfo'),
    pageInfo: $('pageInfo'),
    pageInfo2: $('pageInfo2'),
    browseHeader: $('browseHeader'),
    browsePager: $('browsePager'),

    emptyState: $('emptyState'),
    searchGrid: $('searchGrid'),
    resultStats: $('resultStats'),

    playerSection: $('player-section'),
    player: $('player'),
    playerIframe: $('player-iframe'),
    nowPlaying: $('nowPlaying'),
    m3u8Link: $('m3u8Link'),
    lineSelect: $('lineSelect'),
    episodesPanel: $('episodes-panel'),
    episodesList: $('episodes-list'),
    playerControls: $('playerControls'),

    importModal: $('importModal'),
    importTextarea: $('importTextarea'),
    importCount: $('importCount'),
    sourceList: $('sourceList'),

    playerLoading: $('player-loading'),
};

// ============================================================
//  STORAGE
// ============================================================
function loadStorage() {
    try {
        const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        state.favorites = data.favorites || [];
        state.history = data.history || [];
    } catch { state.favorites = [];
        state.history = []; }
}

function saveStorage() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        favorites: state.favorites,
        history: state.history,
    }));
}

function isFav(vodId, sourceKey) {
    return state.favorites.some(f => f.vodId === vodId && f.sourceKey === sourceKey);
}

function toggleFav() {
    if (!state.currentVod || !state.currentSource) return;
    const id = state.currentVod.vod_id;
    const key = state.currentSource.key;
    const idx = state.favorites.findIndex(f => f.vodId === id && f.sourceKey === key);
    if (idx > -1) {
        state.favorites.splice(idx, 1);
        toast('已取消收藏', 'info');
    } else {
        state.favorites.push({ vodId: id, sourceKey: key, name: state.currentVod.vod_name, poster: state.currentVod
                .vod_pic });
        toast('⭐ 已收藏', 'success');
    }
    saveStorage();
}

function addHistory(vod, source, episode) {
    const entry = {
        vodId: vod.vod_id,
        sourceKey: source.key,
        name: vod.vod_name,
        poster: vod.vod_pic,
        episode: episode || '',
        time: Date.now()
    };
    state.history = state.history.filter(h => !(h.vodId === entry.vodId && h.sourceKey === entry.sourceKey));
    state.history.unshift(entry);
    if (state.history.length > 100) state.history.pop();
    saveStorage();
}

// ============================================================
//  断点续播 - 存储播放进度
// ============================================================
function savePlayProgress(vodId, sourceKey, episode, currentTime, duration) {
    try {
        const key = `${vodId}_${sourceKey}`;
        const data = {
            episode: episode || '',
            currentTime: currentTime || 0,
            duration: duration || 0,
            updatedAt: Date.now()
        };
        const all = JSON.parse(localStorage.getItem(STORAGE_PLAY_PROGRESS_KEY) || '{}');
        all[key] = data;
        localStorage.setItem(STORAGE_PLAY_PROGRESS_KEY, JSON.stringify(all));
    } catch (e) {
        // 静默失败
    }
}

function getPlayProgress(vodId, sourceKey) {
    try {
        const key = `${vodId}_${sourceKey}`;
        const all = JSON.parse(localStorage.getItem(STORAGE_PLAY_PROGRESS_KEY) || '{}');
        return all[key] || null;
    } catch (e) {
        return null;
    }
}

// ============================================================
//  SOURCES 管理
// ============================================================
function getStoredSources() {
    try {
        const stored = localStorage.getItem(STORAGE_SOURCES_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length) {
                return parsed;
            }
        }
    } catch (e) {}
    return null;
}

function setStoredSources(sources) {
    localStorage.setItem(STORAGE_SOURCES_KEY, JSON.stringify(sources));
}

async function loadSources() {
    const stored = getStoredSources();
    if (stored) {
        return stored;
    }
    // 回退：首次访问时加载内置默认源（sources.json），部署后开箱即用
    try {
        const resp = await fetch('/sources.json', { cache: 'no-cache' });
        if (!resp.ok) return [];
        const data = await resp.json();
        if (Array.isArray(data) && data.length) {
            const normalized = normalizeSource(data);
            if (normalized.length) {
                // 仅在用户从未配置过源时写入，避免覆盖用户后续的修改
                if (!getStoredSources()) setStoredSources(normalized);
                return normalized;
            }
        }
    } catch (e) { /* 静默失败 */ }
    return [];
}

function hasSources() {
    return state.sources && state.sources.length > 0;
}

// ============================================================
//  隐藏源切换
// ============================================================
let showHiddenSources = false;

function toggleShowHiddenSources() {
    showHiddenSources = !showHiddenSources;
    populateSelect();
}

// ============================================================
//  源列表渲染（弹窗内）- 可拖拽排序
// ============================================================
function renderSourceList() {
    const container = dom.sourceList;
    const sources = getStoredSources() || [];

    if (!sources.length) {
        container.innerHTML = '<div class="empty-hint">📭 暂无源，请导入</div>';
        dom.importCount.textContent = '0 个';
        const validEl = document.getElementById('validCount');
        const invalidEl = document.getElementById('invalidCount');
        if (validEl) validEl.textContent = '🟢 0';
        if (invalidEl) invalidEl.textContent = '🔴 0';
        return;
    }

    let visibleSources = sources;
    if (!showHiddenSources) {
        visibleSources = sources.filter(s => s.enabled !== false);
    }

    const validSources = visibleSources.filter(s => s.disabled !== true);
    const invalidSources = visibleSources.filter(s => s.disabled === true);

    dom.importCount.textContent = visibleSources.length + ' 个';
    const validEl = document.getElementById('validCount');
    const invalidEl = document.getElementById('invalidCount');
    if (validEl) validEl.textContent = '🟢 ' + validSources.length;
    if (invalidEl) invalidEl.textContent = '🔴 ' + invalidSources.length;

    let html = '';

    // 有效源分组
    if (validSources.length) {
        html += `<div class="group-label"><span class="dot stable"></span> 🟢 有效 (${validSources.length})</div>`;
        validSources.forEach((s, index) => {
            const isEditing = state.editingKey === s.key;
            html += `
                <div class="source-item" style="${isEditing ? 'border-color:var(--primary);' : ''} display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-radius:8px; background:var(--bg); margin-bottom:4px; border:1px solid transparent;" 
                     draggable="true" 
                     data-index="${index}"
                     data-key="${esc(s.key)}">
                    <div style="display:flex; align-items:center; gap:14px; flex:1;">
                        <span style="cursor:grab; color:var(--text3); font-size:16px;">☰</span>
                        <span style="font-weight:500; color:var(--text);">${esc(s.name)}</span>
                        <span style="color:var(--text3); font-size:12px;">${esc(s.key)}</span>
                        <span style="font-size:12px; color:#2e7d32;">🟢有效</span>
                    </div>
                    <div style="display:flex; gap:6px; flex-shrink:0;">
                        <button class="edit-btn" onclick="editSource('${esc(s.key)}')" style="padding:3px 12px; font-size:12px; border-radius:4px; border:none; cursor:pointer; color:var(--primary); background:var(--primary-dim);">编辑</button>
                        <button class="del-btn" onclick="deleteSource('${esc(s.key)}')" style="padding:3px 12px; font-size:12px; border-radius:4px; border:none; cursor:pointer; color:#c0392b; background:rgba(192,57,43,0.08);">删除</button>
                    </div>
                </div>
            `;
        });
    }

    // 失效源分组
    if (invalidSources.length) {
        html += `<div class="group-label"><span class="dot backup"></span> 🔴 失效 (${invalidSources.length})</div>`;
        invalidSources.forEach((s, index) => {
            const isEditing = state.editingKey === s.key;
            const realIndex = validSources.length + index;
            html += `
                <div class="source-item" style="${isEditing ? 'border-color:var(--primary);' : ''} display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-radius:8px; background:var(--bg); margin-bottom:4px; border:1px solid transparent; opacity:0.7;" 
                     draggable="true" 
                     data-index="${realIndex}"
                     data-key="${esc(s.key)}">
                    <div style="display:flex; align-items:center; gap:14px; flex:1;">
                        <span style="cursor:grab; color:var(--text3); font-size:16px;">☰</span>
                        <span style="font-weight:500; color:var(--text3);">${esc(s.name)}</span>
                        <span style="color:var(--text3); font-size:12px;">${esc(s.key)}</span>
                        <span style="font-size:12px; color:#c62828;">🔴失效</span>
                    </div>
                    <div style="display:flex; gap:6px; flex-shrink:0;">
                        <button class="edit-btn" onclick="editSource('${esc(s.key)}')" style="padding:3px 12px; font-size:12px; border-radius:4px; border:none; cursor:pointer; color:var(--primary); background:var(--primary-dim);">编辑</button>
                        <button class="del-btn" onclick="deleteSource('${esc(s.key)}')" style="padding:3px 12px; font-size:12px; border-radius:4px; border:none; cursor:pointer; color:#c0392b; background:rgba(192,57,43,0.08);">删除</button>
                    </div>
                </div>
            `;
        });
    }

    // 添加清空缓存按钮
    html += `
        <div style="display:flex; gap:10px; margin-top:12px; padding-top:10px; border-top:1px solid var(--border); flex-wrap:wrap;">
            <button class="btn btn-ghost" onclick="clearClassCache()" style="font-size:12px; color:#c0392b; border:1px solid #c0392b; padding:4px 14px; border-radius:4px; cursor:pointer; background:transparent;">
                🗑️ 清空分类缓存
            </button>
            <button class="btn btn-ghost" onclick="showClassCache()" style="font-size:12px; color:var(--text2); border:1px solid var(--border); padding:4px 14px; border-radius:4px; cursor:pointer; background:transparent;">
                📦 查看缓存
            </button>
        </div>
    `;

    container.innerHTML = html;

    // 添加拖拽排序事件
    setupDragAndDrop();
}

// ============================================================
//  拖拽排序
// ============================================================
let dragStartIndex = null;
let dragEnterCount = 0;

function setupDragAndDrop() {
    const items = document.querySelectorAll('.source-item[draggable="true"]');
    
    items.forEach(item => {
        item.removeEventListener('dragstart', handleDragStart);
        item.removeEventListener('dragend', handleDragEnd);
        item.removeEventListener('dragover', handleDragOver);
        item.removeEventListener('dragenter', handleDragEnter);
        item.removeEventListener('dragleave', handleDragLeave);
        item.removeEventListener('drop', handleDrop);
        
        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('dragend', handleDragEnd);
        item.addEventListener('dragover', handleDragOver);
        item.addEventListener('dragenter', handleDragEnter);
        item.addEventListener('dragleave', handleDragLeave);
        item.addEventListener('drop', handleDrop);
    });
}

function handleDragStart(e) {
    dragStartIndex = parseInt(this.dataset.index);
    this.style.opacity = '0.4';
    this.style.borderColor = 'var(--primary)';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.key);
}

function handleDragEnd(e) {
    this.style.opacity = '';
    this.style.borderColor = '';
    document.querySelectorAll('.source-item').forEach(el => {
        el.style.borderColor = '';
        el.style.background = '';
    });
    dragEnterCount = 0;
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(e) {
    e.preventDefault();
    dragEnterCount++;
    if (this !== e.target) return;
    this.style.borderColor = 'var(--primary)';
    this.style.background = 'var(--primary-dim)';
}

function handleDragLeave(e) {
    dragEnterCount--;
    if (dragEnterCount > 0) return;
    this.style.borderColor = '';
    this.style.background = '';
}

function handleDrop(e) {
    e.preventDefault();
    dragEnterCount = 0;
    this.style.borderColor = '';
    this.style.background = '';

    const dragKey = e.dataTransfer.getData('text/plain');
    const dropKey = this.dataset.key;
    
    if (dragKey === dropKey) return;
    if (!dragKey || !dropKey) return;

    const sources = getStoredSources() || [];
    const dragIndex = sources.findIndex(s => s.key === dragKey);
    const dropIndex = sources.findIndex(s => s.key === dropKey);
    
    if (dragIndex === -1 || dropIndex === -1) return;

    const [movedItem] = sources.splice(dragIndex, 1);
    sources.splice(dropIndex, 0, movedItem);

    setStoredSources(sources);
    state.sources = sources;
    renderSourceList();
    toast('✅ 排序已更新', 'success');
}

// ============================================================
//  编辑源
// ============================================================
function editSource(key) {
    const sources = getStoredSources() || [];
    const item = sources.find(s => s.key === key);
    if (!item) {
        toast('未找到该源', 'error');
        return;
    }
    state.editingKey = key;
    dom.importTextarea.value = JSON.stringify(item, null, 2);
    renderSourceList();
    dom.importTextarea.focus();
    dom.importTextarea.scrollTop = 0;
    toast('已加载到编辑区，修改后点击「保存」', 'info');
}

// ============================================================
//  删除源
// ============================================================
function deleteSource(key) {
    if (!confirm(`确定要删除源 "${key}" 吗？`)) return;
    const sources = getStoredSources() || [];
    const filtered = sources.filter(s => s.key !== key);
    if (filtered.length === sources.length) {
        toast('未找到该源', 'error');
        return;
    }
    setStoredSources(filtered);
    state.sources = filtered;
    if (state.editingKey === key) {
        state.editingKey = null;
        dom.importTextarea.value = '';
    }
    renderSourceList();
    populateSelect();
    if (!filtered.length) {
        renderEmptyState();
    } else {
        const first = filtered.find(s => s.group === 'stable') || filtered[0];
        if (first) {
            dom.sourceSelect.value = first.key;
        }
    }
    toast('✅ 已删除', 'success');
}

// ============================================================
//  导入功能
// ============================================================
function showImportModal() {
    dom.importModal.classList.add('open');
    renderSourceList();
    if (!state.editingKey) {
        dom.importTextarea.value = '';
    }
    document.body.style.overflow = 'hidden';
}

function closeImportModal() {
    dom.importModal.classList.remove('open');
    state.editingKey = null;
    dom.importTextarea.value = '';
    document.body.style.overflow = '';
}

function importSources() {
    const raw = dom.importTextarea.value.trim();
    if (!raw) { toast('请粘贴 JSON 内容', 'error'); return; }

    try {
        let data = JSON.parse(raw);
        // 编辑单个源时 textarea 里是一个对象而非数组，两种都要能保存
        if (data && !Array.isArray(data) && typeof data === 'object') data = [data];
        if (!Array.isArray(data) || !data.length) {
            throw new Error('格式错误：需要非空数组或单个源对象');
        }
        for (const item of data) {
            if (!item.key || !item.name || !item.api) {
                throw new Error('每个源必须包含 key, name, api 字段');
            }
        }

        let currentSources = getStoredSources() || [];
        
        if (state.editingKey) {
            const idx = currentSources.findIndex(s => s.key === state.editingKey);
            if (idx > -1) {
                currentSources[idx] = data[0];
            } else {
                currentSources.push(data[0]);
            }
            state.editingKey = null;
            setStoredSources(currentSources);
            toast('✅ 更新成功', 'success');
        } else {
            let addedCount = 0;
            let updatedCount = 0;
            let skippedCount = 0;

            data.forEach(newItem => {
                const idx = currentSources.findIndex(ex => ex.key === newItem.key);
                if (idx === -1) {
                    currentSources.push(newItem);
                    addedCount++;
                } else if (JSON.stringify(currentSources[idx]) !== JSON.stringify(newItem)) {
                    currentSources[idx] = newItem;
                    updatedCount++;
                } else {
                    skippedCount++;
                }
            });

            setStoredSources(currentSources);
            toast(`✅ 导入完成：新增 ${addedCount} 个，更新 ${updatedCount} 个，跳过 ${skippedCount} 个相同源`, 'success');
        }

        state.sources = getStoredSources() || [];
        closeImportModal();
        populateSelect();
        
        if (state.sources.length) {
            const first = state.sources.find(s => s.group === 'stable') || state.sources[0];
            if (first) {
                dom.sourceSelect.value = first.key;
                loadBrowse(first);
            }
        } else {
            renderEmptyState();
        }
    } catch (e) {
        toast('JSON 格式错误: ' + e.message, 'error');
    }
}

function importFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!Array.isArray(data) || !data.length) {
                throw new Error('格式错误：需要非空数组');
            }
            for (const item of data) {
                if (!item.key || !item.name || !item.api) {
                    throw new Error('每个源必须包含 key, name, api 字段');
                }
            }
            
            let currentSources = getStoredSources() || [];
            let addedCount = 0;
            let skippedCount = 0;
            
            data.forEach(newItem => {
                const exists = currentSources.some(ex => ex.key === newItem.key);
                if (!exists) {
                    currentSources.push(newItem);
                    addedCount++;
                } else {
                    skippedCount++;
                }
            });
            
            setStoredSources(currentSources);
            state.sources = currentSources;
            toast(`✅ 导入完成：新增 ${addedCount} 个，跳过 ${skippedCount} 个重复源`, 'success');
            closeImportModal();
            populateSelect();
            const first = state.sources.find(s => s.group === 'stable') || state.sources[0];
            if (first) {
                dom.sourceSelect.value = first.key;
                loadBrowse(first);
            } else {
                renderEmptyState();
            }
        } catch (err) {
            toast('文件解析失败: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

function loadExample() {
    const example = [
        {
            "_comment": "这是示例源，请替换成你自己的源",
            "key": "my_source",
            "name": "我的源名称",
            "api": "https://你的域名.com/api.php/provide/vod",
            "type": 0,
            "searchable": 1,
            "filterable": 1,
            "playerType": 1,
            "group": "stable"
        }
    ];
    dom.importTextarea.value = JSON.stringify(example, null, 2);
    state.editingKey = null;
    renderSourceList();
    dom.importTextarea.focus();
    dom.importTextarea.scrollTop = 0;
    toast('📝 示例格式已填入，替换成你自己的源即可', 'info');
}

// ============================================================
//  自动修正源格式（支持远程导入）
// ============================================================
function normalizeSource(source) {
    if (source && !Array.isArray(source) && source.id && source.baseUrl) {
        return [source];
    }
    
    if (Array.isArray(source)) {
        return source.map(item => {
            const normalized = {
                key: item.key || item.id || '',
                name: item.name || item.title || '',
                api: item.api || item.baseUrl || item.url || '',
                type: item.type !== undefined ? item.type : 0,
                searchable: item.searchable !== undefined ? item.searchable : 1,
                filterable: item.filterable !== undefined ? item.filterable : 1,
                playerType: item.playerType !== undefined ? item.playerType : 1,
                enabled: item.enabled !== undefined ? item.enabled : true,
                disabled: item.disabled !== undefined ? item.disabled : false,
                group: item.group || 'stable',
            };
            
            if (!normalized.key) {
                normalized.key = normalized.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
            }
            
            if (!normalized.api) {
                console.warn('⚠️ 跳过无效源（缺少 api）:', item);
                return null;
            }
            
            return normalized;
        }).filter(item => item !== null);
    }
    
    return [];
}

// ============================================================
//  远程导入源
// ============================================================
async function fetchRemoteSources() {
    const input = document.getElementById('remoteUrlInput');
    const url = input.value.trim();
    
    if (!url) {
        toast('请输入远程源地址', 'error');
        return;
    }
    
    try {
        new URL(url);
    } catch (e) {
        toast('请输入有效的 URL 地址', 'error');
        return;
    }
    
    toast('⏳ 正在获取远程源...', 'info');
    input.disabled = true;
    
    try {
        const response = await fetch('/api/proxy?url=' + encodeURIComponent(url));
        
        if (!response.ok) {
            throw new Error('HTTP ' + response.status + ': ' + response.statusText);
        }
        
        let data;
        try {
            data = await response.json();
        } catch (e) {
            const text = await response.text();
            try {
                data = JSON.parse(text);
            } catch (e2) {
                throw new Error('远程数据不是有效的 JSON 格式');
            }
        }
        
        const normalized = normalizeSource(data);
        
        if (!normalized.length) {
            throw new Error('未找到有效的源数据，请检查格式');
        }
        
        const existing = getStoredSources() || [];
        let addedCount = 0;
        let skippedCount = 0;
        
        normalized.forEach(newItem => {
            const exists = existing.some(ex => ex.key === newItem.key);
            if (!exists) {
                existing.push(newItem);
                addedCount++;
            } else {
                skippedCount++;
            }
        });
        
        setStoredSources(existing);
        state.sources = existing;
        
        renderSourceList();
        populateSelect();
        input.value = '';
        
        toast(`✅ 远程导入成功：新增 ${addedCount} 个，跳过 ${skippedCount} 个重复源，共 ${existing.length} 个`, 'success');
        
        if (existing.length && !dom.sourceSelect.value) {
            const first = existing.find(s => s.group === 'stable') || existing[0];
            if (first) {
                dom.sourceSelect.value = first.key;
                loadBrowse(first);
            }
        }
        
    } catch (error) {
        console.error('远程导入失败:', error);
        toast('❌ 远程导入失败: ' + error.message, 'error');
    } finally {
        input.disabled = false;
    }
}

// ============================================================
//  一键检查失效源（显示进度）
// ============================================================
async function checkAllSources() {
    const sources = state.sources || [];
    if (!sources.length) {
        toast('没有源需要检查', 'info');
        return;
    }

    const checkBtn = document.getElementById('checkBtn');
    const total = sources.length;
    let checked = 0;
    const results = { valid: [], invalid: [] };

    if (checkBtn) {
        checkBtn.textContent = '⏳ 检测中 0/' + total;
        checkBtn.disabled = true;
    }

    toast('🔍 开始检查 ' + total + ' 个源...', 'info');

    function checkSource(source) {
        return new Promise((resolve) => {
            const proxyUrl = '/api/proxy?url=' + encodeURIComponent(source.api);
            fetch(proxyUrl, { signal: AbortSignal.timeout(5000) })
                .then(r => {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.text();
                })
                .then(text => {
                    const isJSON = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
                    const hasList = text.includes('"list"');
                    const hasClass = text.includes('"class"');
                    const hasCode = text.includes('"code"');
                    const hasVodId = text.includes('"vod_id"');
                    const valid = isJSON && (hasList || hasClass || hasCode || hasVodId);
                    resolve({ valid, source });
                })
                .catch(() => {
                    resolve({ valid: false, source });
                });
        });
    }

    const batchSize = 5;
    for (let i = 0; i < total; i += batchSize) {
        const batch = sources.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(s => checkSource(s)));
        batchResults.forEach(result => {
            checked++;
            if (result.valid) {
                results.valid.push(result.source);
            } else {
                results.invalid.push(result.source);
            }
            if (checkBtn) {
                checkBtn.textContent = '⏳ 检测中 ' + checked + '/' + total;
            }
        });
        if (i + batchSize < total) {
            await new Promise(r => setTimeout(r, 150));
        }
    }

    if (checkBtn) {
        checkBtn.textContent = '🔍 检测源';
        checkBtn.disabled = false;
    }

    const invalidCount = results.invalid.length;

    if (invalidCount === 0) {
        toast('🎉 全部 ' + total + ' 个源均有效！', 'success');
        renderSourceList();
        return;
    }

    const newSources = sources.map(s => {
        const found = results.invalid.find(inv => inv.key === s.key);
        if (found) {
            return { ...s, disabled: true };
        }
        return { ...s, disabled: false };
    });

    setStoredSources(newSources);
    state.sources = newSources;
    renderSourceList();
    populateSelect();
    toast('⚠️ 发现 ' + invalidCount + ' 个失效源，已标记', 'warning');
}

// ============================================================
//  TOAST & STATUS
// ============================================================
function toast(msg, type = 'info') {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(30px)';
        el.style.transition = '0.25s ease';
        setTimeout(() => el.remove(), 280);
    }, 2600);
}

function setStatus(msg, loading = false) {
    dom.status.innerHTML = loading ? '<span class="spinner"></span> ' + msg : msg;
}

function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
}

// 图片加载后淡入（避免闪烁）
function attachFadeIn(container) {
    if (!container) return;
    container.querySelectorAll('.poster-wrap img').forEach(img => {
        if (img.complete) {
            img.classList.add('loaded');
        } else {
            img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
        }
    });
}

// ============================================================
//  API
// ============================================================
async function fetchProxy(url, timeout = FETCH_TIMEOUT, asText = false) {
    const urlKey = url.split('?')[0];
    if (state.currentController && state.currentController._urlKey === urlKey) {
        state.currentController.abort();
        state.currentController = null;
    }
    
    const controller = new AbortController();
    controller._urlKey = urlKey;
    state.currentController = controller;
    
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        // 相对路径（同源 API 如 /api/demo）直接请求，不走代理
        const requestUrl = url.startsWith('/') ? url : PROXY(url);
        const resp = await fetch(requestUrl, { signal: controller.signal });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.msg || 'HTTP ' + resp.status);
        }
        return asText ? await resp.text() : await resp.json();
    } catch (e) {
        if (e.name === 'AbortError') {
            return null;
        }
        throw e;
    } finally {
        clearTimeout(timer);
        if (state.currentController === controller) {
            state.currentController = null;
        }
    }
}

// ============================================================
//  ENABLE/DISABLE CONTROLS
// ============================================================
function setControlsEnabled(enabled) {
    dom.searchInput.disabled = !enabled;
    dom.searchBtn.disabled = !enabled;
    if (!enabled) {
        dom.searchInput.placeholder = '请先导入源';
    } else {
        dom.searchInput.placeholder = '搜索片名…';
    }
}

// ============================================================
//  RENDER EMPTY STATE
// ============================================================
function renderEmptyState() {
    const grid = dom.browseGrid;
    grid.innerHTML = `
                <div class="empty-grid" style="grid-column:1/-1;padding:80px 20px;text-align:center;">
                    <div style="font-size:56px;margin-bottom:16px;">📜</div>
                    <div style="font-size:20px;font-weight:700;margin-bottom:8px;color:var(--text);">藏源阁尚空</div>
                    <div style="color:var(--text2);margin-bottom:16px;font-size:15px;">点击右上角「📜」按钮，录入你的源列表</div>
                    <button class="btn-primary" onclick="showImportModal()" style="font-size:15px;padding:8px 24px;">📜 录入源</button>
                    <div style="margin-top:12px;font-size:13px;color:var(--text3);">
                        或 <a onclick="loadExample()" style="color:var(--primary);cursor:pointer;">批阅示例</a> 快速体验
                    </div>
                </div>
            `;
    dom.categoryNav.innerHTML = '';
    dom.browseTitle.textContent = '📥 请导入源';
    dom.browseBadge.textContent = '';
    dom.browseInfo.textContent = '';
    dom.pageInfo.textContent = '-';
    dom.pageInfo2.textContent = '-';
    dom.sourceSelect.innerHTML = '<option value="">请导入源</option>';
    dom.sourceSelect.disabled = true;
    setStatus('请导入源');
    setControlsEnabled(false);
}

// ============================================================
//  PLAYER LOADING 控制
// ============================================================
function showPlayerLoading() {
    dom.playerLoading.classList.remove('hidden');
    dom.playerLoading.classList.add('show');
}

function hidePlayerLoading() {
    dom.playerLoading.classList.add('hidden');
    setTimeout(() => {
        dom.playerLoading.classList.remove('show');
    }, 400);
}

// ============================================================
//  切换到浏览模式（点击 Logo 触发）
// ============================================================
function switchToBrowse() {
    if (state.isPlaying) closePlayer();
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    dom.pageBrowse.classList.add('active');
    if (state.source) loadBrowse(state.source);
}

// ============================================================
//  线路切换
// ============================================================
function switchPlayerLine(index) {
    index = parseInt(index);
    state.currentLineIndex = index;
    const lines = state.currentLines;
    if (!lines || !lines[index]) return;
    const episodes = parseEpisodes(lines[index].url);
    state.currentEpisodes = episodes;
    renderEpisodesPanel(episodes);
    
    const currentUrl = lines[index].url;
    
    if (state.currentSource?.key === 'dbm3u8' || state.currentSource?.name.includes('百度') || state.currentSource?.name.includes('iqiyizyjx')) {
        const firstEp = episodes[0];
        const m3u8Url = normalizeUrl(firstEp.url);
        const baiduPlayerUrl = 'https://jx.jxbdzyw.com/m3u8/?url=' + encodeURIComponent(m3u8Url);
        dom.playerIframe.style.display = 'block';
        dom.playerIframe.src = baiduPlayerUrl;
        dom.player.style.display = 'none';
        dom.playerLoading.classList.add('hidden');
        setTimeout(() => {
            dom.playerLoading.classList.remove('show');
        }, 400);
        toast('已切换: ' + lines[index].name, 'info');
        return;
    }

    if (state.currentSource?.name.includes('爱奇艺') || state.currentSource?.key.includes('iqiyi') || currentUrl.includes('ly166.com') || currentUrl.includes('iqiyizyjx.com')) {
        const firstEp = episodes[0];
        const m3u8Url = normalizeUrl(firstEp.url);
        const playerUrl = 'https://www.iqiyizyjx.com/?url=' + encodeURIComponent(m3u8Url);
        dom.playerIframe.style.display = 'block';
        dom.playerIframe.src = playerUrl;
        dom.player.style.display = 'none';
        dom.playerLoading.classList.add('hidden');
        setTimeout(() => {
            dom.playerLoading.classList.remove('show');
        }, 400);
        toast('已切换: ' + lines[index].name, 'info');
        return;
    }
    
    if (episodes.length) {
        const first = episodes[0];
        state.currentEpisodeName = first.name;
        startPlayer(first.url, (state.currentVod?.vod_name || '') + ' ' + first.name);
    }
    toast('已切换: ' + lines[index].name, 'info');
}

// ============================================================
//  INIT
// ============================================================
// 事件绑定（与是否有源无关，必须始终执行，否则导入源后无法操作）
function bindEvents() {
    dom.sourceSelect.addEventListener('change', function() {
        const key = this.value;
        if (!key) return;
        const s = state.sources.find(src => src.key === key);
        if (!s) {
            toast('未找到该源', 'error');
            return;
        }
        if (state.isPlaying) closePlayer();
        state.isLoading = false;
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        dom.pageBrowse.classList.add('active');
        loadBrowse(s);
    });

    dom.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });
    dom.searchBtn.addEventListener('click', doSearch);

    dom.importModal.addEventListener('click', (e) => {
        if (e.target === dom.importModal) closeImportModal();
    });

    document.addEventListener('keydown', handleKeydown);

    document.addEventListener('click', (e) => {
        const panel = dom.episodesPanel;
        if (panel.classList.contains('open')) {
            if (!panel.contains(e.target) && !e.target.closest('.ctrl-btn') && !e.target.closest('.close-btn')) {
                panel.classList.remove('open');
            }
        }
    });

    dom.player.addEventListener('loadedmetadata', () => {
        hidePlayerLoading();
        restorePlaybackSpeed();
    });
    dom.player.addEventListener('canplay', () => {
        hidePlayerLoading();
    });
    dom.player.addEventListener('error', () => {
        hidePlayerLoading();
    });

    // 音量记忆：播放中保存音量
    dom.player.addEventListener('volumechange', () => {
        try {
            localStorage.setItem(STORAGE_VOLUME_KEY, String(dom.player.volume));
        } catch (e) {}
    });

    // 断点续播：节流保存播放进度（每 10 秒）
    let lastProgressSave = 0;
    dom.player.addEventListener('timeupdate', () => {
        const now = Date.now();
        if (now - lastProgressSave < 10000) return;
        if (!state.currentVod || !state.currentSource) return;
        if (!(dom.player.duration > 0) || dom.player.paused) return;
        lastProgressSave = now;
        savePlayProgress(
            state.currentVod.vod_id,
            state.currentSource.key,
            state.currentEpisodeName || '',
            dom.player.currentTime,
            dom.player.duration
        );
    });

    // ===== 连续点击状态栏 8 次切换隐藏源显示 =====
    let statusClickCount = 0;
    let statusClickTimer = null;

    dom.status.addEventListener('click', () => {
        statusClickCount++;
        clearTimeout(statusClickTimer);
        statusClickTimer = setTimeout(() => {
            if (statusClickCount >= 8) {
                toggleShowHiddenSources();
                dom.status.style.color = showHiddenSources ? '#e74c3c' : '#2e7d32';
                dom.status.style.fontWeight = showHiddenSources ? '700' : '500';
                console.log(showHiddenSources ? '🔓 特殊源已显示' : '🔒 特殊源已隐藏');
            }
            statusClickCount = 0;
        }, 500);
    });

    if (showHiddenSources) {
        dom.status.style.color = '#e74c3c';
        dom.status.style.fontWeight = '700';
    } else {
        dom.status.style.color = '#2e7d32';
        dom.status.style.fontWeight = '500';
    }

    // ===== 远程导入输入框回车触发 =====
    const remoteInput = document.getElementById('remoteUrlInput');
    if (remoteInput) {
        remoteInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                fetchRemoteSources();
            }
        });
    }

    // ===== 搜索输入防抖（停止输入 500ms 后自动搜索） =====
    let searchTimer = null;
    dom.searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            if (dom.searchInput.value.trim()) doSearch();
        }, 500);
    });
}

async function init() {
    loadStorage();

    // 事件绑定必须在任何分支之前执行（修复：无源导入后事件未绑定的问题）
    bindEvents();

    try {
        state.sources = await loadSources();
    } catch (e) {
        state.sources = [];
    }

    if (!hasSources()) {
        renderEmptyState();
        setTimeout(showDisclaimer, 500);
        return;
    }

    populateSelect();
    setControlsEnabled(true);
    setStatus('就绪');

    const first = state.sources.find(s => s.group === 'stable') || state.sources[0];
    if (first) {
        dom.sourceSelect.value = first.key;
        dom.sourceSelect.disabled = false;
        await loadBrowse(first);
    }

    dom.pageBrowse.classList.add('active');

    setTimeout(showDisclaimer, 500);
}

function getSelectedSource() {
    const key = dom.sourceSelect.value;
    return state.sources.find(s => s.key === key) || null;
}

// ============================================================
//  populateSelect - 首页下拉框
// ============================================================
function populateSelect() {
    const sel = dom.sourceSelect;
    sel.innerHTML = '';
    sel.disabled = false;

    if (!state.sources || !state.sources.length) {
        sel.innerHTML = '<option value="">请导入源</option>';
        sel.disabled = true;
        return;
    }

    let sources = state.sources;
    if (!showHiddenSources) {
        sources = sources.filter(s => s.enabled !== false);
    }

    if (!sources || !sources.length) {
        sel.innerHTML = '<option value="">请导入源</option>';
        sel.disabled = true;
        return;
    }

    const validSources = sources.filter(s => s.disabled !== true);
    const invalidSources = sources.filter(s => s.disabled === true);

    let hasOptions = false;

    if (validSources.length) {
        const og = document.createElement('optgroup');
        og.label = '🟢 有效';
        validSources.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.key;
            opt.textContent = s.name;
            og.appendChild(opt);
            hasOptions = true;
        });
        sel.appendChild(og);
    }

    if (invalidSources.length) {
        const og = document.createElement('optgroup');
        og.label = '🔴 失效';
        invalidSources.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.key;
            opt.textContent = s.name + ' (失效)';
            opt.style.color = '#999';
            og.appendChild(opt);
            hasOptions = true;
        });
        sel.appendChild(og);
    }

    if (!hasOptions) {
        sel.innerHTML = '<option value="">请导入源</option>';
        sel.disabled = true;
    }
}

// ============================================================
//  loadCategoriesInBackground - 后台加载分类（带缓存）
// ============================================================
async function loadCategoriesInBackground(source) {
    const cacheKey = source.api;
    
    // 先从缓存读取
    const cached = getClassCache(cacheKey);
    if (cached && cached.length) {
        state.categories = cached;
        renderCategories(cached);
        console.log('📦 分类从缓存加载:', source.name, cached.length);
        return;
    }

    try {
        let classData = await fetchProxy(source.api + '?ac=list');
        let classes = classData?.class || [];
        
        if (!classes.length) {
            const data = await fetchProxy(source.api + '?ac=videolist&pg=1');
            classes = data?.class || [];
        }
        
        if (classes && classes.length) {
            setClassCache(cacheKey, classes);
            state.categories = classes;
            renderCategories(classes);
            console.log('✅ 分类加载并缓存:', source.name, classes.length);
        } else {
            console.log('⚠️ 没有分类数据:', source.name);
            dom.categoryNav.innerHTML = '<span class="cat active">全部</span>';
        }
    } catch (e) {
        console.warn('分类加载失败:', source.name);
        dom.categoryNav.innerHTML = '<span style="color:var(--text3);padding:4px 0;">分类加载失败</span>';
    }
}

// ============================================================
//  BROWSE - 使用适配器，分类和列表一起获取
// ============================================================
async function loadBrowse(source) {
    if (!source || state.isLoading) return;
    state.isLoading = true;
    state.source = source;
    state.category = null;
    state.page = 1;
    setStatus('加载中…', true);
    
    // 先显示"加载分类…"
    dom.categoryNav.innerHTML = '<span style="color:var(--text3);padding:4px 0;">⏳ 加载分类…</span>';

    // 先加载卡片（优先）
    await loadMovies();

    // 分类后台加载（不阻塞）
    loadCategoriesInBackground(source);

    setStatus('就绪');
    state.isLoading = false;
}

// ============================================================
//  loadMovies - 使用 smartApiRequest 自动适配
// ============================================================
async function loadMovies() {
    const s = state.source;
    if (!s) return;

    dom.browseGrid.innerHTML = '<div class="empty-grid"><span class="spinner"></span> 加载中…</div>';

    try {
        const url = state.category ?
            `${s.api}?ac=videolist&t=${state.category}&pg=${state.page}&limit=24` :
            `${s.api}?ac=videolist&pg=${state.page}&limit=24`;
        
        const data = await fetchProxy(url);
        if (!data) return;
        
        const list = data.list || [];
        state.totalPages = Math.max(1, parseInt(data.pagecount) || 1);
        state.movies = list;
        renderMovies(list);
        updatePager();
        dom.browseInfo.textContent = `${list.length} 部`;
        dom.browseBadge.textContent = `共 ${state.totalPages} 页`;
    } catch (e) {
        dom.browseGrid.innerHTML = `<div class="empty-grid">❌ ${esc(e.message)}</div>`;
        toast('加载失败: ' + e.message, 'error');
    }
}

function renderMovies(list) {
    const grid = dom.browseGrid;
    if (!list.length) {
        grid.innerHTML = '<div class="empty-grid">📭 暂无内容</div>';
        return;
    }
    const frag = document.createDocumentFragment();
    list.forEach(v => {
        const el = document.createElement('div');
        el.className = 'card';
        const poster = v.vod_pic || '';
        const score = v.vod_score || '';
        const remark = v.vod_remarks || '';
        const fav = state.source ? isFav(v.vod_id, state.source.key) : false;
        el.innerHTML = `
                    <div class="poster-wrap">
                        <img loading="lazy" src="${esc(poster)}" 
                             onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22260%22 height=%22390%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23181e2a%22/%3E%3C/svg%3E'" />
                        <div class="play-icon">▶</div>
                        ${score ? `<div class="badge-top score">${esc(score)}</div>` : ''}
                        ${remark && !score ? `<div class="badge-top">${esc(remark)}</div>` : ''}
                        ${fav ? `<div class="badge-top star-badge">⭐</div>` : ''}
                    </div>
                    <div class="info">
                        <div class="name">${esc(v.vod_name)}${fav ? ' <span class="star">⭐</span>' : ''}</div>
                        <div class="meta">
                            <span class="tag">${esc(v.type_name || '影视')}</span>
                            ${score ? `<span class="score">${esc(score)}</span>` : ''}
                        </div>
                    </div>
                `;
        el.onclick = () => playMovie(v, state.source);
        frag.appendChild(el);
    });
    grid.innerHTML = '';
    grid.appendChild(frag);
    attachFadeIn(grid);
}

function renderCategories(classes) {
    const nav = dom.categoryNav;
    nav.innerHTML = '';

    const all = document.createElement('span');
    all.className = 'cat active';
    all.textContent = '全部';
    all.onclick = () => {
        document.querySelectorAll('.category-nav .cat').forEach(c => c.classList.remove('active'));
        all.classList.add('active');
        state.category = null;
        state.page = 1;
        loadMovies();
    };
    nav.appendChild(all);

    if (!classes || !classes.length) return;

    // 自动检测是否有 type_pid 字段
    const hasPid = classes.some(c => c.type_pid !== undefined);
    
    if (!hasPid) {
        // 红牛风格：扁平结构
        classes.forEach(c => {
            const btn = document.createElement('span');
            btn.className = 'cat';
            btn.textContent = c.type_name;
            btn.onclick = () => {
                document.querySelectorAll('.category-nav .cat').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                state.category = c.type_id;
                state.page = 1;
                loadMovies();
            };
            nav.appendChild(btn);
        });
    } else {
        // 树形结构：有 type_pid
        const top = classes.filter(c => String(c.type_pid) === '0');
        const kids = classes.filter(c => String(c.type_pid) !== '0');
        
        top.forEach(c => {
            const btn = document.createElement('span');
            btn.className = 'cat';
            btn.textContent = c.type_name;
            btn.onclick = () => {
                document.querySelectorAll('.category-nav .cat').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                state.category = c.type_id;
                state.page = 1;
                loadMovies();
            };
            nav.appendChild(btn);
            kids.filter(k => String(k.type_pid) === String(c.type_id)).forEach(k => {
                const kb = document.createElement('span');
                kb.className = 'cat kid';
                kb.textContent = '└ ' + k.type_name;
                kb.onclick = () => {
                    document.querySelectorAll('.category-nav .cat').forEach(c => c.classList.remove('active'));
                    kb.classList.add('active');
                    state.category = k.type_id;
                    state.page = 1;
                    loadMovies();
                };
                nav.appendChild(kb);
            });
        });
    }
    
    dom.browseTitle.textContent = state.source ? state.source.name : '热门推荐';
}

function updatePager() {
    const txt = `${state.page}/${state.totalPages}`;
    dom.pageInfo.textContent = txt;
    dom.pageInfo2.textContent = txt;
}

function pagePrev() { if (state.page > 1) { state.page--;
        loadMovies(); } }

function pageNext() { if (state.page < state.totalPages) { state.page++;
        loadMovies(); } }

// ============================================================
//  SEARCH - 使用 ac=list&wd=
// ============================================================
doSearch = async function() {
    if (!hasSources()) {
        toast('请先导入源', 'error');
        return;
    }

    const q = dom.searchInput.value.trim();
    if (!q) { toast('请输入片名', 'error'); return; }

    // 根据模式决定搜索范围
    let targets = state.sources;
    if (!showHiddenSources) {
        targets = targets.filter(s => s.enabled !== false);
    }
    targets = targets.filter(s => s.disabled !== true);

    if (!targets.length) {
        toast(showHiddenSources ? '没有可用源（含隐藏）' : '没有可用源', 'error');
        return;
    }

    // 切换到搜索页
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    dom.pageSearch.classList.add('active');

    dom.emptyState.style.display = 'none';
    dom.resultStats.style.display = 'block';
    dom.searchGrid.innerHTML = '';
    dom.resultStats.textContent = '搜索中…';

    const mySeq = ++state.searchSeq;
    const results = [];
    const pool = targets.slice();
    let done = 0;

    const render = () => {
        const frag = document.createDocumentFragment();
        results.forEach(({ v, s }) => {
            const el = document.createElement('div');
            el.className = 'card';
            const fav = isFav(v.vod_id, s.key);
            const poster = v.vod_pic || '';
            const score = v.vod_score || '';
            el.innerHTML = `
                        <div class="poster-wrap">
                            <img loading="lazy" src="${esc(poster)}" 
                                 onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22260%22 height=%22390%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23181e2a%22/%3E%3C/svg%3E'" />
                            <div class="play-icon">▶</div>
                            ${score ? `<div class="badge-top score">${esc(score)}</div>` : ''}
                        </div>
                        <div class="info">
                            <div class="name">${esc(v.vod_name)}${fav ? ' <span class="star">⭐</span>' : ''}</div>
                            <div class="meta">
                                <span class="tag">${esc(v.type_name || '影视')}</span>
                                <span class="tag source">${esc(s.name)}</span>
                                ${v.vod_remarks ? `<span>${esc(v.vod_remarks)}</span>` : ''}
                                ${score ? `<span class="score">${esc(score)}</span>` : ''}
                            </div>
                        </div>
                    `;
            el.onclick = () => playMovie(v, s);
            frag.appendChild(el);
        });
        dom.searchGrid.innerHTML = '';
        dom.searchGrid.appendChild(frag);
        attachFadeIn(dom.searchGrid);
        dom.resultStats.textContent =
            `找到 ${results.length} 个结果 · 完成 ${done}/${targets.length} 个源`;
    };

    async function worker() {
        while (pool.length && mySeq === state.searchSeq) {
            const s = pool.shift();
            try {
                // 标准苹果CMS搜索：列表接口带 wd 参数（ac=videolist 或 ac=list 均兼容）
                // 部分站点也支持 ac=detail&wd=，先试标准接口，失败再回退
                let data = await fetchProxy(`${s.api}?ac=videolist&wd=${encodeURIComponent(q)}`);
                if (!data || !(data.list || []).length) {
                    data = await fetchProxy(`${s.api}?ac=list&wd=${encodeURIComponent(q)}`);
                }
                if (!data || data === null) continue;
                const rawList = data.list || [];
                const keyword = q.toLowerCase();
                rawList.forEach(v => {
                    if (v && v.vod_id && v.vod_name) {
                        const name = (v.vod_name || '').toLowerCase();
                        // 包含匹配
                        if (name.includes(keyword) && !results.some(r => r.v.vod_id === v.vod_id && r.s.key === s.key)) {
                            results.push({ v, s });
                        }
                    }
                });
            } catch (e) { /* skip */ }
            done++;
            render();
        }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker);
    await Promise.all(workers);
    if (mySeq !== state.searchSeq) return;
    render();
    if (!results.length) {
        dom.resultStats.textContent = '未找到结果，试试其他关键词';
        toast('未找到结果', 'error');
    }
};

// ============================================================
//  核心播放逻辑
// ============================================================
function hideAllContent() {
    dom.browseGrid.style.display = 'none';
    dom.categoryNav.style.display = 'none';
    dom.browseHeader.style.display = 'none';
    dom.browsePager.style.display = 'none';
    dom.searchGrid.style.display = 'none';
    dom.resultStats.style.display = 'none';
    if (dom.emptyState) dom.emptyState.style.display = 'none';
}

function restoreAllContent() {
    dom.browseGrid.style.display = '';
    dom.categoryNav.style.display = '';
    dom.browseHeader.style.display = '';
    dom.browsePager.style.display = '';
    dom.searchGrid.style.display = '';
    dom.resultStats.style.display = '';
    if (dom.emptyState) dom.emptyState.style.display = '';
}

// ============================================================
//  playMovie - 使用 smartApiRequest 获取详情
// ============================================================
async function playMovie(vod, source) {
    state.currentVod = vod;
    state.currentSource = source;
    state.currentEpisodeName = '';

    // 断点续播提示
    try {
        const progress = getPlayProgress(vod.vod_id, source.key);
        if (progress && progress.currentTime > 60 && progress.episode &&
            (Date.now() - progress.updatedAt) < 7 * 24 * 3600 * 1000) {
            const mm = Math.floor(progress.currentTime / 60);
            const ss = Math.floor(progress.currentTime % 60);
            const pct = Math.min(100, Math.round(progress.currentTime / (progress.duration || 1) * 100));
            toast(`⏯ 上次看到「${progress.episode}」 ${mm}:${ss}（${pct}%），可在选集里继续`, 'info');
        }
    } catch (e) {}

    setStatus('加载播放地址…', true);

    hideAllContent();
    showPlayerLoading();

    try {
        const result = await smartApiRequest(source, 'detail', { id: vod.vod_id });
        if (!result) return;
        const detail = result.list?.[0] || vod;

        let froms = [],
            urls = [];
        const playFrom = detail.vod_play_from || '';
        const playUrl = detail.vod_play_url || '';

        if (playFrom && playUrl) {
            froms = playFrom.split('$$$').filter(Boolean);
            urls = playUrl.split('$$$').filter(Boolean);
        }

        if (!froms.length) {
            const keys = Object.keys(detail).filter(k => k.startsWith('vod_play_from'));
            for (const k of keys) {
                const idx = k.replace('vod_play_from', '');
                const f = detail[k] || '';
                const u = detail['vod_play_url' + idx] || '';
                if (f && u) {
                    froms.push(f);
                    urls.push(u);
                }
            }
        }

        const lines = froms.map((f, i) => ({ name: f, url: urls[i] || '' }))
            .filter(l => l.url.trim());

        lines.sort((a, b) => (a.url.includes('.m3u8') ? 0 : 1) - (b.url.includes('.m3u8') ? 0 : 1));

        if (!lines.length) {
            toast('该源无可用播放地址', 'error');
            setStatus('无播放地址');
            hidePlayerLoading();
            restoreAllContent();
            return;
        }

        state.currentLines = lines;
        state.currentLineIndex = 0;

        showPlayer();

        const firstUrl = lines[0].url;

        if (source.key === 'dbm3u8' || source.name.includes('百度') || firstUrl.includes('b3.bdzybf22.com')) {
            console.log('🔵 检测到百度源，使用 iframe 播放');
            
            const episodes = parseEpisodes(firstUrl);
            const firstEp = episodes[0];
            const m3u8Url = normalizeUrl(firstEp.url);
            
            const baiduPlayerUrl = 'https://jx.jxbdzyw.com/m3u8/?url=' + encodeURIComponent(m3u8Url);
            
            showPlayer();
            dom.playerLoading.classList.remove('hidden');
            dom.playerLoading.classList.add('show');
            
            dom.playerIframe.style.display = 'block';
            dom.playerIframe.src = baiduPlayerUrl;
            dom.player.style.display = 'none';
            
            dom.playerLoading.classList.add('hidden');
            setTimeout(function() {
                dom.playerLoading.classList.remove('show');
            }, 400);
            
            renderEpisodesPanel(episodes);
            setStatus('播放中');
            return;
        }

        if (source.name.includes('爱奇艺') || source.key.includes('iqiyi') || firstUrl.includes('ly166.com') || firstUrl.includes('iqiyizyjx.com')) {
            console.log('🔵 检测到 ly166/爱奇艺源');
            
            const episodes = parseEpisodes(firstUrl);
            const firstEp = episodes[0];
            const m3u8Url = normalizeUrl(firstEp.url);
            
            if (isMobile) {
                console.log('📱 移动端检测，使用 HLS.js 播放');
                
                showPlayer();
                dom.playerLoading.classList.remove('hidden');
                dom.playerLoading.classList.add('show');
                
                dom.playerIframe.style.display = 'none';
                dom.playerIframe.src = '';
                dom.player.style.display = 'block';
                
                if (window.Hls && Hls.isSupported()) {
                    if (window._iqiyiHls) {
                        window._iqiyiHls.destroy();
                        window._iqiyiHls = null;
                    }
                    canPlayDirect(m3u8Url).then(function (useDirect) {
                        attachHls(m3u8Url, '', dom.player, useDirect, true);
                    });
                } else {
                    dom.player.src = m3u8Url;
                    dom.player.play().catch(function() {});
                }
                
                renderEpisodesPanel(episodes);
                setStatus('播放中');
                return;
                
            } else {
                console.log('💻 PC 端，使用 iframe 播放');
                
                const playerUrl = 'https://www.iqiyizyjx.com/?url=' + encodeURIComponent(m3u8Url);
                
                showPlayer();
                dom.playerLoading.classList.remove('hidden');
                dom.playerLoading.classList.add('show');
                
                dom.playerIframe.style.display = 'block';
                dom.playerIframe.src = playerUrl;
                dom.player.style.display = 'none';
                
                dom.playerLoading.classList.add('hidden');
                setTimeout(function() {
                    dom.playerLoading.classList.remove('show');
                }, 400);
                
                renderEpisodesPanel(episodes);
                setStatus('播放中');
                return;
            }
        }

        const episodes = parseEpisodes(firstUrl);

        if (firstUrl.includes('huyall.com') || firstUrl.includes('baisiweiting.com')) {
            console.log('🔵 检测到虎牙资源，使用专用播放逻辑');
            const episodes = parseEpisodes(firstUrl);
            const firstEp = episodes[0];
            const fullUrl = normalizeUrl(firstEp.url);
            showPlayer();
            dom.playerLoading.classList.remove('hidden');
            dom.playerLoading.classList.add('show');
            startPlayerWithProxy(fullUrl, vod.vod_name);
            renderEpisodesPanel(episodes);
            setStatus('播放中');
            return;
        }

        if (episodes.length) {
            state.currentEpisodes = episodes;
            const firstEp = episodes[0];
            const fullUrl = normalizeUrl(firstEp.url);
            state.currentEpisodeName = firstEp.name;
            startPlayer(fullUrl, vod.vod_name + ' ' + firstEp.name);
            renderEpisodesPanel(episodes);
        } else {
            const fullUrl = normalizeUrl(firstUrl);
            state.currentEpisodeName = '播放';
            startPlayer(fullUrl, vod.vod_name);
            renderEpisodesPanel([]);
        }

        renderPlayerLines(lines);

        setStatus('播放中');
    } catch (e) {
        toast('获取播放地址失败: ' + e.message, 'error');
        setStatus('加载失败');
        hidePlayerLoading();
        restoreAllContent();
    }
}

function parseEpisodes(url) {
    const parts = url.split('#').filter(p => p.includes('$'));
    if (!parts.length) {
        const fullUrl = normalizeUrl(url);
        return [{ name: '播放', url: fullUrl }];
    }
    return parts.map(p => {
        const i = p.indexOf('$');
        const name = p.slice(0, i).trim() || '播放';
        let addr = p.slice(i + 1);
        return { name, url: normalizeUrl(addr) };
    });
}

function normalizeUrl(url) {
    let result = url.trim();
    if (result.startsWith('/')) {
        const source = state.currentSource;
        if (source) {
            const base = source.api.replace(/\/api\.php.*$/, '');
            result = base + result;
        }
    }
    return result;
}

function showPlayer() {
    state.isPlaying = true;
    dom.playerSection.classList.add('open');
    dom.playerSection.style.display = 'block';
    dom.playerSection.style.minHeight = '300px';
    dom.playerControls.classList.add('open');
    dom.playerControls.style.display = 'flex';
    dom.player.style.display = 'block';
    dom.player.style.opacity = '1';
    dom.player.style.visibility = 'visible';
    dom.playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPlayerLines(lines) {
    const select = dom.lineSelect;
    select.innerHTML = '';
    // 仅一个线路时隐藏换源下拉，多个线路才显示
    select.style.display = lines.length > 1 ? 'block' : 'none';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '📡换源';
    defaultOpt.disabled = true;
    defaultOpt.selected = true;
    select.appendChild(defaultOpt);

    lines.forEach((l, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = l.name;
        select.appendChild(opt);
    });
}

function toggleEpisodesPanel() {
    dom.episodesPanel.classList.toggle('open');
    if (dom.episodesPanel.classList.contains('open')) {
        if (!state.currentEpisodes.length && state.currentLines.length) {
            const url = state.currentLines[state.currentLineIndex]?.url || '';
            const eps = parseEpisodes(url);
            state.currentEpisodes = eps;
            renderEpisodesPanel(eps);
        }
    }
}

function renderEpisodesPanel(episodes) {
    const list = dom.episodesList;
    list.innerHTML = '';
    if (!episodes || !episodes.length) {
        list.innerHTML = '<span class="ep-loading">暂无剧集</span>';
        return;
    }

    if (episodes.length === 1 && episodes[0].name === '播放') {
        const el = document.createElement('span');
        el.className = 'ep';
        el.textContent = '▶ 播放';
        el.onclick = () => {
            document.querySelectorAll('#episodes-list .ep').forEach(e => e.classList.remove('active'));
            el.classList.add('active');
            state.currentEpisodeName = episodes[0].name;
            startPlayer(episodes[0].url, state.currentVod?.vod_name || '播放');
            dom.episodesPanel.classList.remove('open');
            if (state.currentVod && state.currentSource) {
                addHistory(state.currentVod, state.currentSource, '播放');
            }
        };
        list.appendChild(el);
        return;
    }

    episodes.forEach((ep, idx) => {
        const el = document.createElement('span');
        el.className = 'ep';
        el.textContent = ep.name;
        el.onclick = () => {
            document.querySelectorAll('#episodes-list .ep').forEach(e => e.classList.remove('active'));
            el.classList.add('active');
            if (state.currentSource?.key === 'dbm3u8' || state.currentSource?.name.includes('百度')) {
                const m3u8Url = normalizeUrl(ep.url);
                const baiduPlayerUrl = 'https://jx.jxbdzyw.com/m3u8/?url=' + encodeURIComponent(m3u8Url);
                dom.playerIframe.style.display = 'block';
                dom.playerIframe.src = baiduPlayerUrl;
                dom.player.style.display = 'none';
                dom.episodesPanel.classList.remove('open');
                if (state.currentVod && state.currentSource) {
                    addHistory(state.currentVod, state.currentSource, ep.name);
                }
                return;
            }
            if (state.currentSource?.name.includes('爱奇艺') || state.currentSource?.key.includes('iqiyi') || ep.url.includes('ly166.com') || ep.url.includes('iqiyizyjx.com')) {
                const m3u8Url = normalizeUrl(ep.url);
                
                if (isMobile) {
                    console.log('📱 选集移动端，使用 HLS.js 播放');
                    dom.playerIframe.style.display = 'none';
                    dom.playerIframe.src = '';
                    dom.player.style.display = 'block';
                    
                    dom.playerLoading.classList.remove('hidden');
                    dom.playerLoading.classList.add('show');
                    
                    if (window.Hls && Hls.isSupported()) {
                        if (window._iqiyiHls) {
                            window._iqiyiHls.destroy();
                            window._iqiyiHls = null;
                        }
                        canPlayDirect(m3u8Url).then(function (useDirect) {
                            attachHls(m3u8Url, '', dom.player, useDirect, true);
                        });
                    } else {
                        dom.player.src = m3u8Url;
                        dom.player.play().catch(function() {});
                    }
                    
                } else {
                    console.log('💻 选集 PC 端，使用 iframe 播放');
                    const playerUrl = 'https://www.iqiyizyjx.com/?url=' + encodeURIComponent(m3u8Url);
                    dom.playerIframe.style.display = 'block';
                    dom.playerIframe.src = playerUrl;
                    dom.player.style.display = 'none';
                }
                
                dom.episodesPanel.classList.remove('open');
                if (state.currentVod && state.currentSource) {
                    addHistory(state.currentVod, state.currentSource, ep.name);
                }
                return;
            }
            state.currentEpisodeName = ep.name;
            startPlayer(ep.url, (state.currentVod?.vod_name || '') + ' ' + ep.name);
            dom.episodesPanel.classList.remove('open');
            if (state.currentVod && state.currentSource) {
                addHistory(state.currentVod, state.currentSource, ep.name);
            }
        };
        list.appendChild(el);
    });
}

// ============================================================
//  🆕 增强的 startPlayer - 使用代理播放
// ============================================================
function startPlayer(url, title) {
    if (!url || !url.trim()) {
        toast('播放地址为空', 'error');
        return;
    }

    url = url.trim();

    if (url.startsWith('/')) {
        const source = state.currentSource;
        if (source) {
            const base = source.api.replace(/\/api\.php.*$/, '');
            url = base + url;
        }
    }

    state.currentUrl = url;

    dom.nowPlaying.textContent = title || '正在播放';
    dom.m3u8Link.value = url;

    // 恢复音量/播放速度偏好
    applySavedVolume();
    restorePlaybackSpeed();

    // ============================================================
    //  vip.ffzy-plays.com 使用 video 直连
    // ============================================================
    if (url.includes('vip.ffzy-plays.com') || 
        url.includes('vod1.maowushi.com')) {
        console.log('🔄 检测到 vip.ffzy-plays，使用 video 直连');
        
        dom.player.style.display = 'block';
        dom.player.style.width = '100%';
        dom.player.style.height = '100%';
        dom.player.style.minHeight = '300px';
        dom.player.style.position = 'relative';
        dom.player.style.zIndex = '100';
        dom.player.style.opacity = '1';
        dom.player.style.visibility = 'visible';
        dom.playerIframe.style.display = 'none';
        dom.playerIframe.src = '';
        dom.playerLoading.classList.add('hidden');
        setTimeout(() => {
            dom.playerLoading.classList.remove('show');
        }, 400);
        
        if (window._hls) {
            window._hls.destroy();
            window._hls = null;
        }
        if (state.hlsInstance) {
            state.hlsInstance.destroy();
            state.hlsInstance = null;
        }
    
        dom.player.src = url;
        dom.player.play().catch(function() {});
        console.log('✅ vip.ffzy-plays video 直连已启动');
        return;
    }

    // ============================================================
    //  加密源直接走 iframe
    // ============================================================
    if (url.includes('jpxm3u8.com') || url.includes('jpts1.top') || url.includes('jpxm3u8')) {
        console.log('🔐 检测到加密源，直接使用 iframe 播放');
        dom.player.style.display = 'none';
        dom.playerIframe.style.display = 'block';
        dom.playerIframe.src = url;
        dom.playerLoading.classList.add('hidden');
        setTimeout(() => {
            dom.playerLoading.classList.remove('show');
        }, 400);
        dom.playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }

    // ============================================================
    //  xibaom20.com 视频直链
    // ============================================================
    if (url.includes('xibaom20.com')) {
        console.log('🔄 检测到 xibaom20 直链源');
        const proxyUrl = '/api/proxy?url=' + encodeURIComponent(url);
        const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
        
        fetch(proxyUrl)
            .then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(text => {
                let modified = text.replace(
                    /^([^#].*)$/gm,
                    function(line) {
                        if (!line.startsWith('#') && line.trim() && !line.startsWith('http')) {
                            return baseUrl + line.trim();
                        }
                        return line;
                    }
                );
                
                const blob = new Blob([modified], { type: 'application/vnd.apple.mpegurl' });
                const blobUrl = URL.createObjectURL(blob);
                
                dom.playerLoading.classList.add('hidden');
                setTimeout(() => {
                    dom.playerLoading.classList.remove('show');
                }, 400);
                
                dom.player.src = blobUrl;
                dom.player.play().catch(function() {});
                console.log('✅ xibaom20 video 直接播放成功');
            })
            .catch(e => {
                console.error('❌ 获取 m3u8 失败:', e);
                startPlayerInIframe(url, title);
            });
        return;
    }

    dom.playerIframe.style.display = 'none';
    dom.playerIframe.src = '';
    dom.player.style.display = 'block';

    const video = dom.player;
    const currentHeight = video.offsetHeight;
    if (currentHeight > 50) {
        video.style.minHeight = currentHeight + 'px';
    }

    if (state.hlsInstance) {
        state.hlsInstance.destroy();
        state.hlsInstance = null;
    }

    const isMedia = /\.(m3u8|mp4|ts|flv|mkv|mp3|aac|webm|m4s)(\?[^#]*)?(#.*)?$/i.test(url);
    const isHtml = !isMedia && (url.includes('.html') || url.includes('/play/') || url.includes('/vod/') || url.includes('/show/') || url.includes('/detail/'));

    if (isHtml) {
        extractM3u8FromHtml(url, title);
        return;
    }

    // ============================================================
    //  m3u8：先探测能否浏览器直连，能则直连（快），不能才走代理
    // ============================================================
    if (url.includes('.m3u8') || url.includes('.m3u8?')) {
        dom.playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

        if (window.Hls && Hls.isSupported()) {
            canPlayDirect(url).then(function (useDirect) {
                attachHls(url, title, video, useDirect, true);
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            canPlayDirect(url).then(function (useDirect) {
                video.src = useDirect ? url : PLAY_PROXY(url);
                video.onerror = function () {
                    if (!useDirect) {
                        startPlayerInIframe(url, title);
                        return;
                    }
                    video.onerror = null;
                    video.src = PLAY_PROXY(url);
                    video.play().catch(function () {});
                };
                video.play().catch(function () {});
            });
        } else {
            startPlayerInIframe(url, title);
        }
        return;
    }

    // 非 m3u8 视频直链
    video.src = url;
    video.play().catch(function() {
        toast('无法直接播放，尝试嵌入', 'error');
        startPlayerInIframe(url, title);
    });
}

// ============================================================
//  startPlayerWithProxy - 仅用于特殊源（虎牙、wgsl等）
// ============================================================
function startPlayerWithProxy(url, title) {
    state.isPlaying = true;
    dom.playerSection.classList.add('open');
    dom.playerSection.style.display = 'block';
    dom.playerSection.style.minHeight = '300px';
    dom.playerSection.style.position = 'relative';
    dom.playerSection.style.zIndex = '100';
    
    dom.playerControls.classList.add('open');
    dom.playerControls.style.display = 'flex';
    dom.playerControls.style.zIndex = '101';
    
    dom.player.style.display = 'block';
    dom.player.style.opacity = '1';
    dom.player.style.visibility = 'visible';
    dom.player.style.zIndex = '102';
    dom.player.style.position = 'relative';
    dom.player.style.width = '100%';
    dom.player.style.height = '100%';
    dom.player.style.objectFit = 'contain';
    dom.player.style.background = '#000';
    
    dom.playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    const video = dom.player;
    const baseUrl = window.location.origin;

    if (window.Hls && Hls.isSupported()) {
        const proxyUrl = '/api/proxy?url=' + encodeURIComponent(url);
        
        fetch(proxyUrl)
            .then(function(r) {
                if (!r.ok) throw new Error('代理请求失败: ' + r.status);
                return r.text();
            })
            .then(function(mainM3u8) {
                const isWgsl = url.includes('wgslsw.com') || url.includes('wgsl');
                
                if (isWgsl) {
                    console.log('🔍 检测到 wgsl 源，进行分片过滤...');
                    const lines = mainM3u8.split('\n');
                    const filteredLines = [];
                    let filteredCount = 0;
                    
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        
                        if (line.includes('ts1.yhzybf.com')) {
                            if (filteredLines.length > 0 && 
                                filteredLines[filteredLines.length - 1].trim().startsWith('#EXTINF')) {
                                filteredLines.pop();
                            }
                            filteredCount++;
                            continue;
                        }
                        
                        filteredLines.push(line);
                    }
                    
                    if (filteredCount > 0) {
                        mainM3u8 = filteredLines.join('\n');
                        console.log('✅ 过滤了 ' + filteredCount + ' 个失效分片');
                        console.log('📄 剩余分片数:', mainM3u8.match(/\.ts/g)?.length || 0);
                    } else {
                        console.log('✅ 未发现失效分片');
                    }
                }
                
                const targetOrigin = new URL(url).origin;
                const subMatch = mainM3u8.match(/(\/[^\s]+\.m3u8)/);
                
                if (subMatch) {
                    const subUrl = targetOrigin + subMatch[1];
                    console.log('📡 检测到二级 m3u8，请求:', subUrl);
                    return fetch('/api/proxy?url=' + encodeURIComponent(subUrl))
                        .then(function(r) {
                            if (!r.ok) throw new Error('二级 m3u8 请求失败: ' + r.status);
                            return r.text();
                        })
                        .then(function(subM3u8) {
                            let modified = subM3u8;
                            
                            modified = modified.replace(
                                /(URI=")([^"]+)(")/g,
                                function(match, p1, p2, p3) {
                                    if (p2.startsWith('/')) {
                                        return p1 + baseUrl + '/api/proxy?url=' + encodeURIComponent(targetOrigin + p2) + p3;
                                    }
                                    return match;
                                }
                            );
                            
                            modified = modified.replace(
                                /(\/[^\s]+\.ts)/g,
                                function(match) {
                                    return baseUrl + '/api/proxy?url=' + encodeURIComponent(targetOrigin + match);
                                }
                            );
                            
                            console.log('✅ 二级 m3u8 替换完成');
                            return modified;
                        });
                } else {
                    console.log('📡 单层 m3u8，直接处理');
                    let modified = mainM3u8;
                    const keyUrl = url.replace('/index.m3u8', '/enc.key');
                    modified = modified.replace(
                        /URI="enc\.key"/,
                        'URI="' + baseUrl + '/api/proxy?url=' + encodeURIComponent(keyUrl) + '"'
                    );
                    return modified;
                }
            })
            .then(function(modifiedM3u8) {
                const blob = new Blob([modifiedM3u8], { type: 'application/vnd.apple.mpegurl' });
                const blobUrl = URL.createObjectURL(blob);
                
                if (state.hlsInstance) {
                    state.hlsInstance.destroy();
                    state.hlsInstance = null;
                }
                
                const hls = createHls();
                state.hlsInstance = hls;
                hls.loadSource(blobUrl);
                hls.attachMedia(video);
                
                hls.on(Hls.Events.MANIFEST_PARSED, function() {
                    video.style.opacity = '1';
                    video.style.width = '100%';
                    video.style.height = '100%';
                    video.style.minHeight = '';
                    dom.playerLoading.classList.add('hidden');
                    setTimeout(function() {
                        dom.playerLoading.classList.remove('show');
                    }, 400);
                    video.play().catch(function() {});
                    console.log('✅ 代理播放成功');
                });
                
                hls.on(Hls.Events.ERROR, function(e, data) {
                    video.style.opacity = '1';
                    dom.playerLoading.classList.add('hidden');
                    if (data.fatal) {
                        toast('HLS 播放失败，尝试嵌入', 'error');
                        startPlayerInIframe(url, title);
                    }
                });
            })
            .catch(function(e) {
                console.error('代理加载失败:', e);
                video.style.opacity = '1';
                dom.playerLoading.classList.add('hidden');
                toast('播放失败: ' + e.message, 'error');
                startPlayerInIframe(url, title);
            });
            
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.style.opacity = '1';
        video.src = url;
        video.play().catch(function() {});
    } else {
        video.style.opacity = '1';
        startPlayerInIframe(url, title);
    }
}

async function extractM3u8FromHtml(pageUrl, title) {
    setStatus('解析中…', true);

    try {
        if (pageUrl.startsWith('/')) {
            const source = state.currentSource;
            if (source) {
                const base = source.api.replace(/\/api\.php.*$/, '');
                pageUrl = base + pageUrl;
            }
        }

        const resp = await fetchProxy(pageUrl, FETCH_TIMEOUT, true);
        if (resp === null) return;
        const html = typeof resp === 'string' ? resp : JSON.stringify(resp);

        if (String(html).trimStart().startsWith('#EXTM3U')) {
            toast('✅ 识别为 m3u8 直链', 'success');
            setStatus('就绪');
            startPlayer(pageUrl, title || '解析播放');
            return;
        }

        const patterns = [
            /["'](https?:[^"']+\.m3u8[^"']*)["']/,
            /["'](\/[^"']+\.m3u8[^"']*)["']/,
            /var\s+url\s*=\s*["']([^"']+\.m3u8[^"']*)["']/,
            /url\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
            /src\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
            /(https?:[^\s"']+\.m3u8[^\s"']*)/,
            /(\/[^\s"']+\.m3u8[^\s"']*)/,
        ];

        let m3u8Url = null;
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) {
                m3u8Url = match[1];
                break;
            }
        }

        if (m3u8Url) {
            if (m3u8Url.startsWith('/')) {
                const base = new URL(pageUrl).origin;
                m3u8Url = base + m3u8Url;
            }
            if (!m3u8Url.startsWith('http://') && !m3u8Url.startsWith('https://')) {
                const base = pageUrl.replace(/\/[^/]*$/, '/');
                m3u8Url = base + m3u8Url;
            }
            toast('✅ 解析成功', 'success');
            setStatus('就绪');
            startPlayer(m3u8Url, title || '解析播放');
        } else {
            toast('未能提取 m3u8，尝试嵌入页面', 'info');
            startPlayerInIframe(pageUrl, title);
        }
    } catch (e) {
        toast('解析失败: ' + e.message, 'error');
        setStatus('解析失败');
        startPlayerInIframe(pageUrl, title);
    }
}

function startPlayerInIframe(url, title) {
    dom.playerSection.classList.add('open');
    dom.playerControls.classList.add('open');
    dom.nowPlaying.textContent = title || '嵌入播放';
    dom.m3u8Link.value = url;

    hidePlayerLoading();

    // 视频直链塞进 iframe 永远不会出画面（就是无限转圈），只提示换线路
    if (/\.(m3u8|mp4|ts|flv|mkv|webm|m4s)(\?|$)/i.test(url)) {
        dom.player.style.display = 'none';
        dom.playerIframe.style.display = 'none';
        dom.playerIframe.src = '';
        toast('此线路播不出来，请换一条线路', 'error');
        dom.playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }

    dom.player.style.display = 'none';
    dom.playerIframe.style.display = 'block';
    dom.playerIframe.src = url;

    toast('已切换到嵌入式播放', 'info');
    dom.playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closePlayer() {
    state.isPlaying = false;
    dom.playerSection.classList.remove('open');
    dom.playerSection.style.display = 'none';
    dom.playerControls.classList.remove('open');
    dom.playerControls.style.display = 'none';
    dom.episodesPanel.classList.remove('open');

    if (state.hlsInstance) {
        state.hlsInstance.destroy();
        state.hlsInstance = null;
    }
    dom.player.removeAttribute('src');
    dom.player.load();
    dom.player.style.display = 'block';
    dom.playerIframe.style.display = 'none';
    dom.playerIframe.src = '';
    dom.nowPlaying.textContent = '—';
    dom.m3u8Link.value = '';

    state.currentLines = [];
    state.currentEpisodes = [];
    state.currentEpisodeName = '';

    dom.lineSelect.style.display = 'none';

    hidePlayerLoading();
    restoreAllContent();
    setStatus('就绪');
}

function openLink() {
    const url = state.currentUrl || (dom.m3u8Link && dom.m3u8Link.value.trim());
    if (!url) {
        toast('没有可打开的链接', 'error');
        return;
    }
    const win = window.open(url, '_blank', 'noopener');
    if (!win) {
        // 浏览器拦了弹窗：退化成复制，让他能交给外部播放器
        copyLink();
        toast('弹窗被拦截，已改为复制地址', 'info');
    }
}

function copyLink() {
    const input = dom.m3u8Link;
    if (!input || !input.value) {
        toast('没有可复制的链接', 'error');
        return;
    }
    input.select();
    input.setSelectionRange(0, input.value.length);
    try {
        navigator.clipboard.writeText(input.value).then(() => {
            toast('✅ 已复制到剪贴板', 'success');
        }).catch(() => {
            document.execCommand('copy');
            toast('✅ 已复制', 'success');
        });
    } catch (e) {
        toast('请手动复制：' + input.value, 'info');
    }
}

function handleKeydown(e) {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    const video = dom.player;
    if (dom.playerSection.classList.contains('open') && video) {
        switch (e.key) {
            case ' ':
                e.preventDefault();
                video.paused ? video.play() : video.pause();
                break;
            case 'ArrowRight':
                e.preventDefault();
                video.currentTime += 10;
                break;
            case 'ArrowLeft':
                e.preventDefault();
                video.currentTime -= 10;
                break;
            case 'Escape':
                if (document.fullscreenElement) document.exitFullscreen();
                break;
        }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        dom.searchInput.focus();
        dom.searchInput.select();
    }
}

let disclaimerShown = false;

function showDisclaimer() {
    const agreed = localStorage.getItem(STORAGE_DISCLAIMER_KEY);
    if (agreed === 'true') return;

    if (disclaimerShown) return;
    disclaimerShown = true;

    const result = confirm(
        '📺 TVPlayer · 免责声明\n\n' +
        '1. 本工具为纯前端空壳播放器，不包含、不存储任何音视频内容。\n' +
        '2. 所有播放资源均来自第三方公开采集接口，由用户自行配置。\n' +
        '3. 仅供技术学习交流使用，请于 24 小时内删除缓存内容。\n' +
        '4. 尊重版权，支持正版影视平台。\n' +
        '5. 使用本工具产生的一切法律风险由使用者自行承担。\n\n' +
        '点击「确定」表示您同意上述条款。'
    );

    if (result) {
        localStorage.setItem(STORAGE_DISCLAIMER_KEY, 'true');
    }
}

// 检测是否为移动端
const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
                 (window.innerWidth < 768);

document.addEventListener('DOMContentLoaded', init);
