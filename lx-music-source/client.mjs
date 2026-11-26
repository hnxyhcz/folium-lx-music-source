// lx-music-source/client.mjs
// Folium 1.6+ client entry: settings, commands and the source-list panel for the
// LX Music (洛雪音乐) source adapter. Script execution, lx.utils, network and the
// local audio proxy all live in the main entry (index.cjs).
//
// The audio hook is deliberately synchronous: it only rewrites `event.url` to a
// placeholder `http://127.0.0.1:<port>/p/<payload>` and returns. Real resolution
// happens in main when the player fetches the stream, so the host's 1.5 s async
// hook budget no longer applies. The payload carries the built-in URL as a
// fallback, so a free song that plays without the script is never broken.
//
// Folium 2.0+: `settingsSections.register(...).settings`, no `folium.internals`, and
// events/registries from the 2.x contract. Requires Folia 0.8.0 (Folium 2.x).
//
// The JSDoc typedef only feeds the editor; it does nothing at runtime.
/** @typedef {import('../types/folium').FoliumClientApi} Folium */

// 脚本执行、lx.utils、网络与本地代理都在 main 入口（index.cjs）。本文件只负责：
//   - 设置 / 源列表面板 / 命令；
//   - 把播放地址同步改写成占位地址 http://127.0.0.1:<port>/p/<payload>（不 await，避开 1.5s 钩子时限）；
//   - 通过 folium.rpc 与 main 通信。

const PROVIDER_TO_LX_SOURCE = { netease: 'wy', kugou: 'kg', qq: 'tx' };
const LX_QUALITY_OPTIONS = ['128k', '320k', 'flac', 'flac24bit'];
// Scripts are stored as one JSON array in folium.storage (1 MB for the whole data file).
const STORAGE_SCRIPTS = 'scripts';
const STORAGE_BUDGET_BYTES = 900 * 1000;
const DEFAULT_QUALITY = '320k';
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
// 测试解析的示例 ID（晴天）；留空时按当前音源取这里。
const DEFAULT_TEST_SONG_IDS = {
    wy: '186016',
    tx: '0039MnYb0qxYhV',
    kg: 'B3A52A7A958BF0AED0EBFBA2E9A818B7',
    kw: '51685512',
    mg: '600000', // 示例 copyrightId
};

const QUALITY_LABELS = {
    '128k': { 'zh-CN': '标准', en: 'Standard' },
    '320k': { 'zh-CN': '极高', en: 'Very High' },
    flac: { 'zh-CN': '无损 FLAC', en: 'Lossless FLAC' },
    flac24bit: { 'zh-CN': 'Hi-Res 24bit', en: 'Hi-Res 24bit' },
};
const QUALITY_OPTIONS = LX_QUALITY_OPTIONS.map((value) => ({
    value,
    label: QUALITY_LABELS[value] ?? { 'zh-CN': value, en: value },
}));

const SOURCE_OPTIONS = [
    { value: 'wy', label: { 'zh-CN': '网易云 (wy)', en: 'Netease (wy)' } },
    { value: 'tx', label: { 'zh-CN': 'QQ 音乐 (tx)', en: 'QQ Music (tx)' } },
    { value: 'kg', label: { 'zh-CN': '酷狗 (kg)', en: 'Kugou (kg)' } },
    { value: 'kw', label: { 'zh-CN': '酷我 (kw)', en: 'Kuwo (kw)' } },
    { value: 'mg', label: { 'zh-CN': '咪咕 (mg)', en: 'Migu (mg)' } },
];

const stripExtension = (name) => String(name || '').replace(/\.(js|mjs|cjs|txt)$/i, '') || 'script';

const isScriptEntry = (value) => Boolean(value)
    && typeof value === 'object'
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.code === 'string';

const filenameFromUrl = (url) => {
    try {
        const pathname = new URL(url).pathname;
        const last = pathname.split('/').filter(Boolean).pop() || 'script';
        return stripExtension(decodeURIComponent(last));
    } catch {
        return 'script';
    }
};

