# 本适配层模拟的 LX Music 自定义音源协议

本文记录 [`lx-music-source/index.cjs`](../lx-music-source/index.cjs)（main 进程）实现的脚本 API，来源是 lx-music-desktop 的公开脚本接口、真实音源脚本（混淆与明文两类）以及本项目运行时的实际行为。

## 脚本执行环境

脚本作为普通（非模块）脚本在 `node:vm` 的 context 里执行。作用域里：

- 全局对象就是沙箱，`globalThis.lx` 是下面的 `lx` 对象；
- 同时提供裸的 `lx` 参数，兼容 `lx.on(...)` 写法；
- `console` 被换成转发到模组日志的 shim；
- `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` 被换成会登记定时器的版本，模组卸载时统一清除；
- 另外提供 `Buffer`、`TextEncoder` / `TextDecoder`、`URL` / `URLSearchParams`、`atob` / `btoa`；没有 `process` / `require`。
- `node:vm` 不是安全边界，脚本按可信代码对待。

标准入口：

```js
const { EVENT_NAMES, request, on, send, utils, env, version } = globalThis.lx
```

## `lx` 对象

| 成员 | 形状 |
| --- | --- |
| `EVENT_NAMES` | `{ request: 'request', inited: 'inited', updateAlert: 'updateAlert' }` |
| `on(event, handler)` | 只捕获 `request` 事件；`handler({ source, action, info: { musicInfo, type } })` |
| `send(event, data)` | `inited` 的 `{ status, sources }` 被记录；`updateAlert` 记日志 |
| `request(url, options, callback)` | 回调 `(err, resp, body)`；`resp = { statusCode, statusMessage, headers, body, raw }`，`raw` 是 Buffer，`body` 自动尝试 JSON 解析；返回取消函数 |
| `env` | `'desktop'` |
| `version` | `'2.1.0'` |
| `currentScriptInfo` | `{ name, version, description, homepage, rawScript }` |

`request` 的 `options`：

| 字段 | 说明 |
| --- | --- |
| `method` | 默认 `GET`；用 Node `http` / `https` 发出。 |
| `headers` | 键值都会转成字符串。 |
| `body` | 字符串 / `Buffer` / TypedArray 原样；普通对象 `JSON.stringify` 并补 `Content-Type: application/json`。 |
| `form` | 对象，编码成 `application/x-www-form-urlencoded`；GET 时拼到 query。 |
| `formData` | 对象，编码成 `multipart/form-data`。 |
| `timeout` | 夹到 1–60 秒；不填时用 60 秒。 |

`resp.body` 先按文本取回，再尝试 `JSON.parse`；解析失败时保持字符串。响应不自动跟随重定向（与 LX 一致）。

`action: 'musicUrl'` 的处理器必须返回可播放 URL 字符串，或 `{ url }`。运行时只接受 `http(s)`（协议相对地址会补成 `https:`），其它值按失败处理。

## `utils`

### `utils.buffer.from(value, encoding?)`

| 输入 | 行为 |
| --- | --- |
| 字符串 + `hex` | 忽略空白，按字节解析；奇数长度或非十六进制字符会报错。 |
| 字符串 + `base64` | 忽略空白，按 base64 解码。 |
| 字符串 + `utf-8` / `utf8` / 其它 | UTF-8 编码。 |
| `Uint8Array` | 原样返回。 |
| `ArrayBuffer` / TypedArray | 取字节视图。 |
| 数组 | `Uint8Array.from`。 |

### `utils.buffer.bufToString(bytes, format)`

`hex` / `base64` / `latin1` / `utf-8`（默认）。字符串输入原样返回。

### `utils.crypto`

| 成员 | 说明 |
| --- | --- |
| `md5(...parts)` | 十六进制摘要；多段先按字节拼接。 |
| `randomBytes(n)` | Node `Buffer`（`Uint8Array` 子类）。 |
| `aesEncrypt` / `aesDecrypt`（别名 `aesEn` / `aesDe`） | `node:crypto` 的 AES，支持 `ecb` / `cbc` 与 `-nopad`。 |
| `rsaEncrypt(buffer, key)` | `node:crypto` 的 RSA PKCS#1 v1.5。 |

