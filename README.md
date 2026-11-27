# Folium LX Music Source Adapter

洛雪音乐（[LX Music](https://github.com/lyswhut/lx-music-desktop)）自定义音源脚本在 **Folia** 上的适配层，按 **Folium 2.0+**（Folia 0.8.0 起，`folium: 2`）的公开契约编写，以 Folium 模组形式运行。

The adapter layer that runs LX Music custom source scripts inside [Folia](https://github.com/chthollyphile/folia-major), written against the Folium 2.0+ contract.

## 它做什么

Folia 的内置音源（网易云 / 酷狗 / QQ）拿不到播放地址时，或者你选择「总是替换」时，适配层让 LX 音源脚本解析一个可播放直链，再交回 Folia 播放。

```text
Folia 播放 → Omni.getAudioSource → 内置 provider（netease / kugou / qq）
                                      ↓
                    omni.hooks.audioSourceResolved   ← client 钩子（同步、不 await）
                                      ↓  event.url = http://127.0.0.1:<port>/p/<payload>
                    播放器取流 → 本地回环服务  /p/<payload>
                                      ↓
               main 进程 LX 运行时（node:vm + 完整 node:crypto / node:zlib）
               ├─ lx.on(request)       脚本的 musicUrl 处理器
               ├─ lx.request(...)      → Node http/https（主进程，无 CORS，无 1.5s 限制）
               └─ lx.utils             buffer / md5 / AES / RSA / zlib
                                      ↓ 302 重定向
              真实直链：http 地址先升级同主机 https 直连；
              升级不了的才走 /a 本地 Range 中转 → 交回 Folia 播放
```

- 脚本在 **main 入口**（`index.cjs`）里运行；client 的钩子只**同步**把 `event.url` 改成占位地址 `http://127.0.0.1:<port>/p/<base64url>`。真正的解析在播放器取流时进行，所以**不再受 1.5 秒异步钩子预算限制**。
- **http 地址优先升级 https 直连**：同一主机的 `https://` 能返回 200/206 就直接 302 过去，播放器原生处理 Range/缓冲，不走本地字节中转；只有 CDN 不支持 https 时才落到 `/a` 代理。判断结果按主机缓存 30 分钟。
- 脚本初始化有 5 秒同步执行超时；`lx.request` 支持 gzip/deflate/br 解压、3xx 跟随和 32 MB 响应体上限。
- 多个脚本并行初始化；`lx.reload` 时未改动的脚本复用原运行时，不重置脚本内部状态。
- 解析有 30 秒总预算，超时会取消该次解析挂起的 `lx.request`；`playback.songChanged` 时还会顺带预热队列里的下 1–2 首。
- 占位 payload 里带 **`fallback`**（内置音源原本的地址）。脚本解析失败时本地服务 302 回内置地址，**免费/内置可播的歌曲不会被脚本打断**。
- 模拟的是 LX 桌面版脚本 API（`EVENT_NAMES`、`on` / `send`、回调式 `request`、`utils.buffer` / `utils.crypto` 全套 / `utils.zlib`），并把 Folia 歌曲映射到 LX 音源 id。
- 支持的 Folia 音源：`netease → wy`、`kugou → kg`、`qq → tx`。Folia 没有酷我/咪咕 provider，所以 `kw` / `mg` 目前只在「测试解析」命令里可用。
- 歌曲在 `playback.songChanged` 和 `playback.beforePlay` 时**预热**，main 侧缓存 10 分钟；同一歌曲并发解析会自动合并。

## 安装（仅桌面版）

1. 打开 **设置 → 实验室 → 模块系统** 并启用。
2. 把本项目的 [`lx-music-source/`](lx-music-source/) 整个文件夹放进 Folia 的用户模组目录（模组面板会显示准确路径，通常是 `%APPDATA%/Folia/mods/`），或者把文件夹压成 zip 后拖进模组面板。
3. 重载模组。它会显示为 **洛雪音源适配**（LX Music Source Adapter）。
4. 导入音源脚本（脚本将以 main 进程权限运行，请只导入可信来源）：
   - 在模组面板 **「音源脚本」** 卡片最上方的导入行点「文件导入」，选一个 `.js` 文件；或
   - 在卡片上方的导入行 URL 输入框填脚本地址，点「导入」；或
   - 直接导入 lx-music-desktop 的 `%APPDATA%/lx-music-desktop/LxDatas/user_api.json` 里 `gz_` 开头的文本（保存成 `.txt` 或 `.js` 再选文件即可）。
5. 在同一列表里启用/停用或删除脚本；导入行右侧的「🔍」可确认脚本声明的音源与音质。

脚本从哪里来？和你在 LX Music 里用的来源一样（脚本作者自己的发布渠道）。本项目**不附带、不分发任何第三方音源脚本，也不内置任何脚本地址**；脚本由你自己提供并导入，运行在 `main` 入口（`node:vm`，不是沙箱），请只导入可信来源。本模组依赖实验接口 `omni.hooks` 的 `audioSourceResolved`（`experimental: ["omni.hooks"]`），宿主需提供该接口；缺失时模组可加载但无法替换播放地址。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 替换策略 | 仅兜底 | `不替换`：不改播放地址；`仅兜底`：内置源无地址时才用脚本（会员试听有地址，不会被替换）；`总是替换`：优先用脚本，试听/会员片段也替换。 |
| 替换平台 | 全部关闭 | `[网易云]` / `[QQ 音乐]` / `[酷狗]` 三个开关按钮：**点亮=该平台走洛雪替换，熄灭=用内置原版**。 |
| 目标音质 | 320k | `128k` / `320k` / `flac` / `flac24bit`。脚本声明了 `qualitys` 时，会选「不高于目标音质的最好一档」；没声明就按目标音质请求。 |
| 请求超时 | 20000 ms | 单次脚本请求超时，3–60 秒；冷启动慢可调到 30–60 秒。 |

「洛雪音源适配」整张卡是自定义面板（样式对齐宿主原生表单），从上到下：**替换策略**（下拉） → **替换平台** `[网易云] [QQ 音乐] [酷狗]`（**默认全部熄灭**，由用户自己点亮；点亮=走洛雪替换，熄灭=用内置原版） → **目标音质**（下拉） → **请求超时**（滑杆）。替换平台是唯一用自定义按钮的地方（宿主内置控件没有多选/按钮组）。

### 音源脚本

模组面板里还有一个 **「音源脚本」** 卡片，就在命令卡片上方：

```text
（标题/描述由 Folia 卡片自己显示：音源脚本）
[🔗 https://…/source.js] [导入] [📁] [🔍]
┌──────────────────────────────────────────────────────┐
│ 1  野草 v1.0.0                       [开关] [删除] [⠿] │
└──────────────────────────────────────────────────────┘
```

- 列表上方的 URL 输入框回车或点「导入」即可下载；「📁」打开原生文件选择框。脚本由你自行提供并导入，运行在 main 进程（`node:vm`），请只导入可信来源。
- 每个脚本一行；右侧是启用开关、删除（点两次确认）和 ⠿ 拖拽把手。
- 每行只显示脚本名与简介，不再显示音源/音质详情（已去掉「详情」开关）。
- 按住每行右侧的 ⠿ 把手上下拖动即可排序：同一音源有多个脚本时，列表越靠上越先被解析（谁先返回可用地址就用谁）；调整后会清空已解析缓存，让新顺序立即生效。
- 停用的脚本不加载、不参与解析；加载失败的脚本会留在列表里，方便删除或重新导入。
- 「📁」从文件导入；「🔍」在通知里显示脚本/缓存状态（自动消失），状态通知右上角的「🗑️」清空缓存（悬停有提示）。

## 命令

| 命令 | 说明 |
| --- | --- |
| 测试解析 | 指定音源、歌曲 ID、音质，跳过缓存请求一次；结果用会自动消失的 toast 显示。歌曲 ID 留空时使用该音源示例 ID。 |

## 音质映射

LX 的规范音质阶梯（低 → 高）：

```text
128k < 192k < 256k < 320k < flac < flac24bit < hires
```

Folia 自己的音质名（如果调用方有）映射为：

| Folia | LX |
| --- | --- |
| `standard` | `128k` |
| `high` | `320k` |
| `lossless` | `flac` |
| `hires` | `flac24bit` |

选择规则：

1. 脚本没声明该音源的 `qualitys` → 直接用目标音质。
2. 声明了且包含目标音质 → 用目标音质。
3. 否则取「不高于目标音质的最好一档」。
4. 若声明的最低档已经高于目标音质 → 用最低档。

## 运行时能力

`lx` 沙箱提供：

| 成员 | 说明 |
| --- | --- |
| `EVENT_NAMES` | `{ request, inited, updateAlert }` |
| `on('request', handler)` | 捕获脚本的 `musicUrl` 处理器。 |
| `send('inited', { status, sources })` | 记录脚本声明的音源与音质。 |
| `request(url, options, callback)` | 回调 `(err, { statusCode, headers, body, raw }, body)`；JSON 响应体自动解析；用 Node `http/https`，支持 `form` / `formData`；返回取消函数。 |
| `utils.buffer.from(value, encoding)` | 支持 `utf-8` / `hex` / `base64` / `latin1`，以及 `Uint8Array` / `ArrayBuffer` / 数组。 |
| `utils.buffer.bufToString(bytes, format)` | 支持 `hex` / `base64` / `latin1` / `utf-8`。 |
| `utils.crypto.md5(...parts)` | 十六进制摘要；多段拼接。 |
| `utils.crypto.randomBytes(n)` | Node `Buffer`。 |
| `utils.crypto.aesEn/aesDe`（`aesEncrypt/aesDecrypt`） | `node:crypto` AES，支持 ecb/cbc 与 `-nopad`。 |
| `utils.crypto.rsaEncrypt` | `node:crypto` RSA PKCS#1 v1.5。 |
| `utils.zlib.inflate/deflate` | 返回 Promise<Buffer>，基于 `node:zlib`。 |
| `env` / `version` / `currentScriptInfo` | `'desktop'` / `'2.1.0'` / 脚本头信息。 |

脚本里开的 `setTimeout` / `setInterval` 由运行时登记，模组重载或停用时统一清除，避免旧脚本继续轮询。

## 开发与测试

```bash
# 运行时单测 + client 入口的宿主模拟测试（Node 20+，无依赖）
npm test

# 用真实脚本探测一次（会走系统网络）
node test/probe.mjs ./my-source.js wy 186016 320k

# 用 folia-major 的检查器校验清单、权限、实验接口、事件名
npm run check
```

`npm test` 逐个直接运行测试文件，而不是 `node --test` 的默认多进程模式；两者都可用，`npm run test:runner` 是后者的入口。

`npm run check` 需要 `folia-major` 与本项目同级（当前工作区就是这种布局）。它只读文件、不运行模组；输出 `no problem found` 即清单与静态接口检查通过。

`types/folium.d.ts` 是从 `folia-major/mods/folium.d.ts` 复制的编辑器提示文件（不参与运行）。宿主契约升级后，重新从 `folia-major` 跑 `npm run folium:types` 并复制过来。

## 目录结构

```text
lx-music-source/       可直接放进 Folia 模组目录的模组
  mod.json             清单（folium 2、main + client、net.fetch、filesystem.data、omni.hooks）
  index.cjs            main 入口：node:vm 运行时、完整 utils、占位/音频代理、rpc、多脚本加载
  client.mjs           Folium 2.0+ 入口：设置、命令、同步占位钩子、预热、源列表面板
docs/PROTOCOL.md       本适配层模拟的 LX 自定义音源协议
test/runtime.test.mjs  main 运行时（vm / utils / 解析）单测
test/main.test.mjs     main 入口端到端（状态 / 解析 / 占位 / fallback）
test/proxy.test.mjs    占位 302、https 升级、fallback、/a Range 中转、缓存合并单测
test/client.test.mjs   client 入口的宿主模拟测试（rpc 打桩）
test/probe.mjs         命令行探测脚本
test/fixtures/         测试用明文音源脚本
types/folium.d.ts      Folium 2.1 类型提示（仅供编辑器）
```

## 限制与注意

- **仅桌面版。** Folium 模组是 Electron 功能，网页版/PWA 没有模组系统。
- **脚本是可信代码。** main 入口用 `node:vm` 运行脚本，只暴露 `lx` / `console` / 计时器 / `Buffer` / 编码器，但它**不是安全边界**（主进程权限）。导入前先审查脚本。
- **`kw` / `mg` 只能手动验证。** Folia 只有三个内置音源，`kw` / `mg` 没有对应 provider，只能在「测试解析」命令里试。
- **直链有时效。** 缓存 10 分钟；过期后自动重新解析。http 地址优先升级为同主机 https 直连；只有升级不了的 CDN 才经 `/a` 本地中转。
- **代理只监听回环。** 本地服务绑定 `127.0.0.1` 的随机端口，仅供播放器本机取流，不对外网开放。
- **不附带第三方脚本。** 本项目不提供、不推荐任何具体音源；请遵守脚本作者与平台的使用条款。

## License

MIT — 见 [LICENSE](LICENSE)。