// 只用于导入时预览名字/版本；真正的执行与完整解析在 main。
// 注意：index.cjs 里有一份等价实现（渲染进程与主进程各自打包），改动时两处保持一致。
const parseScriptMeta = (code, fallback = 'script') => {
    const meta = { name: '', description: '', version: '', author: '', homepage: '' };
    const header = String(code).slice(0, 8192).match(/^\s*\/\*[\s\S]*?\*\//)?.[0] ?? '';
    if (header) {
        for (const line of header.split('\n')) {
            const hit = line.match(/^\s*\*?\s*@(\w+)\s+(.+?)\s*$/);
            if (hit && hit[1] in meta) meta[hit[1]] = hit[2].replace(/\s*\*\/$/, '').trim();
        }
    }
    if (!meta.name) meta.name = fallback || 'script';
    return meta;
};

// user_api.json 里的 gz_ 是 base64(deflate)，渲染进程用 DecompressionStream 解。
// 注意：index.cjs 里有等价的同步实现（用 zlib），改动时两处保持一致。
const decodeLxScript = async (raw) => {
    const text = String(raw ?? '');
    if (!text.startsWith('gz_')) return text;
    const payload = text.slice(3).replace(/\s+/g, '');
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    for (const format of ['deflate', 'deflate-raw']) {
        try {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
            const buffer = await new Response(stream).arrayBuffer();
            return new TextDecoder().decode(buffer);
        } catch { /* try next */ }
    }
    throw new Error('cannot decode gz_ script payload');
};


/**
 * 从宿主给自定义面板的主题里算出常用颜色/底色（两个设置面板共用，避免重复计算）。
 * accent 取 accentColor；onAccent 是按亮度算出的、压在主色上的文字色。
 */
function resolvePanelColors(panelCtx) {
    const theme = (panelCtx.getTheme && panelCtx.getTheme()) || {};
    const day = Boolean(theme.isDaylight);
    const accent = theme.accentColor || theme.primaryColor || (day ? '#ea580c' : '#f4f4f5');
    const hex = /^#([0-9a-f]{6})$/i.exec(String(accent).trim());
    let lum = 0;
    if (hex) {
        const n = parseInt(hex[1], 16);
        lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    }
    return {
        day,
        accent,
        onAccent: lum > 170 ? '#1c1917' : '#ffffff',
        text: `var(--text-primary, ${theme.primaryColor || (day ? '#1c1917' : '#f4f4f5')})`,
        muted: `var(--text-secondary, ${theme.secondaryColor || (day ? '#64748b' : '#a1a1aa')})`,
        fieldBg: day ? 'rgba(23,43,77,.04)' : 'rgba(0,0,0,.22)',
        fieldBorder: day ? 'rgba(23,43,77,.16)' : 'rgba(255,255,255,.18)',
        hoverFill: day ? 'rgba(23,43,77,.05)' : 'rgba(255,255,255,.08)',
        borderStrong: day ? 'rgba(23,43,77,.20)' : 'rgba(255,255,255,.28)',
        trackColor: day ? 'rgba(23,43,77,.20)' : 'rgba(255,255,255,.24)',
    };
}

/**
 * 中英文快捷翻译：中文语言环境（zh*）取中文，其余取英文。
 */
function makeTr(locale) {
    const zh = String(locale || 'zh-CN').toLowerCase().startsWith('zh');
    return (cn, en) => (zh ? cn : en);
}

/**
 * 取 FoliumLabel 在当前语言下的文本：字符串原样，对象按 locale / zh-CN / en / 任一值回退。
 */
function pickFoliumLabel(label, locale) {
    if (typeof label === 'string') return label;
    if (label && typeof label === 'object') return label[locale] || label['zh-CN'] || label.en || Object.values(label)[0] || '';
    return '';
}

/** @param {Folium} folium */
export default async function activate(folium) {
    // Mods also activate in the export window; only the main window owns Omni.
    if (folium.env.context !== 'main') return undefined;

    const version = folium.host?.folium ?? { major: 0, minor: 0 };
    if (version.major < 2) {
        folium.log.error(
            `LX Music source adapter needs Folium 2.0 or newer; this host is ${version.major}.${version.minor}`,
        );
        return undefined;
    }

    const section = folium.registries.settingsSections.register({
        id: 'lx-source',
        label: { 'zh-CN': '洛雪音源适配', en: 'LX Music Source Adapter' },
        description: {
            'zh-CN': '导入洛雪音源脚本，为网易云/酷狗/QQ 解析播放地址；音质只对声明该音质的脚本生效。',
            en: 'Import LX Music source scripts to resolve playback URLs for Netease/Kugou/QQ songs. The quality preference applies to scripts that declare their qualities.',
        },
        settings: [
            {
                key: 'mode',
                type: 'select',
                defaultValue: 'fallback',
                label: { 'zh-CN': '替换策略', en: 'Replace mode' },
                options: [
                    { value: 'off', label: { 'zh-CN': '不替换：不改播放地址。', en: 'Do not replace: leave every URL alone.' } },
                    { value: 'fallback', label: { 'zh-CN': '仅兜底：内置源无地址时才用脚本；会员试听有地址，不会被替换。', en: 'Fallback only: use the script only when the built-in source returns no URL (VIP previews carry a URL and are kept).' } },
                    { value: 'always', label: { 'zh-CN': '总是替换：优先用脚本，试听/会员片段也替换。', en: 'Always replace: ask LX first; also replace preview/VIP clips.' } },
                ],
            },
            { key: 'enabledNetease', type: 'boolean', defaultValue: false },
            { key: 'enabledQq', type: 'boolean', defaultValue: false },
            { key: 'enabledKugou', type: 'boolean', defaultValue: false },
            {
                key: 'quality',
                type: 'select',
                defaultValue: DEFAULT_QUALITY,
                label: { 'zh-CN': '目标音质', en: 'Target quality' },
                options: QUALITY_OPTIONS,
            },
            {
                key: 'requestTimeoutMs',
                type: 'number',
                defaultValue: DEFAULT_REQUEST_TIMEOUT_MS,
                min: 3000,
                max: 60000,
                step: 1000,
                label: { 'zh-CN': '请求超时（毫秒）', en: 'Script request timeout (ms)' },
                description: {
                    'zh-CN': '单次脚本请求超时；冷启动慢可调到 30–60 秒。',
                    en: 'Per-request timeout for lx.request. Free-tier sources can be slow cold; 30–60 s is reasonable.',
                },
            },
        ],
        // 整张卡用自定义面板绘制，顺序：替换策略 / 替换平台 chip / 目标音质 / 请求超时；样式对齐宿主原生表单。
        settingsPanel: mountLxSettingsPanel,
    });
    const settings = section.settings;

    // A second card in the mod panel, above the command list. Its custom panel
    // owns the script list. The host requires a section to declare at least one
    // valid field, so keep one invisible placeholder (the custom panel replaces
    // the form and never renders it).
    folium.registries.settingsSections.register({
        id: 'lx-source-list',
        label: { 'zh-CN': '音源脚本', en: 'LX source: source list' },
        description: {
            'zh-CN': '导入、启用和管理脚本；解析时按列表顺序优先。',
            en: 'Import, enable and manage scripts; resolve in list order.',
        },
        settings: [
            { key: 'panel', type: 'boolean', defaultValue: true },
        ],
        settingsPanel: mountSourceListPanel,
    });

    const readSettings = () => {
        const values = settings.get();
        const quality = LX_QUALITY_OPTIONS.includes(String(values.quality)) ? String(values.quality) : DEFAULT_QUALITY;
        const requestTimeoutMs = Math.min(
            60000,
            Math.max(3000, Math.round(Number(values.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS)),
        );
        // 各平台是否走洛雪替换（默认关闭；用户点亮后该平台才替换，否则用内置原版）。
        const excluded = {
            netease: values.enabledNetease !== true,
            qq: values.enabledQq !== true,
            kugou: values.enabledKugou !== true,
        };
        return {
            mode: values.mode === 'off' ? 'off' : (values.mode === 'always' ? 'always' : 'fallback'),
            quality,
            requestTimeoutMs,
            excluded,
        };
    };

    let runtimes = [];
    let mainStatus = null;
    let disposed = false;
    let statusWarned = false;
    // Bumped whenever the stored script set or its loaded state changes, so the
    // list panel can skip a storage read while nothing happened.
    let uiVersion = 0;
    const bumpUi = () => { uiVersion += 1; };

    /**
     * Shared guard for the song-driven entry points. Returns the LX source id,
     * the id as a string, and the current settings, or null when the adapter is
     * disposed, the provider is unsupported, or the feature is disabled.
     */
    const songRequest = (song) => {
        if (disposed || !song || !song.id || !song.source) return null;
        const source = PROVIDER_TO_LX_SOURCE[song.source];
        if (!source) return null;
        const current = readSettings();
        if (current.mode === 'off') return null;
        if (current.excluded && current.excluded[song.source]) return null; // 该平台用内置原版，不替换
        return { source, id: String(song.id), settings: current };
    };

    /**
     * QQ 的 songmid：宿主的 FoliumSong 只给数字 songid，但 describeSong().pageUrl 的末段就是 songmid
     * （https://y.qq.com/n/ryqq/songDetail/<songmid>）。client 同步取到后随 payload 交给 main，main 直接用。
     * 只在 id 是数字时才算；已经是 songmid 的 id 无需转换。
     */
    const QQ_SONGMID = /^[0-9A-Za-z]{8,32}$/;
    // describeSong 按 id 缓存一次（会话内），同一首反复预热/切歌时不用重复算。
    const qqMidCache = new Map();
    const qqMidHint = (song, source, id) => {
        if (source !== 'tx' || !/^[1-9]\d*$/.test(String(id))) return null;
        const cacheKey = `tx:${id}`;
        if (qqMidCache.has(cacheKey)) return qqMidCache.get(cacheKey);
        try {
            const details = typeof folium.omni?.describeSong === 'function' ? folium.omni.describeSong(song) : null;
            const page = details && details.pageUrl;
            const seg = page ? decodeURIComponent(String(page).split('/').filter(Boolean).pop() || '') : '';
            const mid = QQ_SONGMID.test(seg) ? seg : null;
            if (mid) {
                if (qqMidCache.size > 2000) qqMidCache.delete(qqMidCache.keys().next().value);
                qqMidCache.set(cacheKey, mid);
            }
            return mid;
        } catch { return null; }
    };

    // main 持有的播放地址解析 / 缓存都在 index.cjs；这里只同步设置。
    const pushOptions = () => {
        const current = readSettings();
        void folium.rpc
            .call('lx.setOptions', { quality: current.quality, requestTimeoutMs: current.requestTimeoutMs })
            .catch((error) => folium.log.warn('[LX] 同步设置失败', error));
    };

    // 有脚本声明了该音源（或还没上报音源）时才值得替换，避免把脚本不支持的音源也劫持成 502。
    // 支持集在 runtimes 变化时重建；「未上报音源」的脚本视为支持所有音源（与原 some() 语义一致）。
    let sourceSupportUnknown = false;
    let sourceSupport = new Set();
    const rebuildSourceSupport = () => {
        sourceSupportUnknown = false;
        const next = new Set();
        for (const item of runtimes) {
            if (item.enabled === false || !item.runtime) continue;
            const sources = item.runtime.sources;
            if (!sources) {
                sourceSupportUnknown = true;
                continue;
            }
            for (const source of Object.keys(sources)) next.add(source);
        }
        sourceSupport = next;
    };
    const supportsSource = (source) => sourceSupportUnknown || sourceSupport.has(source);

    const applyStatus = (next) => {
        mainStatus = next || null;
        runtimes = Array.isArray(next?.scripts) ? next.scripts : [];
        rebuildSourceSupport();
        return mainStatus;
    };

    const refreshStatus = async () => {
        if (disposed) return null;
        try {
            const next = applyStatus(await folium.rpc.call('lx.status'));
            statusWarned = false;
            return next;
        } catch (error) {
            if (!statusWarned) {
                statusWarned = true;
                folium.log.warn('[LX] 读取状态失败', error);
            }
            return null;
        }
    };

    const toBase64Url = (text) => {
        const bytes = new TextEncoder().encode(text);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };

    /**
     * 同步生成占位地址。payload 里带 fallback（内置音源原本解析出的地址），
     * main 侧解析失败时回退到它，避免“内置能播的免费歌被脚本打断”。
     */
    const placeholderUrl = (port, request, song, fallback, mid) => {
        if (!port) return null;
        const payload = {
            source: request.source,
            id: request.id,
            quality: request.settings.quality,
            mid: mid || null,
            fallback: typeof fallback === 'string' && /^https?:\/\//i.test(fallback) ? fallback : null,
            song: {
                id: request.id,
                title: song?.title ?? '',
                artist: song?.artist ?? '',
                album: song?.album ?? '',
            },
        };
        return `http://127.0.0.1:${port}/p/${toBase64Url(JSON.stringify(payload))}`;
    };

    const clearUrlCache = () => {
        void folium.rpc
            .call('lx.clearCache')
            .then(() => refreshStatus())
            .catch((error) => folium.log.warn('[LX] 清除缓存失败', error));
    };

    const readEntries = async () => {
        const value = await folium.storage.get(STORAGE_SCRIPTS);
        return Array.isArray(value)
            ? value.filter(isScriptEntry).map((entry) => ({ ...entry, enabled: entry.enabled !== false }))
            : [];
    };

    const writeEntries = async (entries) => {
        const json = JSON.stringify(entries);
        const bytes = typeof TextEncoder === 'function'
            ? new TextEncoder().encode(json).length
            : json.length;
        if (bytes > STORAGE_BUDGET_BYTES) {
            throw new Error('音源脚本总大小超过 900 KB；Folia 的模组数据上限是 1 MB，请减少脚本数量');
        }
        await folium.storage.set(STORAGE_SCRIPTS, entries);
        // Callers reload the scripts afterwards; loadScripts() bumps the UI
        // version once the new runtimes are in place.
    };

    /** 让 main 重新读取存储里的脚本；返回面板需要的状态（scripts 视图）。 */
    const loadScripts = async () => {
        try {
            applyStatus(await folium.rpc.call('lx.reload'));
        } catch (error) {
            folium.log.error('[LX] 重新加载失败', error);
        }
        bumpUi();
        return runtimes;
    };

    /**
     * 预热：播放前先让 main 解析并缓存，取流时 302 更快。
     * 只有“总是替换”才需要：仅兜底时，内置有地址的歌根本不会走占位，预取纯属空跑；
     * 内置确实拿不到地址时，钩子生成占位后会自己再发一次预取，不依赖这里。
     * 去重：songChanged / beforePlay / queueChanged 会连着触发，同一首短时间内只 warm 一次，
     * 免得每次都对同一首跑 describeSong + lx.prefetch。失败重试传 force=true 跳过去重。
     */
    const warmSeen = new Map();
    const WARM_DEDUPE_MS = 5000;
    const warm = (song, force = false) => {
        const request = songRequest(song);
        if (!request || !supportsSource(request.source)) return;
        if (request.settings.mode !== 'always') return;
        const key = `${request.source}:${request.id}:${request.settings.quality}`;
        const now = Date.now();
        if (!force && now - (warmSeen.get(key) || 0) < WARM_DEDUPE_MS) return;
        warmSeen.set(key, now);
        if (warmSeen.size > 500) warmSeen.delete(warmSeen.keys().next().value);
        const mid = qqMidHint(song, request.source, request.id);
        void folium.rpc
            .call('lx.prefetch', {
                source: request.source,
                id: request.id,
                quality: request.settings.quality,
                mid,
                song: { id: request.id, title: song?.title ?? '', artist: song?.artist ?? '', album: song?.album ?? '' },
            })
            .catch(() => { });
    };

    /**
     * 顺带预热队列里的下 1–2 首。getQueue 是只读接口，不需要额外权限；
     * 预取结果由 main 的解析缓存去重，切歌时基本能直接命中。
     */
    const warmQueueNeighbors = () => {
        try {
            const getQueue = folium.playback?.getQueue;
            if (typeof getQueue !== 'function') return;
            const snapshot = getQueue({ limit: 12 });
            if (!snapshot || snapshot.kind === 'stage' || snapshot.currentIndex < 0) return;
            for (const offset of [1, 2]) {
                const item = snapshot.items?.find((entry) => entry.index === snapshot.currentIndex + offset);
                if (item?.song) warm(item.song);
            }
        } catch (error) {
            folium.log.warn('[LX] 读取队列失败', error);
        }
    };

    const invalidate = (source, id, quality) => {
        void folium.rpc.call('lx.invalidate', { source, id, quality }).catch(() => { });
    };

    const disposers = [];

    // Warm on both events: beforePlay is earlier, songChanged covers a song that
    // is already displayed when the mod starts or when playback moves on.
    disposers.push(folium.events.on('playback.songChanged', ({ song }) => {
        warm(song);
        warmQueueNeighbors();
    }));
    disposers.push(folium.events.on('playback.beforePlay', ({ song }) => warm(song)));
    // 队列变化时下一首可能变了，提前把新的下一首也预热掉。
    disposers.push(folium.events.on('playback.queueChanged', () => warmQueueNeighbors()));

    disposers.push(folium.events.on('playback.failed', ({ song, phase }) => {
        const request = songRequest(song);
        if (!request) return;
        invalidate(request.source, request.id, request.settings.quality);
        if (phase === 'play') warm(song, true);
    }));

    // 设置变化同步给 main；音质变化时 main 会自行清除缓存。
    disposers.push(settings.onChange(() => {
        pushOptions();
        bumpUi();
    }));

    try {
        const currentSong = folium.playback.getState()?.song ?? null;
        if (currentSong) {
            warm(currentSong);
            warmQueueNeighbors();
        }
    } catch {
        // Playback is not ready during activation; the later events still warm it.
    }

    // main 的代理端口/脚本状态可能比 client 稍晚就绪。用 rpc 状态事件即时刷新，轮询只做兜底。
    const supportsRpcEvents = typeof folium.rpc.on === 'function';
    if (supportsRpcEvents) {
        try {
            disposers.push(folium.rpc.on('lx.statusChanged', () => { if (!disposed) void refreshStatus(); }));
        } catch (error) {
            folium.log.warn('[LX] 订阅状态失败', error);
        }
    }
    if (typeof folium.every === 'function') {
        folium.every(supportsRpcEvents ? 30_000 : 5_000, () => { if (!disposed) void refreshStatus(); });
    }

    // omni 音频钩子：Folium 2 里是类型化事件 omni.audioSourceResolved（需 experimental: ["omni.hooks"]）。
    // 关键：同步处理器，绝不 await。只把 event.url 改成占位地址，慢解析交给
    // main，在播放器取流时才进行——这样不受钩子时限影响。
    let hookDisposer = null;
    try {
        hookDisposer = folium.events.on('omni.audioSourceResolved', (event) => {
            const request = songRequest(event.song);
            if (!request) return;
            if (!supportsSource(request.source)) return;
            // 仅兜底：内置音源已经有地址就不动它。
            if (request.settings.mode !== 'always' && event.url) return;
            const port = mainStatus?.proxyPort;
            if (!port) return;
            const fallback = typeof event.url === 'string' ? event.url : null;
            // 先从 describeSong().pageUrl 取 QQ 的 songmid（同步、不联网），随 payload 交给 main，省掉一次 get_song_detail_yqq。
            const mid = qqMidHint(event.song, request.source, request.id);
            const placeholder = placeholderUrl(port, request, event.song, fallback, mid);
            if (!placeholder) return;
            event.url = placeholder;
            void folium.rpc
                .call('lx.prefetch', {
                    source: request.source,
                    id: request.id,
                    quality: request.settings.quality,
                    mid,
                    fallback,
                    song: {
                        id: request.id,
                        title: event.song?.title ?? '',
                        artist: event.song?.artist ?? '',
                        album: event.song?.album ?? '',
                    },
                })
                .catch(() => { });
        }, { priority: 'low' });
    } catch (error) {
        folium.log.warn('[LX] omni.audioSourceResolved 不可用，无法替换播放地址', error);
    }

    const addScript = async (raw, fallbackName) => {
        const code = await decodeLxScript(raw);
        const meta = parseScriptMeta(code, fallbackName);
        const entries = await readEntries();
        const existing = entries.findIndex((entry) => entry.name === meta.name);
        const previous = existing >= 0 ? entries[existing] : null;
        const entry = {
            id: previous ? previous.id : `lx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            name: meta.name,
            code: raw,
            version: meta.version,
            description: meta.description,
            homepage: meta.homepage,
            importedAt: Date.now(),
            enabled: previous ? previous.enabled !== false : true,
        };
        if (previous) entries[existing] = entry;
        else entries.push(entry);
        await writeEntries(entries);
        const loaded = await loadScripts();
        const loadedItem = loaded.find((item) => item.id === entry.id);
        if (!loadedItem || (entry.enabled !== false && (loadedItem.error || !loadedItem.runtime))) {
            // The entry was written but its code did not load (syntax error, bad
            // payload). Restore the previous version, or drop the new entry, so
            // the stored set stays playable.
            await writeEntries(previous
                ? entries.map((item) => (item.id === entry.id ? previous : item))
                : entries.filter((item) => item.id !== entry.id));
            await loadScripts();
            throw new Error(`脚本 "${meta.name}" 加载失败：检查语法或格式`);
        }
        void folium.rpc.call('lx.clearCache').catch(() => { });
        return meta.name;
    };

    const buildStatus = () => {
        const loadedCount = runtimes.filter((item) => item.runtime).length;
        const lines = [`脚本 ${loadedCount} 个 · URL 缓存 ${mainStatus?.cacheCount ?? 0} 条`];
        for (const { name, meta, runtime, enabled, error } of runtimes) {
            const version = (meta.version || '').replace(/^[vV]/i, '');
            const label = `${name}${version ? ` v${version}` : ''}`;
            if (enabled === false) {
                lines.push(`${label} → (已停用)`);
                continue;
            }
            if (error) {
                lines.push(`${label} → (加载失败：${error})`);
                continue;
            }
            const sources = runtime?.sources ? Object.keys(runtime.sources) : [];
            const detail = sources.length > 0
                ? sources.map((source) => {
                    const qualitys = runtime.sources[source]?.qualitys;
                    return Array.isArray(qualitys) && qualitys.length > 0
                        ? `${source}(${qualitys.join('/')})`
                        : source;
                }).join(', ')
                : '(未声明音源)';
            lines.push(`${label} → ${detail}`);
        }
        return lines.join('\n');
    };



    /**
     * 「洛雪音源适配」卡的自定义面板：整张卡按宿主原生表单的样式绘制。
     * 顺序：替换策略（下拉） / 替换平台（按钮 chip） / 目标音质（下拉） / 请求超时（滑杆）。
     * 替换平台是唯一自定义按钮（宿主内置控件没有多选/按钮组），其它控件按原生观感绘制。
     */
    function mountLxSettingsPanel(container, panelCtx) {
        const doc = container.ownerDocument;
        const access = panelCtx.settings;
        const locale = String(panelCtx.locale || 'zh-CN');
        const tr = makeTr(locale);
        const pickLabel = (label) => pickFoliumLabel(label, locale);
        let cleanup = null;
        const build = () => {
            if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
            container.replaceChildren();
        const { day, accent, onAccent, text, muted, fieldBg, fieldBorder, hoverFill, borderStrong, trackColor } = resolvePanelColors(panelCtx);
        const selectCss = `width:100%;box-sizing:border-box;border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;line-height:1.3;outline:none;background:${fieldBg};border:1px solid ${fieldBorder};color:${text};`;
        const PLATFORMS = [
            { field: 'enabledNetease', label: tr('网易云', 'NetEase') },
            { field: 'enabledQq', label: tr('QQ 音乐', 'QQ Music') },
            { field: 'enabledKugou', label: tr('酷狗', 'Kugou') },
        ];
        const CHIP_FIELDS = new Set(PLATFORMS.map((platform) => platform.field));
        const controls = new Map();
        const dropdowns = [];
        const root = doc.createElement('div');
        root.style.cssText = 'display:flex;flex-direction:column;gap:14px;';
        // 自绘滑杆轨道/圆点（原生 accent-color 只染圆点，轨道填充不跟）。
        const rangeStyleEl = doc.createElement('style');
        rangeStyleEl.textContent = '.lx-range{-webkit-appearance:none;appearance:none;width:100%;height:18px;background:transparent;cursor:pointer;}.lx-range::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:linear-gradient(to right,var(--lx-range-accent) 0,var(--lx-range-accent) var(--lx-range-p,0%),var(--lx-range-track) var(--lx-range-p,0%),var(--lx-range-track) 100%);}.lx-range::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-5px;border-radius:50%;background:var(--lx-range-accent);box-shadow:0 1px 3px rgba(0,0,0,.35);}';
        root.append(rangeStyleEl);

        const labelEl = (value) => {
            const node = doc.createElement('div');
            node.textContent = value;
            node.style.cssText = `font-size:12px;line-height:1.3;opacity:.7;color:${text};`;
            return node;
        };

        const buildSelect = (field) => {
            const cell = doc.createElement('div');
            cell.style.cssText = 'position:relative;display:flex;flex-direction:column;gap:5px;min-width:0;';
            cell.append(labelEl(pickLabel(field.label)));
            const trigger = doc.createElement('button');
            trigger.type = 'button';
            trigger.setAttribute('aria-haspopup', 'listbox');
            trigger.style.cssText = `${selectCss}display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;text-align:left;`;
            const valueSpan = doc.createElement('span');
            valueSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            const caret = doc.createElement('span');
            caret.textContent = '▾';
            caret.style.cssText = 'flex:0 0 auto;opacity:.6;font-size:11px;transition:transform .15s ease;';
            trigger.append(valueSpan, caret);
            const menu = doc.createElement('div');
            menu.setAttribute('role', 'listbox');
            menu.style.cssText = `position:absolute;left:0;right:0;top:100%;margin-top:4px;z-index:60;display:none;flex-direction:column;gap:2px;padding:4px;border-radius:8px;background:${day ? '#ffffff' : '#26262b'};border:1px solid ${fieldBorder};box-shadow:0 10px 28px rgba(0,0,0,.28);max-height:240px;overflow:auto;`;
            const record = {
                cell,
                isOpen: () => menu.style.display === 'flex',
                close: () => { menu.style.display = 'none'; caret.style.transform = 'none'; },
            };
            dropdowns.push(record);
            const itemEls = [];
            let activeIndex = 0;
            const paint = () => {
                const current = (access.get() || {})[field.key];
                itemEls.forEach((entry, index) => {
                    const selected = String(entry.value) === String(current);
                    entry.el.dataset.sel = selected ? '1' : '0';
                    entry.el.setAttribute('aria-selected', selected ? 'true' : 'false');
                    entry.el.style.background = selected
                        ? `color-mix(in srgb, var(--folium-accent, ${accent}) 16%, transparent)`
                        : (index === activeIndex && record.isOpen() ? hoverFill : 'transparent');
                    entry.el.style.color = selected ? `var(--folium-accent, ${accent})` : text;
                    entry.el.style.fontWeight = selected ? '600' : '400';
                });
            };
            for (const option of field.options || []) {
                const item = doc.createElement('button');
                item.type = 'button';
                item.setAttribute('role', 'option');
                item.textContent = pickLabel(option.label);
                item.style.cssText = `text-align:left;font:inherit;font-size:13px;line-height:1.5;padding:9px 10px;border-radius:6px;border:0;background:transparent;color:${text};cursor:pointer;white-space:normal;`;
                item.addEventListener('mousemove', () => {
                    const index = itemEls.findIndex((entry) => entry.el === item);
                    if (index >= 0 && index !== activeIndex) { activeIndex = index; paint(); }
                });
                item.addEventListener('click', (event) => { event.stopPropagation(); access.set({ [field.key]: option.value }); record.close(); });
                menu.append(item);
                itemEls.push({ value: option.value, el: item });
            }
            const openMenu = () => {
                dropdowns.forEach((other) => { if (other !== record && other.isOpen()) other.close(); });
                const current = (access.get() || {})[field.key];
                activeIndex = Math.max(0, itemEls.findIndex((entry) => String(entry.value) === String(current)));
                menu.style.display = 'flex';
                caret.style.transform = 'rotate(180deg)';
                paint();
            };
            const choose = (index) => {
                const entry = itemEls[index];
                if (!entry) return;
                access.set({ [field.key]: entry.value });
                record.close();
                trigger.focus();
            };
            trigger.addEventListener('click', (event) => {
                event.stopPropagation();
                if (record.isOpen()) record.close(); else openMenu();
            });
            // 键盘操作：上下键移动、Enter/空格选中、Esc 关闭（替代原生 select 的键盘行为）。
            trigger.addEventListener('keydown', (event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    if (!record.isOpen()) { openMenu(); return; }
                    const delta = event.key === 'ArrowDown' ? 1 : -1;
                    activeIndex = (activeIndex + delta + itemEls.length) % itemEls.length;
                    paint();
                } else if (event.key === 'Home' && record.isOpen()) {
                    event.preventDefault(); activeIndex = 0; paint();
                } else if (event.key === 'End' && record.isOpen()) {
                    event.preventDefault(); activeIndex = itemEls.length - 1; paint();
                } else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (record.isOpen()) choose(activeIndex); else openMenu();
                } else if (event.key === 'Escape' && record.isOpen()) {
                    event.preventDefault();
                    record.close();
                }
            });
            cell.append(trigger, menu);
            if (field.description) cell.title = pickLabel(field.description);
            const sync = () => {
                paint();
                const current = (access.get() || {})[field.key];
                const selected = itemEls.find((entry) => String(entry.value) === String(current)) || itemEls[0];
                valueSpan.textContent = selected ? selected.el.textContent : '';
            };
            controls.set(field.key, { kind: 'select', sync });
            return cell;
        };

        const buildNumber = (field) => {
            const cell = doc.createElement('div');
            cell.style.cssText = 'display:flex;flex-direction:column;gap:5px;min-width:0;';
            const head = doc.createElement('div');
            head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
            const valueEl = doc.createElement('span');
            valueEl.style.cssText = `font-size:11px;font-variant-numeric:tabular-nums;color:${muted};flex:0 0 auto;`;
            head.append(labelEl(pickLabel(field.label)), valueEl);
            const range = doc.createElement('input');
            range.type = 'range';
            if (field.min !== undefined) range.min = String(field.min);
            if (field.max !== undefined) range.max = String(field.max);
            range.step = String(field.step ?? 1);
            // 自绘轨道：填充段+圆点都用 accent，未填充段用中性轨道色。
            const baseAccent = `var(--folium-accent, ${accent})`;
            const hoverAccent = `color-mix(in srgb, var(--folium-accent, ${accent}) 86%, #000)`;
            const pctOf = (value) => {
                const min = field.min ?? 0;
                const max = field.max ?? 100;
                const n = Number(value);
                return Math.max(0, Math.min(100, ((Number.isFinite(n) ? n : min) - min) / Math.max(1, max - min) * 100));
            };
            const setFill = () => range.style.setProperty('--lx-range-p', `${pctOf(range.value).toFixed(2)}%`);
            range.className = 'lx-range';
            range.style.cssText = `width:100%;cursor:pointer;--lx-range-track:${trackColor};`;
            range.style.setProperty('--lx-range-accent', baseAccent);
            setFill();
            range.addEventListener('mouseenter', () => range.style.setProperty('--lx-range-accent', hoverAccent));
            range.addEventListener('mouseleave', () => range.style.setProperty('--lx-range-accent', baseAccent));
            range.addEventListener('input', () => { valueEl.textContent = range.value; setFill(); });
            range.addEventListener('change', () => {
                const value = Number(range.value);
                access.set({ [field.key]: Number.isFinite(value) ? value : field.defaultValue });
            });
            cell.append(head, range);
            if (field.description) cell.title = pickLabel(field.description);
            controls.set(field.key, { kind: 'number', el: range, valueEl, setFill });
            return cell;
        };

        const platformRow = doc.createElement('div');
        platformRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
        const platformBlock = () => {
            const cell = doc.createElement('div');
            cell.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
            cell.append(labelEl(tr('替换平台', 'Replace by platform')));
            cell.append(platformRow);
            cell.title = tr('点亮 = 走洛雪替换；熄灭 = 用内置原版', 'Lit = routed to LX; off = keep the built-in original');
            return cell;
        };
        const renderPlatforms = () => {
            const values = access.get() || {};
            platformRow.replaceChildren(...PLATFORMS.map((platform) => {
                const on = values[platform.field] === true;
                const chip = doc.createElement('button');
                chip.type = 'button';
                chip.textContent = platform.label;
                chip.setAttribute('aria-pressed', on ? 'true' : 'false');
                chip.style.cssText = [
                    'font:inherit', 'font-size:12px', 'line-height:1', 'border-radius:999px',
                    'padding:6px 14px', 'cursor:pointer', 'transition:all .15s ease', 'user-select:none',
                    on
                        ? `background:var(--folium-accent, ${accent});color:${onAccent};border:1px solid transparent;`
                        : `background:transparent;color:${text};border:1px solid ${fieldBorder};`,
                ].join(';');
                const baseBackground = on ? `var(--folium-accent, ${accent})` : 'transparent';
                chip.addEventListener('mouseenter', () => {
                    if (on) {
                        chip.style.background = `color-mix(in srgb, var(--folium-accent, ${accent}) 86%, #000)`;
                    } else {
                        chip.style.background = hoverFill;
                        chip.style.borderColor = borderStrong;
                    }
                });
                chip.addEventListener('mouseleave', () => {
                    chip.style.background = baseBackground;
                    chip.style.borderColor = on ? 'transparent' : fieldBorder;
                });
                chip.addEventListener('click', () => {
                    access.set({ [platform.field]: !on });
                    try { void folium.rpc.call('lx.clearCache'); } catch { /* ignore */ }
                });
                return chip;
            }));
        };

        let platformMounted = false;
        for (const field of access.schema) {
            if (CHIP_FIELDS.has(field.key)) continue;
            if (field.type === 'select') root.append(buildSelect(field));
            else if (field.type === 'number') root.append(buildNumber(field));
            else continue;
            if (field.key === 'mode') { root.append(platformBlock()); platformMounted = true; }
        }
        if (!platformMounted) root.append(platformBlock());

        const sync = () => {
            const values = access.get() || {};
            for (const [key, control] of controls) {
                if (control.kind === 'select') {
                    control.sync();
                } else {
                    const value = Number(values[key]);
                    const shown = Number.isFinite(value) ? String(value) : '';
                    control.el.value = shown;
                    control.valueEl.textContent = shown;
                    if (typeof control.setFill === 'function') control.setFill();
                }
            }
            renderPlatforms();
        };

        const onDocDown = (event) => {
            const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
            dropdowns.forEach((record) => { if (record.isOpen() && !path.includes(record.cell)) record.close(); });
        };
        doc.addEventListener('mousedown', onDocDown, true);

            container.append(root);
            sync();
            const off = typeof access.onChange === 'function' ? access.onChange(sync) : () => {};
            cleanup = () => {
                try { off(); } catch { /* ignore */ }
                doc.removeEventListener('mousedown', onDocDown, true);
                root.remove();
            };
        };
        build();
        // 主题/明暗变化时重建（颜色是挂载时算的，重建才能跟随）。
        const offTheme = typeof panelCtx.onChange === 'function' ? panelCtx.onChange(() => build()) : () => {};
        return () => {
            try { offTheme(); } catch { /* ignore */ }
            if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
            container.replaceChildren();
        };
    }

    /**
     * Custom panel for the "音源脚本" card. It only owns the list: import one
     * file, then enable/disable or delete each script. The global adapter
     * settings stay in the original "洛雪音源适配" card above it.
     */
    function mountSourceListPanel(container, panelCtx) {
        const doc = container.ownerDocument;
        const access = panelCtx.settings;
        const tr = makeTr(panelCtx.locale || 'zh-CN');
        const timers = new Set();
        let disposedPanel = false;
        let busy = false;
        let dragging = false;
        let notice = null;
        let noticeTimer = null;
        let urlDraft = '';
        let renderedVersion = -1;
        let renderToken = 0;
        let currentRoot = null;

        const el = (tag, props = {}, children = []) => {
            const node = doc.createElement(tag);
            for (const [key, value] of Object.entries(props)) {
                if (value === undefined || value === null || value === false) continue;
                if (key === 'class') node.className = value;
                else if (key === 'text') node.textContent = value;
                else if (key === 'onclick') node.addEventListener('click', value);
                else if (key === 'onchange') node.addEventListener('change', value);
                else if (key === 'value') node.value = value;
                else node.setAttribute(key, value === true ? '' : String(value));
            }
            for (const child of [].concat(children)) {
                if (child !== null && child !== undefined && child !== false) node.append(child);
            }
            return node;
        };

        const button = (label, onClick, options = {}) => el('button', {
            class: `lx-list-btn${options.primary ? ' lx-list-btn-primary' : ''}${options.danger ? ' lx-list-btn-danger' : ''}${options.quiet ? ' lx-list-btn-quiet' : ''}`,
            type: 'button',
            title: options.title || label,
            onclick: onClick,
        }, [label]);

        const refresh = async (force = false) => {
            if (disposedPanel) return;
            if (!force && uiVersion === renderedVersion) return;
            const version = uiVersion;
            const token = ++renderToken;
            const entries = await readEntries();
            if (disposedPanel || token !== renderToken) return;
            renderedVersion = version;
            render(entries);
        };

        const safeRefresh = (force = false) => {
            void refresh(force).catch((error) => folium.log.warn('[LX] 刷新源列表失败', error));
        };

        const importFile = async () => {
            busy = true;
            notice = null;
            safeRefresh(true);
            try {
                const handle = await folium.ui.pickFile({ accept: 'any' });
                if (!handle) return;
                const response = await fetch(handle.url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const name = await addScript(await response.text(), stripExtension(handle.name));
                notice = { text: tr(`已导入 ${name}`, `Imported ${name}`), kind: 'success' };
            } catch (error) {
                notice = {
                    text: tr(`导入失败：${error.message}`, `Import failed: ${error.message}`),
                    kind: 'error',
                };
            } finally {
                busy = false;
                safeRefresh(true);
            }
        };

        const importUrl = async (value) => {
            const url = String(value || '').trim();
            if (!url) {
                notice = { text: tr('请填写脚本 URL', 'Enter a script URL'), kind: 'error' };
                safeRefresh(true);
                return;
            }
            busy = true;
            notice = null;
            safeRefresh(true);
            try {
                const response = await folium.net.fetch(url, { timeoutMs: readSettings().requestTimeoutMs });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const name = await addScript(response.text(), filenameFromUrl(url));
                urlDraft = '';
                notice = { text: tr(`已导入 ${name}`, `Imported ${name}`), kind: 'success' };
            } catch (error) {
                notice = {
                    text: tr(`导入失败：${error.message}`, `Import failed: ${error.message}`),
                    kind: 'error',
                };
            } finally {
                busy = false;
                safeRefresh(true);
            }
        };

        const changeEntry = async (entry, action) => {
            busy = true;
            notice = null;
            safeRefresh(true);
            try {
                const entries = await readEntries();
                const target = entries.find((item) => item.id === entry.id);
                if (!target) throw new Error(tr('脚本已不存在', 'The script no longer exists'));
                if (action === 'remove') {
                    await writeEntries(entries.filter((item) => item.id !== target.id));
                    await loadScripts();
                    void folium.rpc.call('lx.clearCache').catch(() => { });
                    notice = { text: tr('已删除', 'Deleted'), kind: 'success' };
                } else {
                    const enabled = action === 'enable';
                    const next = entries.map((item) => (item.id === target.id ? { ...item, enabled } : item));
                    await writeEntries(next);
                    await loadScripts();
                    if (enabled) {
                        const loaded = runtimes.find((item) => item.id === target.id);
                        if (!loaded || loaded.error || !loaded.runtime) {
                            await writeEntries(entries);
                            await loadScripts();
                            throw new Error(loaded?.error || `脚本 "${target.name}" 加载失败`);
                        }
                    }
                    void folium.rpc.call('lx.clearCache').catch(() => { });
                }
            } catch (error) {
                const verb = action === 'remove' ? tr('删除', 'Delete') : action === 'enable' ? tr('启用', 'Enable') : tr('停用', 'Disable');
                notice = {
                    text: tr(`${verb}失败：${error.message}`, `${verb} failed: ${error.message}`),
                    kind: 'error',
                };
            }
            busy = false;
            safeRefresh(true);
        };

        // 拖动排序：松手后按 DOM 里卡片的先后写回存储。解析按这个顺序逐个尝试，
        // 所以把响应快的脚本拖到前面就能更早命中（见 main 的 resolveNow）。
        const commitOrder = async (ids) => {
            if (busy) return;
            busy = true;
            notice = null;
            try {
                const entries = await readEntries();
                const next = [];
                for (const id of ids) {
                    const found = entries.find((item) => item.id === id);
                    if (found) next.push(found);
                }
                for (const entry of entries) {
                    if (!ids.includes(entry.id)) next.push(entry);
                }
                const changed = next.some((entry, i) => entries[i]?.id !== entry.id);
                if (changed) {
                    await writeEntries(next);
                    await loadScripts();
                    // 顺序变了，旧的解析结果可能来自原本排在前面的脚本，清掉让新顺序立即生效。
                    void folium.rpc.call('lx.clearCache').catch(() => { });
                }
            } catch (error) {
                notice = {
                    text: tr(`调整顺序失败：${error.message}`, `Reorder failed: ${error.message}`),
                    kind: 'error',
                };
            }
            busy = false;
            safeRefresh(true);
        };

        // 右侧 ⠿ 把手：按住上下拖，卡片实时换位，松手后落盘。
        // move/up 挂在 document 上（而不是只挂把手），指针移出把手或捕获失败也能跟手；
        // 按下即置 dragging，暂停面板 1.2s 自动刷新，避免拖到一半被重渲染打断。
        const attachDrag = (handle, card) => {
            handle.addEventListener('pointerdown', (event) => {
                if (busy) return;
                const listEl = card.parentNode || card.parent;
                if (!listEl) return;
                const ownerDoc = container.ownerDocument || doc;
                const pointerId = event.pointerId === undefined ? 1 : event.pointerId;
                const startY = Number(event.clientY) || 0;
                let active = false;
                let safety = null;

                function onMove(ev) {
                    if (ev.pointerId !== undefined && ev.pointerId !== pointerId) return;
                    const y = Number(ev.clientY) || 0;
                    if (!active && Math.abs(y - startY) < 4) return;
                    if (!active) {
                        active = true;
                        card.classList.add('is-dragging');
                    }
                    const siblings = Array.from(listEl.children).filter((node) => node !== card);
                    let placed = false;
                    for (const sibling of siblings) {
                        const rect = sibling.getBoundingClientRect();
                        if (y < rect.top + rect.height / 2) {
                            listEl.insertBefore(card, sibling);
                            placed = true;
                            break;
                        }
                    }
                    if (!placed) listEl.append(card);
                }

                function onUp() { finish(true); }
                function onCancel() { finish(false); }
                function finish(commit) {
                    ownerDoc.removeEventListener('pointermove', onMove, true);
                    ownerDoc.removeEventListener('pointerup', onUp, true);
                    ownerDoc.removeEventListener('pointercancel', onCancel, true);
                    if (safety !== null) { clearTimeout(safety); timers.delete(safety); safety = null; }
                    if (active) card.classList.remove('is-dragging');
                    dragging = false;
                    if (commit && active) {
                        const ids = Array.from(listEl.children)
                            .map((node) => node.dataset?.id)
                            .filter(Boolean);
                        void commitOrder(ids);
                    }
                    active = false;
                }

                dragging = true;
                ownerDoc.addEventListener('pointermove', onMove, true);
                ownerDoc.addEventListener('pointerup', onUp, true);
                ownerDoc.addEventListener('pointercancel', onCancel, true);
                safety = setTimeout(() => finish(false), 10000);
                timers.add(safety);
                event.preventDefault?.();
            });
        };

        const resetRemoveLabel = (node) => {
            node.dataset.confirm = '';
            node.textContent = tr('删除', 'Delete');
        };
        const confirmRemove = (entry, node) => {
            if (node.dataset.confirm !== '1') {
                node.dataset.confirm = '1';
                node.textContent = tr('确认', 'Confirm');
                const timer = setTimeout(() => {
                    timers.delete(timer);
                    if (!disposedPanel && node.isConnected) resetRemoveLabel(node);
                }, 3000);
                timers.add(timer);
                return;
            }
            void changeEntry(entry, 'remove');
        };

        // One source = one horizontal card (icon / info / state / actions).
        const sourceCard = (entry, item, total = 1) => {
            const enabled = entry.enabled !== false;
            const version = (item?.meta?.version || entry.version || '').replace(/^[vV]/i, '');
            const loaded = enabled && Boolean(item?.runtime);
            const failed = enabled && Boolean(item?.error);
            const description = String(item?.meta?.description || entry.description || '').trim();
            const descText = failed
                ? tr(`加载失败：${item.error}`, `Failed: ${item.error}`)
                : (description || tr('音源脚本', 'LX source script'));

            const actionText = enabled ? tr('停用', 'Disable') : tr('启用', 'Enable');
            const stateToggle = el('button', {
                class: `lx-source-switch${enabled ? ' is-on' : ''}${failed ? ' is-error' : ''}`,
                type: 'button',
                role: 'switch',
                'aria-checked': enabled ? 'true' : 'false',
                title: enabled ? tr('点击停用', 'Click to disable') : tr('点击启用', 'Click to enable'),
                'aria-label': enabled ? tr('停用这个脚本', 'Disable this script') : tr('启用这个脚本', 'Enable this script'),
                onclick: () => { void changeEntry(entry, enabled ? 'disable' : 'enable'); },
            }, [
                el('span', { class: 'lx-source-switch-track' }, [
                    el('span', { class: 'lx-source-switch-thumb' }),
                    el('span', { class: 'lx-source-switch-action', text: actionText, 'aria-hidden': 'true' }),
                ]),
            ]);
            stateToggle.disabled = busy;

            const remove = el('button', {
                class: 'lx-list-btn lx-list-btn-danger',
                type: 'button',
                text: tr('删除', 'Delete'),
                title: tr(`删除 ${entry.name}`, `Delete ${entry.name}`),
                'aria-label': tr(`删除 ${entry.name}`, `Delete ${entry.name}`),
            });
            remove.disabled = busy;
            remove.addEventListener('click', () => confirmRemove(entry, remove));

            // 右侧 ⠿ 拖拽把手：多脚本时可拖动排序；只有 1 个时也显示，但不能拖。
            const canDrag = total > 1;
            const dragHandle = el('span', {
                class: 'lx-drag-handle',
                text: '⠿',
                title: canDrag ? tr('按住拖动排序，越靠上越先解析', 'Drag to reorder') : tr('只有一个脚本，无需排序', 'Only one script; nothing to reorder'),
                'aria-label': canDrag ? tr(`拖动调整 ${entry.name} 的顺序`, `Drag to reorder ${entry.name}`) : tr('只有一个脚本，无需排序', 'Only one script'),
                'aria-disabled': canDrag ? undefined : 'true',
            });
            if (!canDrag) {
                dragHandle.style.cursor = 'default';
                dragHandle.style.opacity = '.45';
            }

            const card = el('div', { class: `lx-source-card${loaded ? ' is-active' : ''}` }, [
                el('div', { class: 'lx-source-main' }, [
                    el('div', { class: 'lx-source-name-row' }, [
                        el('span', { class: 'lx-source-name', text: entry.name, title: entry.name }),
                        version ? el('span', { class: 'lx-version-pill', text: `v${version}` }) : null,
                    ]),
                    el('p', {
                        class: `lx-source-desc${failed ? ' is-error' : ''}`,
                        text: descText,
                        title: descText,
                    }),
                ]),
                stateToggle,
                el('div', { class: 'lx-source-actions' }, [remove, dragHandle]),
            ]);
            card.dataset.id = entry.id;
            if (canDrag) attachDrag(dragHandle, card);
            return card;
        };

        const styleElement = () => {
            const style = doc.createElement('style');
            style.textContent = `
.lx-list-panel {
    --lx-text:#172B4D; --lx-text-secondary:#71829E; --lx-border:rgba(23,43,77,.1); --lx-border-strong:rgba(23,43,77,.18);
    --lx-card-bg:rgba(23,43,77,.035); --lx-field:rgba(23,43,77,.04); --lx-field-focus:rgba(255,255,255,.6);
    --lx-btn-border:rgba(23,43,77,.12); --lx-btn-border-strong:rgba(23,43,77,.2); --lx-hover-fill:rgba(23,43,77,.05); --lx-chip:rgba(23,43,77,.06);
    --lx-primary:#2878F0; --lx-primary-hover:#1765D8; --lx-primary-ink:#2878F0; --lx-on-primary:#FFFFFF;
    --lx-success:#16B978; --lx-disabled:#94A3B8;
    --lx-success-bg:#E7F8F0; --lx-success-border:#CFEFE1; --lx-success-fg:#0F9D63;
    --lx-off-bg:#F1F4F9; --lx-off-fg:#64748B; --lx-off-border:#E5EAF2;
    --lx-danger:#F06464; --lx-danger-fg:#D64545; --lx-danger-bg:#FEF0F0; --lx-danger-border:#FBD5D5; --lx-danger-hover:#FFF5F5;
    --lx-active-bg:#F5F9FF; --lx-active-border:#CFE0FB;
    box-sizing:border-box; display:flex; flex-direction:column; gap:10px; padding:0;
    background:transparent; color:var(--lx-text); font-size:12px; line-height:1.5;
    font-family:var(--folium-font, inherit); container-type:inline-size;
}
.lx-list-panel *, .lx-list-panel *::before, .lx-list-panel *::after { box-sizing:border-box; }
.lx-list-panel p, .lx-list-panel h2 { margin:0; }

/* ---- import row ---- */
.lx-import { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.lx-import-field { flex:1 1 240px; min-width:0; display:flex; align-items:center; gap:7px; height:32px; padding:0 10px;
    background:var(--lx-field); border:1px solid var(--lx-border); border-radius:8px; transition:background-color .15s, border-color .15s, box-shadow .15s; }
.lx-import-field:focus-within { background:var(--lx-field-focus); border-color:var(--lx-primary); box-shadow:0 0 0 3px color-mix(in srgb, var(--lx-primary) 14%, transparent); }
.lx-import-field > .lx-import-link { flex:0 0 auto; font-size:13px; line-height:1; }
.lx-list-url-input { flex:1 1 auto; min-width:0; height:100%; border:0; outline:none; background:transparent; padding:0;
    color:var(--lx-text); font:inherit; font-size:12px; }
.lx-list-url-input::placeholder { color:var(--lx-disabled); }
.lx-list-url-input:disabled { color:var(--lx-disabled); }
.lx-import-actions { display:flex; align-items:center; gap:7px; flex:0 0 auto; }
.lx-icon-file::before { content:'📁'; font-size:16px; }
.lx-icon-status::before { content:'🩺'; font-size:16px; }
.lx-icon-file, .lx-icon-status { width:42px; padding:0; }
.lx-list-notice-clear { flex:0 0 auto; flex-shrink:0; align-self:center; margin-left:auto; padding:0; border:0; background:transparent; font:inherit; font-size:10.5px; line-height:1.15; color:var(--lx-text-secondary); text-decoration:none; opacity:.75; cursor:pointer; white-space:pre-line; text-align:center; }
.lx-list-notice-clear:hover { opacity:1; }

/* ---- buttons ---- */
.lx-list-btn { box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; gap:5px;
    height:32px; padding:0 12px; border-radius:8px; border:1px solid var(--lx-btn-border); background:var(--lx-card-bg); color:var(--lx-primary-ink);
    font:inherit; font-size:12px; font-weight:600; line-height:1; white-space:nowrap; cursor:pointer;
    transition:background-color .15s, border-color .15s, color .15s, opacity .15s, box-shadow .15s; }
.lx-list-btn:hover { background:var(--lx-hover-fill); border-color:var(--lx-btn-border-strong); }
.lx-list-btn:focus-visible { outline:2px solid var(--lx-primary); outline-offset:2px; }
.lx-list-btn:disabled { opacity:.55; cursor:default; box-shadow:none; }
.lx-list-btn-primary { background:var(--lx-primary); border-color:var(--lx-primary); color:var(--lx-on-primary); box-shadow:0 3px 8px color-mix(in srgb, var(--lx-primary) 24%, transparent); }
.lx-list-btn-primary:hover { background:var(--lx-primary-hover); border-color:var(--lx-primary-hover); }
.lx-list-btn-danger { background:transparent; border-color:var(--lx-danger-border); color:var(--lx-danger-fg); box-shadow:none; }
.lx-list-btn-danger:hover { background:var(--lx-danger-hover); border-color:var(--lx-danger); }
.lx-list-btn.lx-list-btn-quiet { background:transparent; border-color:transparent; }
.lx-list-btn.lx-list-btn-quiet:hover { background:var(--lx-hover-fill); }

/* ---- source rows ---- */
.lx-cards { display:flex; flex-direction:column; gap:6px; }
.lx-source-card { position:relative; display:flex; align-items:center; gap:10px; min-height:56px; padding:8px 12px;
    background:var(--lx-card-bg); border:1px solid var(--lx-border); border-radius:10px;
    transition:border-color .15s, background-color .15s; }
.lx-source-card:hover { border-color:var(--lx-border-strong); }
.lx-source-card.is-active { background:var(--lx-active-bg); border-color:var(--lx-active-border); }
.lx-source-main { flex:1 1 180px; min-width:0; display:flex; flex-direction:column; gap:2px; }
.lx-source-name-row { display:flex; align-items:center; gap:6px; min-width:0; }
.lx-source-name { min-width:0; font-size:13px; font-weight:700; color:var(--lx-text); line-height:1.3;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lx-version-pill { flex:0 0 auto; padding:0 5px; border-radius:999px; background:var(--lx-chip); color:var(--lx-text-secondary);
    font-size:9.5px; font-weight:600; line-height:1.5; }
.lx-source-desc { font-size:11px; color:var(--lx-text-secondary); line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lx-source-desc.is-error { color:var(--lx-danger-fg); }
.lx-source-switch { flex:0 0 auto; display:inline-flex; align-items:center; height:28px; padding:0; border:0; background:transparent; cursor:pointer; }
.lx-source-switch-track { position:relative; display:inline-flex; width:55px; height:28px; border-radius:999px;
    background:var(--lx-off-bg); border:1px solid var(--lx-off-border); transition:background-color .15s, border-color .15s; }
.lx-source-switch-thumb { position:absolute; top:3px; left:2px; width:19px; height:19px; border-radius:50%;
    background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.28); transition:transform .15s; z-index:2; }
.lx-source-switch.is-on .lx-source-switch-track { background:var(--lx-primary); border-color:var(--lx-primary); }
.lx-source-switch.is-on .lx-source-switch-thumb { transform:translateX(32px); }
.lx-source-switch.is-error .lx-source-switch-track { background:var(--lx-danger); border-color:var(--lx-danger); }
.lx-source-switch.is-error .lx-source-switch-thumb { transform:translateX(32px); }
.lx-source-switch:hover .lx-source-switch-track { filter:brightness(.96); }
.lx-source-switch:focus-visible { outline:2px solid var(--lx-primary); outline-offset:2px; }
.lx-source-switch:disabled { opacity:.55; cursor:default; }
.lx-source-switch-action { position:absolute; top:50%; right:8px; transform:translateY(-50%); z-index:1;
    font-size:9.5px; font-weight:700; line-height:1; white-space:nowrap; color:var(--lx-off-fg); pointer-events:none; }
.lx-source-switch.is-on .lx-source-switch-action { left:8px; right:auto; color:#fff; }

/* ---- row actions ---- */
.lx-source-actions { position:relative; flex:0 0 auto; display:flex; align-items:center; gap:6px; }
.lx-source-actions .lx-list-btn { height:28px; padding:0 10px; font-size:11px; border-radius:7px; }
.lx-drag-handle { flex:0 0 auto; display:flex; align-items:center; justify-content:center; width:22px; height:28px;
    border-radius:6px; color:var(--lx-disabled); font-size:14px; line-height:1; cursor:grab; user-select:none;
    -webkit-user-select:none; touch-action:none; }
.lx-drag-handle:hover { background:var(--lx-hover-fill); color:var(--lx-text-secondary); }
.lx-drag-handle:active { cursor:grabbing; }
.lx-source-card.is-dragging { opacity:.85; border-color:var(--lx-primary); box-shadow:0 6px 18px color-mix(in srgb, var(--lx-primary) 22%, transparent); }
.lx-source-actions .lx-list-btn-danger { background:var(--lx-danger-bg); border-color:var(--lx-danger-border); color:var(--lx-danger-fg); }
.lx-source-actions .lx-list-btn-danger:hover { background:var(--lx-danger-hover); border-color:var(--lx-danger); }
.lx-source-actions .lx-list-btn-danger[data-confirm="1"] { background:var(--lx-danger-hover); border-color:var(--lx-danger); }

/* ---- empty state + notices ---- */
.lx-list-empty { padding:20px 12px; text-align:center; color:var(--lx-disabled); font-size:11px; background:var(--lx-card-bg);
    border:1px dashed var(--lx-btn-border); border-radius:9px; }
.lx-list-notice { position:relative; display:flex; align-items:flex-start; gap:6px; padding:8px 10px;
    border-radius:8px; background:var(--lx-card-bg); border:1px solid var(--lx-border); color:var(--lx-text-secondary); font-size:10.5px; line-height:1.4; white-space:pre-wrap; }
.lx-list-notice-text { flex:1 1 auto; min-width:0; word-break:break-word; }
.lx-list-notice.is-success { background:var(--lx-success-bg); border-color:var(--lx-success-border); color:var(--lx-success-fg); }
.lx-list-notice.is-error { background:var(--lx-danger-bg); border-color:var(--lx-danger-border); color:var(--lx-danger-fg); }

/* ---- responsive ---- */
@container (max-width: 440px) {
    .lx-source-card { flex-wrap:wrap; }
    .lx-source-main { flex-basis:100%; }
    .lx-source-switch { margin-left:auto; }
    .lx-source-actions { width:auto; margin-left:0; }
}
@container (max-width: 340px) {
    .lx-import-field { flex-basis:100%; }
    .lx-import-actions { width:100%; }
    .lx-import-actions .lx-list-btn { flex:1 1 0; }
    .lx-source-actions .lx-list-btn { flex:1 1 0; }
}
`;
            return style;
        };
        // 样式表内容与主题无关（都用 CSS 变量），只建一次、反复复用，避免每次刷新重建。
        const sharedStyle = styleElement();

        const render = (entries) => {
            const byId = new Map(runtimes.map((item) => [item.id, item]));

            const root = el('div', { class: 'lx-list-panel' });
            const { day, accent, onAccent, text, muted } = resolvePanelColors(panelCtx);
            root.style.colorScheme = day ? 'light' : 'dark';
            const accentLight = onAccent === '#1c1917';
            const onPrimary = onAccent;
            const primaryInk = accentLight ? (day ? '#1c1917' : '#e4e4e7') : accent;
            const accentTint = (pct) => `color-mix(in srgb, ${accent} ${pct}%, transparent)`;
            const tokens = {
                '--lx-text': text,
                '--lx-text-secondary': muted,
                '--lx-border': day ? 'rgba(23,43,77,.1)' : 'rgba(255,255,255,.12)',
                '--lx-border-strong': day ? 'rgba(23,43,77,.18)' : 'rgba(255,255,255,.2)',
                '--lx-card-bg': day ? 'rgba(23,43,77,.035)' : 'rgba(255,255,255,.06)',
                '--lx-field': day ? 'rgba(23,43,77,.04)' : 'rgba(0,0,0,.22)',
                '--lx-field-focus': day ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.1)',
                '--lx-btn-border': day ? 'rgba(23,43,77,.12)' : 'rgba(255,255,255,.16)',
                '--lx-btn-border-strong': day ? 'rgba(23,43,77,.2)' : 'rgba(255,255,255,.28)',
                '--lx-hover-fill': day ? 'rgba(23,43,77,.05)' : 'rgba(255,255,255,.08)',
                '--lx-chip': day ? 'rgba(23,43,77,.06)' : 'rgba(255,255,255,.1)',
                '--lx-primary': accent,
                '--lx-primary-hover': `color-mix(in srgb, ${accent} 86%, #000)`,
                '--lx-primary-ink': primaryInk,
                '--lx-on-primary': onPrimary,
                '--lx-success': day ? '#16B978' : '#3DD68C',
                '--lx-disabled': day ? '#94A3B8' : 'rgba(255,255,255,.45)',
                '--lx-success-bg': day ? '#E7F8F0' : 'rgba(22,185,120,.16)',
                '--lx-success-border': day ? '#CFEFE1' : 'rgba(22,185,120,.35)',
                '--lx-success-fg': day ? '#0F9D63' : '#4ADE80',
                '--lx-off-bg': day ? '#F1F4F9' : 'rgba(255,255,255,.07)',
                '--lx-off-fg': day ? '#64748B' : '#A1A1AA',
                '--lx-off-border': day ? '#E5EAF2' : 'rgba(255,255,255,.1)',
                '--lx-danger': day ? '#F06464' : '#FF7B7B',
                '--lx-danger-fg': day ? '#D64545' : '#FF9B9B',
                '--lx-danger-bg': day ? '#FEF0F0' : 'rgba(240,100,100,.14)',
                '--lx-danger-border': day ? '#FBD5D5' : 'rgba(240,100,100,.38)',
                '--lx-danger-hover': day ? '#FFF5F5' : 'rgba(240,100,100,.2)',
                '--lx-active-bg': accentTint(10),
                '--lx-active-border': accentTint(34),
            };
            for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
            root.style.setProperty('--lx-accent', accent);
            root.append(sharedStyle);

            const importButton = button('', () => { void importFile(); }, {
                title: tr('从文件导入音源脚本', 'Import an LX source script from a file'),
            });
            importButton.className += ' lx-icon-file';
            importButton.disabled = busy;

            const urlInput = el('input', {
                class: 'lx-list-url-input',
                type: 'text',
                value: urlDraft,
                placeholder: 'https://…/source.js',
                autocomplete: 'off',
                spellcheck: 'false',
            });
            urlInput.addEventListener('input', () => { urlDraft = urlInput.value; });
            urlInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    void importUrl(urlInput.value);
                }
            });
            urlInput.disabled = busy;
            const urlButton = button(tr('导入', 'Import'), () => {
                void importUrl(urlInput.value);
            }, {
                primary: true,
                title: tr('下载并导入一个音源脚本', 'Download and import an LX source script'),
            });
            urlButton.disabled = busy;
            importButton.disabled = busy;
            const statusButton = button('', () => {
                notice = { text: buildStatus(), kind: 'info', showClear: true };
                safeRefresh(true);
            }, { title: tr('查看脚本与缓存状态', 'Show scripts and cache status') });
            statusButton.className += ' lx-icon-status';
            statusButton.disabled = busy;
            root.append(el('div', { class: 'lx-import' }, [
                el('div', { class: 'lx-import-field' }, [el('span', { class: 'lx-import-link', text: '🔗' }), urlInput]),
                el('div', { class: 'lx-import-actions' }, [urlButton, importButton, statusButton]),
            ]));

            const list = el('div', { class: 'lx-cards' });
            if (entries.length === 0) {
                list.append(el('div', {
                    class: 'lx-list-empty',
                    text: tr('还没有音源脚本。', 'No scripts imported yet.'),
                }));
            } else {
                entries.forEach((entry) => list.append(sourceCard(entry, byId.get(entry.id), entries.length)));
            }
            root.append(list);

            if (notice) {
                const kindClass = notice.kind === 'error' ? ' is-error' : notice.kind === 'success' ? ' is-success' : '';
                const noticeChildren = [el('span', { class: 'lx-list-notice-text', text: notice.text })];
                if (notice.showClear) {
                    noticeChildren.push(el('button', {
                        class: 'lx-list-notice-clear',
                        type: 'button',
                        text: tr('清除', 'Clear'),
                        title: tr('清除缓存', 'Clear cache'),
                        'aria-label': tr('清除缓存', 'Clear cache'),
                        onclick: () => {
                            clearUrlCache();
                            notice = { text: tr('缓存已清除', 'URL cache cleared'), kind: 'success' };
                            safeRefresh(true);
                        },
                    }));
                }
                root.append(el('div', {
                    class: `lx-list-notice${kindClass}`,
                }, noticeChildren));
                // 通知自动消失，不需要关闭按钮。
                if (noticeTimer !== null) { clearTimeout(noticeTimer); timers.delete(noticeTimer); }
                const timerId = setTimeout(() => {
                    timers.delete(timerId);
                    if (noticeTimer === timerId) noticeTimer = null;
                    notice = null;
                    safeRefresh(true);
                }, 30000);
                noticeTimer = timerId;
                timers.add(timerId);
                timerId?.unref?.();
            }

            currentRoot = root;
            container.replaceChildren(root);
        };

        const offSettings = access?.onChange?.(() => safeRefresh(true));
        const offTheme = panelCtx.onChange?.(() => safeRefresh(true));
        const timer = typeof panelCtx.every === 'function'
            ? panelCtx.every(4000, () => {
                if (dragging) return;
                safeRefresh();
            })
            : () => { };
        safeRefresh(true);

        return () => {
            disposedPanel = true;
            currentRoot = null;
            noticeTimer = null;
            for (const pending of timers) clearTimeout(pending);
            timers.clear();
            offSettings?.();
            offTheme?.();
            timer?.();
            container.replaceChildren();
        };
    }

    folium.registries.commands.register({
        id: 'test',
        label: { 'zh-CN': '测试解析', en: 'Test resolution' },
        description: {
            'zh-CN': '用指定音源、歌曲 ID 和音质测试解析。',
            en: 'Asks the scripts for one playback URL by source, song id and quality.',
        },
        params: [
            {
                key: 'source',
                type: 'select',
                defaultValue: 'wy',
                label: { 'zh-CN': '音源', en: 'Source' },
                options: SOURCE_OPTIONS,
            },
            {
                key: 'id',
                type: 'text',
                label: { 'zh-CN': '歌曲 ID', en: 'Song id' },
                placeholder: '留空自动使用默认的示例 ID',
            },
            {
                key: 'quality',
                type: 'select',
                defaultValue: DEFAULT_QUALITY,
                label: { 'zh-CN': '音质', en: 'Quality' },
                options: QUALITY_OPTIONS,
            },
        ],
        onValuesChange: (values, change) => {
            if (change.key !== 'source') return;
            const source = String(values.source || 'wy');
            const current = String(values.id || '').trim();
            if (!current || Object.values(DEFAULT_TEST_SONG_IDS).includes(current)) {
                const next = DEFAULT_TEST_SONG_IDS[source];
                if (next) return { id: next };
            }
        },
        run: async ({ values }) => {
            const source = String(values.source || 'wy');
            const rawId = String(values.id || '').trim();
            // 留空就用当前音源的示例 ID，不预填某个音源的 ID（否则换音源时框里会一直留着旧 ID）。
            const id = rawId || DEFAULT_TEST_SONG_IDS[source] || '';
            if (!id) throw new Error('请填写歌曲 ID');
            const quality = LX_QUALITY_OPTIONS.includes(String(values.quality)) ? String(values.quality) : DEFAULT_QUALITY;
            let url = null;
            let reason = '';
            try {
                const result = await folium.rpc.call('lx.resolve', { source, id, quality });
                url = result?.url ?? null;
            } catch (error) {
                reason = error && error.message ? String(error.message) : String(error);
            }
            if (!url) {
                folium.ui.toast(reason ? `解析失败：${source}:${id} — ${reason}` : `解析失败：${source}:${id}`, { type: 'error' });
                return null;
            }
            folium.ui.toast(url, { type: 'success', durationMs: 10000 });
            return null;
        },
    });

    pushOptions();
    // main 激活时已经 reload 过；client 启动先读状态，避免把同一批脚本再初始化一遍。
    await refreshStatus();
    if (!runtimes.length) await loadScripts();

    return () => {
        disposed = true;
        runtimes = [];
        bumpUi();
        if (hookDisposer) {
            try { hookDisposer(); } catch { /* already gone */ }
        }
        for (const dispose of disposers) {
            try { dispose(); } catch { /* already gone */ }
        }
        // main 的运行时由 index.cjs 在 reload/停用时自行释放。
    };
}
