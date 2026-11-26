// lx-music-source/index.cjs
// main 入口（Electron 主进程，Node 环境）。
//
// 为什么放在 main：
//   1. Folia 的 omni.audioSourceResolved 是异步钩子，1.5s 后放弃（src/mods/folium/events.ts）。
//      冷启动脚本常要 5–30s，所以在渲染进程里 await 必然首播失败。
//   2. 这里改用「占位地址」：client 的钩子同步把 event.url 写成
//      http://127.0.0.1:<port>/p/<base64 payload>，真正的解析在播放器取流时由本进程完成。
//   3. 主进程是普通 Node，没有 1.5s 限制，还能用 node:crypto / node:zlib 实现完整的 lx.utils
//      （AES/RSA/zlib），这是渲染进程做不到的。
//
// 职责：
//   - 从共享存储 scripts 读取用户脚本（支持 gz_ 压缩），在 node:vm 里运行；
//   - 实现 LX 桌面版的 globalThis.lx（request / utils.buffer / utils.crypto / utils.zlib）；
//   - 本地回环 HTTP 服务：/p/<payload> 占位解析 302；http 地址优先升级同主机 https 直连，
//     升级不了的才用 /a/<token> 音频 Range 中转；
//   - 通过 rpc 向 client 暴露 status / reload / resolve / prefetch / 缓存控制。
//
// 安全边界：node:vm 不是安全沙箱，脚本按“用户导入的可信代码”对待；导入前请审查。

'use strict'

const vm = require('node:vm')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const http = require('node:http')
const https = require('node:https')
const { AsyncLocalStorage } = require('node:async_hooks')
const { URL, URLSearchParams } = require('node:url')

const SCRIPT_STORAGE_KEY = 'scripts'
const RESOLVE_TIMEOUT_MS = 30_000
const INIT_TIMEOUT_MS = 3_000
const MAX_REDIRECTS = 5
const URL_TTL_MS = 10 * 60 * 1000
const TOKEN_TTL_MS = 60 * 60 * 1000
const HTTPS_UPGRADE_TTL_MS = 30 * 60 * 1000
const HTTPS_UPGRADE_FAIL_TTL_MS = 3 * 60 * 1000
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
const MAX_HTTP_BODY_BYTES = 32 * 1024 * 1024
const MAX_RESOLVE_CACHE = 200
const MAX_URL_TOKENS = 256
const MAX_HTTPS_HOSTS = 128
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

// Folia 音质名 → LX 脚本音质；QUALITY_ORDER 低 → 高（含 192k/256k 以兼容部分脚本）。
const QUALITY_MAP = { standard: '128k', high: '320k', lossless: 'flac', hires: 'flac24bit' }
const QUALITY_ORDER = ['128k', '192k', '256k', '320k', 'flac', 'flac24bit', 'hires']
const DEFAULT_QUALITY = '320k'

const EVENT_NAMES = {
    request: 'request',
    inited: 'inited',
    updateAlert: 'updateAlert',
}

const QQ_SONG_ID_MAX = 2_147_483_647

// ---------------------------------------------------------------- 基础工具

function safeText(value) {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

/** 文本/JSON 响应通常说明拿到的是错误页或接口数据，而不是音频字节。 */
function isAudioContentType(headers) {
    const contentType = String(headers?.['content-type'] || '').toLowerCase()
    return !contentType.startsWith('text/') && !contentType.startsWith('application/json')
}

function withTimeout(promise, ms, label = 'operation') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}（超过 ${ms}ms）`)), ms)
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value) },
            // Script errors are created inside the vm realm, so `instanceof Error`
            // is false here; keep anything that looks like an error object.
            (error) => { clearTimeout(timer); reject(error && typeof error.message === 'string' ? error : new Error(safeText(error))) },
        )
    })
}

function toBuffer(value, encoding) {
    if (Buffer.isBuffer(value)) return value
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    if (value instanceof ArrayBuffer) return Buffer.from(value)
    if (Array.isArray(value)) return Buffer.from(value)
    if (typeof value === 'string') return Buffer.from(value, encoding || 'utf8')
    if (value === undefined || value === null) return Buffer.alloc(0)
    return Buffer.from(String(value))
}

// 注意：client.mjs 里有一份等价实现（渲染进程与主进程各自打包），改动时两处保持一致。
function parseScriptMeta(code, fallbackName = 'script') {
    const meta = { name: '', description: '', version: '', author: '', homepage: '' }
    const header = String(code).slice(0, 8192).match(/^\s*\/\*[\s\S]*?\*\//)?.[0] ?? ''
    if (header) {
        for (const line of header.split('\n')) {
            const hit = line.match(/^\s*\*?\s*@(\w+)\s+(.+?)\s*$/)
            if (hit && hit[1] in meta) meta[hit[1]] = hit[2].replace(/\s*\*\/$/, '').trim()
        }
    }
    if (!meta.name) meta.name = fallbackName || 'script'
    return meta
}

/** 把 user_api.json 里的明文或 gz_(base64+deflate) 脚本解成源码。
 *  注意：client.mjs 里有等价的异步实现（DecompressionStream），改动时两处保持一致。 */
function decodeLxScript(raw) {
    const text = String(raw ?? '')
    if (!text.startsWith('gz_')) return text
    const payload = text.slice(3).replace(/\s+/g, '')
    const data = Buffer.from(payload, 'base64')
    try {
        return zlib.inflateSync(data).toString('utf8')
    } catch {
        return zlib.inflateRawSync(data).toString('utf8')
    }
}

function normalizePlayableUrl(value) {
    if (typeof value !== 'string') return null
    // 有些脚本会返回 "url1, url2" 形式的备用地址；跟 Folia 的播放地址处理保持一致，取第一个合法项。
    for (const part of value.split(/,\s*(?=https?:\/\/)/i)) {
        const url = part.trim()
        if (!url) continue
        if (url.startsWith('//')) return `https:${url}`
        const hit = /^(https?):\/\/(.+)$/i.exec(url)
        if (hit) return `${hit[1].toLowerCase()}://${hit[2]}`
    }
    return null
}