### `utils.zlib`

| 成员 | 说明 |
| --- | --- |
| `inflate(buffer)` | 返回 Promise<Buffer>。 |
| `deflate(buffer)` | 返回 Promise<Buffer>。 |

## 脚本持久化格式

lx-music-desktop 把导入的脚本存在 `%APPDATA%/lx-music-desktop/LxDatas/user_api.json`：

```json
{ "userApis": [ { "id": "user_api_226_…", "name": "野草🌾", "version": "1.0.0",
                  "script": "gz_eJyNGNuO28b1…" } ] }
```

`script` 可以是明文源码，也可以是 **`gz_` + base64(deflate)**（zlib 封装）。main 入口的 `decodeLxScript()` 用 `node:zlib` 先试 `inflate`（zlib），再试 `inflateRaw`；client 导入预览用 `DecompressionStream('deflate' | 'deflate-raw')`。

本项目把导入的原文（可能是 `gz_`）存在 `folium.storage` 的 `scripts` 键里，加载时再解包。`folium.storage` 整个数据文件上限 1 MB，写入前按 900 KB 预检并给出明确错误。

## 脚本头信息

从源码前 8 KB 读取：

```text
@name        显示名；没有时用文件名
@version     版本
@description 描述
@homepage    主页
```

## Folia 歌曲 → LX 音源 / id 字段

| Folia `song.source` | LX source | `musicInfo` 字段 |
| --- | --- | --- |
| `netease` | `wy` | `songmid` |
| `kugou` | `kg` | `hash`（FileHash） |
| `qq` | `tx` | `songmid` |
| —（无 Folia provider） | `kw` | `songmid` |
| —（无 Folia provider） | `mg` | `copyrightId` |

运行时按音源给全字段并附歌曲名/歌手/专辑：`wy` → `songmid`+`songId`，`kg` → `hash`+`hash128`，`tx` → `songmid`+`mediaMid`+`songId`，`kw` → `songmid`+`musicId`，`mg` → `songmid`+`copyrightId`+`songId`；另带 `name` / `singer` / `albumName`。脚本读它需要的那个字段即可。

## 音质

规范阶梯（低 → 高）：

```text
128k < 192k < 256k < 320k < flac < flac24bit < hires
```

Folia 音质名映射：

| Folia | LX |
| --- | --- |
| `standard` | `128k` |
| `high` | `320k` |
| `lossless` | `flac` |
| `hires` | `flac24bit` |

`pickLxQuality(sources, source, preferred)`：

1. 脚本没声明 `qualitys` → `preferred`。
2. 声明包含 `preferred` → `preferred`。
3. 否则取不高于 `preferred` 的最高声明档。
4. 若最低声明档都高于 `preferred` → 最低声明档。

## 真实脚本的常见形状（参考）

两个混淆脚本（“野草/野花”，2026-10 提取）大致是：

```text
GET {base}/v1/url/{source}/{id}/{quality}
headers: User-Agent lx-music/{env}, ver {version}, source-ver {scriptVersion},
         tag = hex(JSON.stringify(path.match(/(?:\d\w)+/g), null, 1))
success: body.code === 0 → body.data（URL 字符串）
base:    http://grass.tempmusics.tk/v1  /  http://flower.tempmusics.tk/v1
```

一个明文脚本（“Huibq”，v1.2.0）大致是：

```text
GET https://lxmusicapi.onrender.com/url/{source}/{songId|hash}/{quality}
headers: Content-Type application/json,
         User-Agent lx-music-{env}/{version},
         X-Request-Key share-v3
success: body.code === 0 → body.url
errors:  1 封 IP · 2 失败 · 4 内部 · 5 限流 · 6 参数
```

这些服务是否存活与本项目无关；协议形状只用于说明运行时为什么这样实现。