/** 在脚本声明的 qualitys 内，按“不高于 preferred 的最高档 → 更低 → 最低”排出一条可重试的阶梯。 */
function qualityLadder(sources, source, preferred) {
    const want = QUALITY_MAP[preferred] || preferred || DEFAULT_QUALITY
    const declared = sources?.[source]?.qualitys
    const norm = Array.isArray(declared) ? declared.filter((q) => QUALITY_ORDER.includes(q)) : []
    if (norm.length === 0) return [want]
    const wantIndex = QUALITY_ORDER.indexOf(want)
    const below = norm
        .filter((q) => QUALITY_ORDER.indexOf(q) <= (wantIndex < 0 ? QUALITY_ORDER.length : wantIndex))
        .sort((a, b) => QUALITY_ORDER.indexOf(b) - QUALITY_ORDER.indexOf(a))
    if (below.length > 0) return below
    return [norm.slice().sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))[0]]
}

/** Folia 歌曲 → LX 脚本认识的 musicInfo；字段按 LX 各音源的惯例给全，脚本自己挑用。
 *  kw/mg 只在「测试解析」命令里会用到（Folia 没有这两家内置 provider，不会走到替换流程）。 */
function buildMusicInfo(source, id, song = {}) {
    const value = String(id)
    const common = { name: song.title ?? '', singer: song.artist ?? '', albumName: song.album ?? '' }
    switch (source) {
        case 'wy':
            return { ...common, songmid: value, songId: /^\d+$/.test(value) ? Number(value) : value }
        case 'kg':
            return { ...common, hash: value, hash128: value, albumId: String(song.albumId ?? '') }
        case 'tx':
            // songmid 是脚本最常用的字段；songId 保留 Folia 原始的数字歌曲 id，避免某些脚本按数字 id 调用。
            return { ...common, songmid: value, mediaMid: value, songId: isQqSongId(song.id) ?? value }
        case 'kw':
            return { ...common, songmid: value, musicId: value }
        case 'mg':
            return { ...common, songmid: value, copyrightId: value, songId: value }
        default:
            return { ...common, songmid: value }
    }
}

// ---------------------------------------------------------------- HTTP（LX needle 语义）

function httpRequest(url, options = {}, callback) {
    const opts = options || {}
    const headers = {}
    for (const [key, value] of Object.entries(opts.headers || {})) {
        headers[key] = Array.isArray(value) ? value.join(', ') : String(value)
    }
    // 先建一张小写键表，避免对 headers 反复 Object.keys(...).some(...) 遍历。
    const headerNames = new Set(Object.keys(headers).map((key) => key.toLowerCase()))
    // LX Music runs in Chromium, so scripts expect a browser UA; a bare Node request is refused by
    // several platform endpoints (they answer "block ip" and never hand out a URL).
    if (!headerNames.has('user-agent')) {
        headers['User-Agent'] = BROWSER_UA
    }
    if (!headerNames.has('accept-encoding')) {
        headers['Accept-Encoding'] = 'gzip, deflate, br'
    }
    const method = String(opts.method || 'GET').toUpperCase()

    let target
    try {
        target = new URL(String(url))
    } catch {
        callback(new Error(`invalid url: ${url}`))
        return () => {}
    }

    let bodyBuffer
    if (opts.formData) {
        const boundary = `----lx${crypto.randomBytes(8).toString('hex')}`
        const parts = []
        for (const [key, value] of Object.entries(opts.formData)) {
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n`))
            parts.push(toBuffer(value))
            parts.push(Buffer.from('\r\n'))
        }
        parts.push(Buffer.from(`--${boundary}--\r\n`))
        bodyBuffer = Buffer.concat(parts)
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`
    } else if (opts.form) {
        const query = new URLSearchParams(opts.form).toString()
        if (method === 'GET' || method === 'HEAD') {
            const existing = target.search ? target.search.slice(1) : ''
            target.search = existing ? `${existing}&${query}` : query
        } else {
            bodyBuffer = Buffer.from(query)
            headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded'
        }
    } else if (opts.body !== undefined && opts.body !== null) {
        if (typeof opts.body === 'object' && !Buffer.isBuffer(opts.body) && !ArrayBuffer.isView(opts.body)) {
            bodyBuffer = Buffer.from(JSON.stringify(opts.body))
            headers['Content-Type'] = headers['Content-Type'] || 'application/json'
        } else {
            bodyBuffer = toBuffer(opts.body)
        }
    }
    if (bodyBuffer) headers['Content-Length'] = String(bodyBuffer.length)

    const timeout = Math.min(60_000, Math.max(1000, Number(opts.timeout) || 60_000))
    let done = false
    let activeReq = null

    const finish = (error, response, body) => {
        if (done) return
        done = true
        activeReq = null
        callback(error, response, body)
    }

    const decodeBody = (raw, responseHeaders) => {
        const encoding = String(responseHeaders['content-encoding'] || '').toLowerCase()
        if (!encoding || encoding === 'identity') return raw
        try {
            if (encoding.includes('gzip')) return zlib.gunzipSync(raw)
            if (encoding.includes('deflate')) return zlib.inflateSync(raw)
            if (encoding.includes('br')) return zlib.brotliDecompressSync(raw)
        } catch { /* 解压失败时保留原始字节，让脚本自己处理 */ }
        return raw
    }

    const dispatch = (currentUrl, currentMethod, currentBody, hops) => {
        let currentTarget
        try { currentTarget = new URL(String(currentUrl)) } catch { finish(new Error(`invalid url: ${currentUrl}`)); return }
        const reqHeaders = { ...headers }
        if (!currentBody) {
            delete reqHeaders['Content-Length']
            if (currentMethod === 'GET' || currentMethod === 'HEAD') delete reqHeaders['Content-Type']
        } else {
            reqHeaders['Content-Length'] = String(currentBody.length)
        }
        const lib = currentTarget.protocol === 'https:' ? https : http
        const req = lib.request(currentTarget, { method: currentMethod, headers: reqHeaders }, (res) => {
            if (REDIRECT_STATUS.has(res.statusCode) && res.headers.location && hops < MAX_REDIRECTS) {
                let nextUrl
                try { nextUrl = new URL(res.headers.location, currentTarget).href } catch {
                    res.resume()
                    finish(new Error('invalid redirect location'))
                    return
                }
                const keepMethod = res.statusCode === 307 || res.statusCode === 308
                res.resume()
                dispatch(nextUrl, keepMethod ? currentMethod : 'GET', keepMethod ? currentBody : undefined, hops + 1)
                return
            }
            const chunks = []
            let total = 0
            res.on('data', (chunk) => {
                total += chunk.length
                if (total > MAX_HTTP_BODY_BYTES) {
                    res.destroy(new Error(`response body exceeds ${MAX_HTTP_BODY_BYTES} bytes`))
                    return
                }
                chunks.push(chunk)
            })
            res.on('error', (error) => { if (activeReq === req) finish(error) })
            res.on('aborted', () => { if (activeReq === req) finish(new Error('response aborted')) })
            res.on('end', () => {
                if (done || activeReq !== req) return
                const raw = decodeBody(Buffer.concat(chunks), res.headers)
                const text = raw.toString('utf8')
                let body = text
                try {
                    body = JSON.parse(text)
                } catch { /* LX 也允许纯文本 */ }
                const responseHeaders = { ...res.headers, 'content-length': String(raw.length) }
                delete responseHeaders['content-encoding']
                finish(null, { statusCode: res.statusCode, statusMessage: res.statusMessage, headers: responseHeaders, body, raw }, body)
            })
        })
        activeReq = req
        req.on('error', (error) => { if (activeReq === req) finish(error) })
        req.setTimeout(timeout, () => req.destroy(new Error('request timeout')))
        if (currentBody) req.write(currentBody)
        req.end()
    }

    dispatch(target.href, method, bodyBuffer, 0)
    return () => {
        if (done) return
        done = true
        const req = activeReq
        activeReq = null
        try { req?.destroy(new Error('request aborted')) } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------- lx.utils

function createUtils() {
    const from = (value, encoding) => toBuffer(value, encoding)
    const toString = (value, format) => {
        if (typeof value === 'string') return value
        const buffer = toBuffer(value)
        const fmt = String(format || 'utf8').toLowerCase()
        if (fmt === 'hex') return buffer.toString('hex')
        if (fmt === 'base64') return buffer.toString('base64')
        if (fmt === 'latin1' || fmt === 'binary') return buffer.toString('latin1')
        return buffer.toString('utf8')
    }
    const md5 = (...parts) => {
        const hash = crypto.createHash('md5')
        if (parts.length === 0) hash.update(Buffer.alloc(0))
        for (const part of parts) hash.update(toBuffer(part))
        return hash.digest('hex')
    }
    const aes = (encrypt) => (buffer, mode = 'cbc', key, iv) => {
        let algorithmMode = String(mode || 'cbc').toLowerCase()
        const noPadding = algorithmMode.includes('nopad')
        algorithmMode = algorithmMode.replace('-nopad', '')
        const keyBuffer = toBuffer(key)
        const algorithm = `aes-${keyBuffer.length * 8}-${algorithmMode}`
        const ivBuffer = algorithmMode === 'ecb' ? null : (iv === undefined ? null : toBuffer(iv))
        const cipher = encrypt
            ? crypto.createCipheriv(algorithm, keyBuffer, ivBuffer)
            : crypto.createDecipheriv(algorithm, keyBuffer, ivBuffer)
        if (noPadding) cipher.setAutoPadding(false)
        return Buffer.concat([cipher.update(toBuffer(buffer)), cipher.final()])
    }
    const aesEncrypt = aes(true)
    const aesDecrypt = aes(false)
    return {
        buffer: { from, bufToString: toString },
        crypto: {
            md5,
            randomBytes: (size) => crypto.randomBytes(Math.max(0, Number(size) || 0)),
            aesEncrypt,
            aesDecrypt,
            aesEn: aesEncrypt,
            aesDe: aesDecrypt,
            rsaEncrypt: (buffer, key) => crypto.publicEncrypt(
                { key: toBuffer(key), padding: crypto.constants.RSA_PKCS1_PADDING },
                toBuffer(buffer),
            ),
        },
        zlib: {
            inflate: (buffer) => new Promise((resolve, reject) => {
                zlib.inflate(toBuffer(buffer), (error, out) => (error ? reject(error) : resolve(out)))
            }),
            deflate: (buffer) => new Promise((resolve, reject) => {
                zlib.deflate(toBuffer(buffer), (error, out) => (error ? reject(error) : resolve(out)))
            }),
        },
    }
}

// ---------------------------------------------------------------- vm 运行时

const DEFAULT_LOG = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * 一条脚本的运行时。脚本只看到 lx/console/计时器/Buffer/编码器，没有 process/require。
 * 注意：node:vm 不是安全边界，脚本按可信代码对待。
 */
function createLxRuntime({ log = DEFAULT_LOG, request, options, info = {}, onInited } = {}) {
    const state = { inited: false, sources: null, handler: null, disposed: false }
    const timers = new Set()
    const requestScopes = new AsyncLocalStorage()
    const activeRequests = new Set()
    let resolveInited
    const initedPromise = new Promise((resolve) => { resolveInited = resolve })
    const currentScriptInfo = Object.freeze({
        name: info.name || 'script',
        version: info.version || '',
        description: info.description || '',
        homepage: info.homepage || '',
        rawScript: info.rawScript || '',
    })

    const utils = createUtils()
    const send = (event, data) => {
        if (event === EVENT_NAMES.inited && !state.inited) {
            state.inited = true
            state.sources = data && typeof data === 'object' && data.sources && typeof data.sources === 'object'
                ? data.sources
                : null
            resolveInited(state.sources)
            try { onInited?.(state.sources) } catch { /* ignore */ }
        } else if (event === EVENT_NAMES.updateAlert) {
            // 脚本的普通通知不写宿主日志，避免启动/切源时刷屏。
        }
        return Promise.resolve()
    }
    const on = (event, callback) => {
        if (event === EVENT_NAMES.request && typeof callback === 'function') state.handler = callback
        else if (event === EVENT_NAMES.request) throw new Error('LX: request handler must be a function')
    }
    const lxRequest = (url, opts, callback) => {
        if (typeof callback !== 'function') throw new Error('LX: callback required')
        const scope = requestScopes.getStore()
        let cancel = () => {}
        let finished = false
        const cleanup = () => {
            finished = true
            scope?.delete(cancel)
            activeRequests.delete(cancel)
        }
        cancel = request(url, opts || {}, (error, response, body) => {
            if (finished) return
            cleanup()
            if (state.disposed) return
            callback(error, response, body)
        })
        if (!finished) {
            scope?.add(cancel)
            activeRequests.add(cancel)
        }
        return () => {
            if (finished) return
            cleanup()
            try { cancel() } catch { /* ignore */ }
        }
    }
    const lx = {
        EVENT_NAMES,
        env: 'desktop',
        version: '2.1.0',
        currentScriptInfo,
        utils,
        on,
        send,
        request: lxRequest,
    }

    const sandbox = {
        lx,
        console: {
            log: () => { },
            info: () => { },
            warn: (...args) => log.warn?.(...args),
            error: (...args) => log.error?.(...args),
        },
        Buffer,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
        btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
        setTimeout: (fn, ms, ...args) => {
            const id = setTimeout(() => {
                timers.delete(id)
                try { fn(...args) } catch (error) { log.error?.(error) }
            }, ms)
            timers.add(id)
            return id
        },
        setInterval: (fn, ms, ...args) => {
            const id = setInterval(() => {
                try { fn(...args) } catch (error) { log.error?.(error) }
            }, ms)
            timers.add(id)
            return id
        },
        clearTimeout: (id) => { clearTimeout(id); timers.delete(id) },
        clearInterval: (id) => { clearInterval(id); timers.delete(id) },
    }
    const context = vm.createContext(sandbox)

    const cancelScope = (scope) => {
        if (!scope) return
        for (const cancel of [...scope]) {
            try { cancel() } catch { /* ignore */ }
        }
        scope.clear()
    }
    const cancelAllRequests = () => {
        for (const cancel of [...activeRequests]) {
            try { cancel() } catch { /* ignore */ }
        }
        activeRequests.clear()
    }

    const runtime = {
        get sources() { return state.sources },
        get inited() { return state.inited },
        get active() { return !state.disposed },
        get info() { return currentScriptInfo },
        whenInited: () => initedPromise,
        run(code) {
            if (typeof code !== 'string' || !code.trim()) throw new Error('脚本文本为空')
            if (toBuffer(code).length > MAX_SCRIPT_BYTES) throw new Error('脚本超过 2 MiB')
            vm.runInContext(code, context, { filename: 'lx-source.js', timeout: 5000 })
        },
        async resolveMusicUrl(source, musicInfo, quality, timeoutOverrideMs) {
            if (state.disposed) throw new Error('LX: source stopped')
            if (typeof state.handler !== 'function') throw new Error('LX: script did not register a request handler')
            const configured = Number(timeoutOverrideMs) || Number(options?.().requestTimeoutMs) || 20_000
            const timeout = Math.min(60_000, Math.max(500, configured))
            const scope = new Set()
            try {
                const result = await requestScopes.run(scope, () => withTimeout(
                    Promise.resolve().then(() => state.handler({ source, action: 'musicUrl', info: { musicInfo, type: quality } })),
                    timeout,
                    'musicUrl',
                ))
                const raw = typeof result === 'string' ? result : result?.url
                const url = normalizePlayableUrl(raw)
                if (!url) throw new Error(`LX: script returned no playable URL for ${source}:${musicInfo?.songmid ?? musicInfo?.hash ?? ''}`)
                return url
            } finally {
                // 结果已拿到或已超时：脚本这次解析挂起的请求都不再需要，及时释放 socket。
                cancelScope(scope)
            }
        },
        cancelActiveRequests() {
            cancelAllRequests()
        },
        dispose() {
            if (state.disposed) return
            state.disposed = true
            cancelAllRequests()
            for (const id of timers) {
                try { clearTimeout(id); clearInterval(id) } catch { /* ignore */ }
            }
            timers.clear()
        },
    }
    return runtime
}

// ---------------------------------------------------------------- 本地回环服务：占位解析 + 音频 Range 中转

function createAudioProxy() {
    let server = null
    let port = 0
    let handler = null
    let logger = DEFAULT_LOG
    const tokens = new Map()
    const cache = new Map()
    // 同一主机的 https 能力只判断一次：成功就按直连处理，失败就继续走 http 探测/本地代理。
    const httpsUpgrade = new Map()

    const cacheKey = (payload) => `${payload.source}:${payload.id}:${payload.quality}`
    const sweep = () => {
        const now = Date.now()
        for (const [key, entry] of tokens) if (now - entry.at > TOKEN_TTL_MS) tokens.delete(key)
        for (const [key, entry] of cache) if (now - entry.at > URL_TTL_MS) cache.delete(key)
    }

    const get = (payload) => {
        const key = cacheKey(payload)
        const hit = cache.get(key)
        if (hit && Date.now() - hit.at < URL_TTL_MS) return hit.promise
        if (typeof handler !== 'function') return Promise.reject(new Error('LX: no resolver'))
        const promise = Promise.resolve().then(() => handler(payload))
        const entry = { at: Date.now(), promise }
        if (cache.size >= MAX_RESOLVE_CACHE) cache.delete(cache.keys().next().value)
        cache.set(key, entry)
        promise.catch(() => { if (cache.get(key) === entry) cache.delete(key) })
        return promise
    }

    const invalidate = (payload) => { cache.delete(cacheKey(payload)) }
    const clear = () => cache.clear()
    const cacheSize = () => { sweep(); return cache.size }
    const getPort = () => port

    const register = (target, headers = {}) => {
        sweep()
        const token = crypto.randomBytes(12).toString('hex')
        if (tokens.size >= MAX_URL_TOKENS) tokens.delete(tokens.keys().next().value)
        tokens.set(token, { target, headers, at: Date.now() })
        return `http://127.0.0.1:${port}/a/${token}`
    }

    const probeHttpsUpgrade = async (url) => {
        let httpsUrl
        let host
        try {
            const parsed = new URL(url)
            if (parsed.protocol !== 'http:') return null
            // URL 显式写了 :80 时，https 应该用 443，而不是照搬 80。
            if (parsed.port === '80') parsed.port = ''
            parsed.protocol = 'https:'
            httpsUrl = parsed.href
            host = parsed.host
        } catch {
            return null
        }
        const cached = httpsUpgrade.get(host)
        if (cached && cached.expiresAt > Date.now()) {
            return cached.ok ? httpsUrl : null
        }
        const probed = await probeFinalUrl(httpsUrl, 6_000)
        const audioLike = isAudioContentType(probed.headers)
        const ok = Boolean(
            probed.url
            && probed.url.startsWith('https://')
            && probed.statusCode >= 200
            && probed.statusCode < 300
            && audioLike,
        )
        if (httpsUpgrade.size >= MAX_HTTPS_HOSTS) {
            httpsUpgrade.delete(httpsUpgrade.keys().next().value)
        }
        httpsUpgrade.set(host, {
            ok,
            expiresAt: Date.now() + (ok ? HTTPS_UPGRADE_TTL_MS : HTTPS_UPGRADE_FAIL_TTL_MS),
        })
        return ok ? probed.url : null
    }

    const finalize = async (raw, alreadyNormalized = false) => {
        const url = alreadyNormalized ? raw : normalizePlayableUrl(raw)
        if (!url) throw new Error('脚本未返回播放地址')
        if (url.startsWith('https://')) return url
        // 先试同主机的 https：多数 CDN 同时支持，换协议就能直连，播放器自己处理 Range/缓冲。
        const upgraded = await probeHttpsUpgrade(url)
        if (upgraded) return upgraded
        // https 不行再跟重定向；终点仍为 http 才落到本地代理。
        const probed = await probeFinalUrl(url)
        const audioLike = isAudioContentType(probed.headers)
        if (probed.url && probed.url.startsWith('https://') && probed.statusCode >= 200 && probed.statusCode < 300 && audioLike) {
            return probed.url
        }
        const target = audioLike ? (probed.url || url) : url
        if (!port) return target
        return register(target)
    }

    const handlePlaceholder = async (requestUrl, res) => {
        let payload
        try {
            payload = JSON.parse(Buffer.from(requestUrl.pathname.slice(3), 'base64url').toString('utf8'))
        } catch {
            res.writeHead(400); res.end('bad payload'); return
        }
        if (!payload || typeof payload !== 'object' || !payload.source || !payload.id) {
            res.writeHead(400); res.end('bad payload'); return
        }
        try {
            const out = await get(payload)
            res.writeHead(302, { Location: out.url, 'Cache-Control': 'no-store' }); res.end()
        } catch {
            // 脚本解析失败时回退到内置音源地址（payload.fallback），避免把本来能播的免费歌弄坏。
            if (payload.fallback) {
                try {
                    const fallback = await finalize(payload.fallback)
                    res.writeHead(302, { Location: fallback, 'Cache-Control': 'no-store' }); res.end(); return
                } catch { /* fall through */ }
            }
            res.writeHead(502, { 'Cache-Control': 'no-store' }); res.end('resolve failed')
        }
    }

    const handleStream = (req, res, token) => {
        const entry = tokens.get(token)
        if (!entry) { res.writeHead(404); res.end('unknown token'); return }
        const headers = { ...entry.headers }
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) {
            headers['User-Agent'] = BROWSER_UA
        }
        if (req.headers.range) headers.Range = req.headers.range
        if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range']
        let activeUpstream = null
        let headTimer = null
        const clearHeadTimer = () => {
            if (headTimer) { clearTimeout(headTimer); headTimer = null }
        }
        const fail = (error) => {
            clearHeadTimer()
            logger.warn?.('[LX] 音频上游错误', error)
            if (!res.headersSent) {
                try { res.writeHead(502); res.end() } catch { /* ignore */ }
            } else if (!res.writableEnded) {
                // 已经发了响应头时再 writeHead 只会抛错，必须销毁响应，否则播放器一直等不到结束。
                res.destroy(error)
            }
        }
        const attempt = (rawTarget, hops) => {
            let target
            try { target = new URL(rawTarget) } catch { fail(new Error('LX: bad audio target')); return }
            const lib = target.protocol === 'https:' ? https : http
            const upstream = lib.request(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers }, (up) => {
                clearHeadTimer()
                if (REDIRECT_STATUS.has(up.statusCode) && up.headers.location && hops < MAX_REDIRECTS) {
                    up.resume()
                    try {
                        const next = new URL(up.headers.location, target).href
                        attempt(next, hops + 1)
                    } catch {
                        fail(new Error('LX: bad redirect location'))
                    }
                    return
                }
                up.on('error', (error) => { if (!res.writableEnded) res.destroy(error) })
                up.on('aborted', () => { if (!res.writableEnded) res.destroy(new Error('LX: upstream aborted')) })
                const out = { 'Content-Type': up.headers['content-type'] || 'application/octet-stream' }
                for (const name of [
                    'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag',
                    'cache-control', 'expires', 'content-disposition', 'location',
                ]) {
                    if (up.headers[name]) out[name] = up.headers[name]
                }
                res.writeHead(up.statusCode || 200, out)
                up.pipe(res)
            })
            activeUpstream = upstream
            const timer = setTimeout(() => upstream.destroy(new Error('LX: upstream headers timeout')), 15_000)
            headTimer = timer
            upstream.on('close', () => { if (headTimer === timer) clearHeadTimer() })
            upstream.on('error', (error) => { if (activeUpstream === upstream) fail(error) })
            upstream.end()
        }
        res.on('close', () => {
            clearHeadTimer()
            try { activeUpstream?.destroy() } catch { /* ignore */ }
        })
        attempt(entry.target, 0)
    }

    const handle = (req, res) => {
        let pathname
        try { pathname = new URL(req.url, 'http://127.0.0.1').pathname } catch { res.writeHead(400); res.end(); return }
        if (pathname.startsWith('/p/')) return void handlePlaceholder({ pathname }, res)
        if (pathname.startsWith('/a/')) return handleStream(req, res, pathname.slice(3))
        res.writeHead(404); res.end('not found')
    }

    const start = (log = DEFAULT_LOG) => new Promise((resolve, reject) => {
        logger = log
        if (server) { resolve(); return }
        server = http.createServer((req, res) => {
            try { handle(req, res) } catch (error) { log.error?.('[LX] 代理错误', error); try { res.writeHead(500); res.end() } catch { /* ignore */ } }
        })
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            port = server.address().port
            resolve()
        })
    })

    const close = () => {
        if (!server) return
        try { server.close() } catch { /* ignore */ }
        try { server.closeAllConnections?.() } catch { /* ignore */ }
        try { server.closeIdleConnections?.() } catch { /* ignore */ }
        server = null
        port = 0
        tokens.clear()
        cache.clear()
        httpsUpgrade.clear()
    }

    return { start, close, register, finalize, get, invalidate, clear, cacheSize, getPort, setHandler: (fn) => { handler = fn } }
}

const audioProxy = createAudioProxy()

function probeFinalUrl(url, timeoutMs = 12_000) {
    return new Promise((resolve) => {
        let current = String(url)
        let hops = 0
        const go = () => {
            let target
            try { target = new URL(current) } catch { resolve({ url: current, statusCode: 0, headers: {} }); return }
            const lib = target.protocol === 'https:' ? https : http
            const req = lib.request(target, { method: 'GET', headers: { Range: 'bytes=0-0', 'User-Agent': BROWSER_UA } }, (res) => {
                // 只要响应头：不能 res.resume()，否则服务器不认 Range 时会把整首几十 MB 全下载一遍。
                res.on('error', () => { /* 主动 destroy 后可能触发，忽略 */ })
                if (REDIRECT_STATUS.has(res.statusCode) && res.headers.location && hops < MAX_REDIRECTS) {
                    hops += 1
                    try { current = new URL(res.headers.location, current).href } catch { /* ignore */ }
                    res.destroy()
                    go()
                    return
                }
                res.destroy()
                resolve({ url: current, statusCode: res.statusCode, headers: res.headers })
            })
            req.on('error', () => resolve({ url: current, statusCode: 0, headers: {} }))
            const wait = Math.min(60_000, Math.max(1000, Number(timeoutMs) || 12_000))
            req.setTimeout(wait, () => { req.destroy(); resolve({ url: current, statusCode: 0, headers: {} }) })
            req.end()
        }
        go()
    })
}

// ---------------------------------------------------------------- 歌曲 id 翻译（tx: 数字 songid → songmid）
// 不再自己请求 QQ 的 get_song_detail_yqq：client 用 describeSong().pageUrl 取到 songmid 后随 payload 传进来（hintMid）。
function isQqSongId(value) {
    const text = String(value ?? '').trim()
    if (!/^[1-9]\d*$/.test(text)) return null
    const numeric = Number(text)
    return numeric <= QQ_SONG_ID_MAX ? numeric : null
}

async function resolveSongId(source, id, log = DEFAULT_LOG, hintMid = null) {
    if (source !== 'tx') return id
    const hint = typeof hintMid === 'string' ? hintMid.trim() : ''
    if (/^[0-9A-Za-z]{8,32}$/.test(hint)) return hint
    // 已经是 songmid（非数字）就直接用；是数字 songid 又没拿到 hint 就无法转换。
    if (isQqSongId(id) === null) return String(id).trim() || null
    log.warn?.('[LX] 缺少 QQ songmid（describeSong 未取到 pageUrl），本次跳过替换', { id: String(id) })
    return null
}

// ---------------------------------------------------------------- 解析编排

async function resolveNow(runtimes, payload, options = {}, log = DEFAULT_LOG) {
    const source = String(payload.source || '')
    const id = String(payload.id ?? payload.song?.id ?? '')
    if (!source || !id) throw new Error('缺少音源或歌曲 id')
    const song = payload.song || { id }
    const preferred = QUALITY_MAP[payload.quality] || (QUALITY_ORDER.includes(payload.quality) ? payload.quality : (options.quality || DEFAULT_QUALITY))
    const candidates = runtimes.filter((item) => {
        if (item.enabled === false || !item.runtime) return false
        const sources = item.runtime.sources
        return !sources || Boolean(sources[source])
    })
    if (candidates.length === 0) {
        const hasEnabledRuntime = runtimes.some((item) => item.enabled !== false && item.runtime)
        throw new Error(hasEnabledRuntime ? `没有脚本支持：${source}` : '没有已启用的脚本')
    }
    const budgetMs = Math.min(120_000, Math.max(3_000, Number(options.resolveTimeoutMs) || RESOLVE_TIMEOUT_MS))
    const deadline = Date.now() + budgetMs
    const remaining = () => deadline - Date.now()
    const requestTimeout = Math.max(500, Number(options.requestTimeoutMs) || 20_000)
    const targetId = await resolveSongId(source, id, log, payload.mid)
    if (targetId === null) throw new Error(`缺少 QQ songmid：${source}:${id}（describeSong 没取到 pageUrl，跳过替换）`)
    let lastError
    for (const item of candidates) {
        const sources = item.runtime.sources
        const musicInfo = buildMusicInfo(source, targetId, song)
        for (const quality of qualityLadder(sources, source, preferred)) {
            if (remaining() <= 0) {
                lastError = lastError || new Error(`解析超时（${budgetMs}ms）`)
                break
            }
            try {
                const raw = await item.runtime.resolveMusicUrl(
                    source,
                    musicInfo,
                    quality,
                    Math.min(requestTimeout, Math.max(500, remaining())),
                )
                const url = await withTimeout(audioProxy.finalize(raw, true), Math.max(1_000, remaining()), 'finalize')
                return { url, quality, script: item.name }
            } catch (error) {
                lastError = error
            }
        }
    }
    throw lastError || new Error(`解析失败：${source}:${id}`)
}

// ---------------------------------------------------------------- main 入口

module.exports = async function activate(api) {
    const log = api.log || DEFAULT_LOG
    let options = { quality: DEFAULT_QUALITY, requestTimeoutMs: 20_000 }
    let runtimes = []

    const notifyChanged = () => {
        try {
            if (typeof api.rpc?.send === 'function') api.rpc.send('lx.statusChanged', { at: Date.now() })
        } catch { /* 旧宿主没有 rpc.send，忽略 */ }
    }

    const statusOf = () => ({
        loaded: runtimes.some((item) => item.enabled !== false && item.runtime),
        proxyPort: audioProxy.getPort(),
        cacheCount: audioProxy.cacheSize(),
        options: { ...options },
        scripts: runtimes.map((item) => ({
            id: item.id,
            name: item.name,
            meta: item.meta,
            enabled: item.enabled !== false,
            error: item.error || null,
            runtime: item.runtime ? { sources: item.runtime.sources } : null,
        })),
    })

    const isEntry = (value) => Boolean(value) && typeof value === 'object' && typeof value.id === 'string' && value.id && typeof value.code === 'string'

    let reloadPromise = null
    const doReload = async () => {
        let entries = []
        try { entries = await api.storage.get(SCRIPT_STORAGE_KEY) } catch (error) { log.warn?.('[LX] 读取脚本失败', error) }
        const list = Array.isArray(entries) ? entries.filter(isEntry) : []
        // 同一个模组实例里，代码没变的脚本复用旧运行时：避免每次导入/切换都重置脚本内部状态。
        const reusable = new Map()
        for (const old of runtimes) {
            if (old.runtime && old.codeHash) reusable.set(`${old.id}:${old.codeHash}`, old)
        }
        const loadEntry = async (entry) => {
            const enabled = entry.enabled !== false
            const view = {
                id: entry.id,
                name: entry.name || 'script',
                meta: { version: entry.version || '', description: entry.description || '' },
                enabled,
                error: null,
                runtime: null,
                codeHash: null,
            }
            if (!enabled) return view
            let runtime = null
            try {
                const code = decodeLxScript(entry.code)
                const codeHash = crypto.createHash('sha1').update(code).digest('hex')
                view.codeHash = codeHash
                const previous = reusable.get(`${entry.id}:${codeHash}`)
                if (previous?.runtime?.active) {
                    view.name = previous.name
                    view.meta = previous.meta
                    view.runtime = previous.runtime
                    return view
                }
                const meta = parseScriptMeta(code, entry.name || 'script')
                view.name = meta.name || entry.name || 'script'
                view.meta = { version: meta.version || entry.version || '', description: meta.description || entry.description || '' }
                runtime = createLxRuntime({
                    log,
                    request: httpRequest,
                    options: () => options,
                    info: { ...meta, rawScript: code },
                    onInited: notifyChanged,
                })
                runtime.run(code)
                await withTimeout(runtime.whenInited(), INIT_TIMEOUT_MS).catch(() => {})
                view.runtime = runtime
            } catch (error) {
                // 初始化失败的 runtime 也可能已经挂了定时器/请求，不能随着 view 一起丢掉。
                try { runtime?.dispose() } catch { /* ignore */ }
                view.error = String(error?.message || error)
                view.runtime = null
            }
            return view
        }
        // 并行初始化：每个脚本最多等 INIT_TIMEOUT_MS，串行会让启动时间乘以脚本数量。
        const next = await Promise.all(list.map(loadEntry))
        // 停用/删除/替换的旧运行时释放掉。
        for (const old of runtimes) {
            const kept = next.some((item) => item.id === old.id && item.runtime === old.runtime)
            if (!kept) {
                try { old.runtime?.dispose() } catch { /* ignore */ }
            }
        }
        runtimes = next
        notifyChanged()
        return statusOf()
    }

    // main 激活和 client 首次加载都会请求 reload：同一时间只跑一份，避免重复初始化脚本。
    const reload = () => {
        if (reloadPromise) return reloadPromise
        reloadPromise = doReload().finally(() => { reloadPromise = null })
        return reloadPromise
    }

    audioProxy.setHandler((payload) => resolveNow(runtimes, payload, options, log))

    api.rpc.handle('lx.status', () => statusOf())
    api.rpc.handle('lx.reload', () => reload())
    api.rpc.handle('lx.setOptions', (next) => {
        const previous = options
        options = { ...options, ...(next || {}) }
        if (previous.quality !== options.quality) audioProxy.clear()
        return statusOf()
    })
    api.rpc.handle('lx.resolve', (payload) => resolveNow(runtimes, payload || {}, options, log))
    api.rpc.handle('lx.prefetch', async (payload) => {
        if (!payload || !payload.source || !payload.id) return false
        try { await audioProxy.get(payload) } catch { /* 预热失败不影响播放 */ }
        return true
    })
    api.rpc.handle('lx.invalidate', (payload) => { if (payload) audioProxy.invalidate(payload); return true })
    api.rpc.handle('lx.clearCache', () => { audioProxy.clear(); return true })

    // Start the loopback proxy before the first client status read so proxyPort is set.
    await audioProxy.start(log)
    await reload()

    return () => {
        audioProxy.close()
        for (const item of runtimes) {
            try { item.runtime?.dispose() } catch { /* ignore */ }
        }
        runtimes = []
    }
}

module.exports.__internals = {
    EVENT_NAMES,
    QUALITY_MAP,
    QUALITY_ORDER,
    DEFAULT_QUALITY,
    parseScriptMeta,
    decodeLxScript,
    normalizePlayableUrl,
    qualityLadder,
    buildMusicInfo,
    httpRequest,
    createUtils,
    createLxRuntime,
    isQqSongId,
    resolveSongId,
    resolveNow,
    probeFinalUrl,
    audioProxy,
    RESOLVE_TIMEOUT_MS,
}
