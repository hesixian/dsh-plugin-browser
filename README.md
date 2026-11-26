# @hesixian/dsh-plugin-browser

DSH 的原生「操作浏览器」插件：**进程内 Playwright + 常驻浏览器 + 只回 diff**。
没有子进程、没有 JSON-RPC、没有 MCP server。

> In-process Playwright browser tools for DeepSeek Harness. One resident browser per
> host process, a compact ref-indexed page digest instead of a full accessibility
> tree, and diff-only replies. Eight tools, zero runtime dependencies.

## 为什么

把浏览器交给 MCP server 是现在的主流做法，代价是三份固定的开销：在每轮对话里为每个工具付 schema 税、为每次 `snapshot` 付一整棵树、为每次导航付一整页回包。

本插件把这三份开销都换成更小的东西：

| 代价 | Playwright MCP | 本插件 |
|---|---|---|
| 工具数量与描述 | 约 25 个工具的长 schema | **8 个工具**，短描述、短参数 |
| 进程模型 | 独立进程 + stdio + JSON-RPC 往返 | 进程内 `import()`，浏览器**只启动一次** |
| 每次观察页面 | 完整无障碍树 | **ref 索引的紧凑摘要**，硬上限 3500 字符 |
| 每次操作后 | 再回一整页 | **只回 diff**；没有变化就回 `no visible change` |

首次观察一个页面时，摘要的体积和一棵无障碍树其实差不多——这一点 `npm run bench` 会如实测出来。差距出现在**后续每一轮**：交互十次就是十个 diff，而不是十棵树。实测见[基准](#基准)。

## 八个工具

| 工具 | 作用 | 回包 |
|---|---|---|
| `browser_navigate` | 打开 URL | HTTP 状态 + diff（首次为全量摘要） |
| `browser_snapshot` | 当前页完整紧凑摘要（含 ref） | 摘要 |
| `browser_act` | `click/dblclick/hover/fill/type/select/check/uncheck/press/scroll/back/forward` | 动作后 diff |
| `browser_eval` | 在页面里执行 JS 表达式，回 JSON | 结果（截断） |
| `browser_wait` | 等文本出现/消失，或固定延时 | diff |
| `browser_screenshot` | 存 PNG 到磁盘 | **文件路径**（配合 `read_image` 看，不塞 base64） |
| `browser_tab` | list / new / select / close | 列表或 diff |
| `browser_console` | console 消息、页面异常、失败请求 | 文本 |

摘要长这样，`[e1]` 就是给 `browser_act` 用的 ref：

```
page: 测试仪表盘 — https://example.com/
h1 测试仪表盘
· 第一段可见文本。
[e1] link "文档" -> /docs
[e2] button "添加一行"
[e3] input "关键词"
[e4] select "北京" = 北京
```

ref 在**同一个页面内按元素身份稳定**（内部用 `WeakMap`，不是每次重排），所以 diff 不会因为重新编号而抖动——这也意味着同一个按钮连续点十次都不需要重新 `browser_snapshot`。

## 安装

### 环境要求

- Node.js >= 20.6
- 一个 Chromium 系浏览器：Chrome、Edge，或 `npx playwright install chromium`
- DSH（`npm i -g @deepseek-ai/dsh`）

### 方式一：从 npm 安装（推荐）

```bash
dsh plugin --profile web add @hesixian/dsh-plugin-browser
```

装完**重启**该 profile 的宿主进程（例如 `dsh web`），八个工具下一次启动时可用。

本插件是**零运行时依赖**，安装过程不解析任何 registry 包。Playwright 库按以下顺序查找，命中即止：

1. `DSH_BROWSER_PLAYWRIGHT` 环境变量指向的文件或目录；
2. 插件自己的 `node_modules`；
3. `<DSH_HOME>/mcp/playwright`（如果你装过 Playwright MCP，那份直接可用）；
4. 本机的全局 npm 目录（`%APPDATA%\npm`、`/usr/local/lib/node_modules`、Homebrew、nvm 前缀等）；
5. 裸包名 `playwright-core` / `playwright`。

都不存在时，任意一次工具调用会报出完整的尝试列表。装一份即可：

```bash
npm i -g playwright-core
```

### 方式二：从源码链接（开发者）

```bash
git clone https://github.com/hesixian/dsh-plugin-browser.git
dsh plugin --profile web add ./dsh-plugin-browser
```

### 方式三：完全离线

这台机器不能连 github.com 时，`dsh plugin add` 会因为 profile 里别的 `github:` 依赖而失败。此时用自带安装器（**需从源码检出**，npm 包里不含 `tools/`），它不经过 pnpm：

```bash
node tools/offline-install.mjs --profile web
```

它做的是同一件事（写依赖、建目录软链、把包追加进 `dsh.profile.bundles`、补 `pnpm-lock.yaml` 的 importer 条目），并在写入宿主 profile 之前**先用 profile 自己的解析路径把插件真挂载一次**验证八个工具注册成功——验证不通过就完全不碰宿主 profile。修改前会把 `package.json` 和 `pnpm-lock.yaml` 备份成 `*.bak-<时间>-dsh-browser`。

可选参数：`--package <dir>`、`--no-verify`。

### 停用 Playwright MCP（可选，装完建议做）

两者同时开着会白付 MCP 那 25 个工具的税。在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: mcp-playwright
  disabled: true
```

想回退就把这两行删掉，重启即可。

## 配置

覆盖 profile 的 `cordis.patch.yml` 里 `dsh-browser` 这一行的 `config`，全部可选：

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `visibility` | `'hidden'` | 浏览器在哪跑，也就是抢不抢你的焦点。见下一节 |
| `headless` | `'auto'` | 显式 `true` / `false` 会覆盖 `visibility`；`'auto'` 跟随 `visibility` 策略 |
| `activateOnSelect` | `false` | `browser_tab` 选中标签页时是否把窗口提到前台 |
| `channel` | `'auto'` | `'auto'` 依次探测 msedge / chrome / chromium，最后回退到 bundled；`'bundled'` 跳过探测；写具体名字则只用它 |
| `ignoreHTTPSErrors` | `false` | 是否接受任意 TLS 证书。默认校验，因为这个工具面对的是真实站点 |
| `acceptDownloads` | `true` | 允许页面触发下载，落在持久 profile 目录 |
| `userDataDir` | `''` | 浏览器持久 profile；空表示 `<DSH_HOME>/browser/profile` |
| `screenshotDir` | `''` | 截图目录；空表示 `<DSH_HOME>/browser/shots` |
| `viewport` | `1440 × 900` | 视口尺寸 |
| `navTimeoutMs` | `30000` | 导航超时 |
| `actionTimeoutMs` | `15000` | 单个动作超时 |
| `settleMs` | `400` | 动作后等页面静下来的时间，再取摘要 |
| `maxDigestChars` | `3500` | 摘要预算，回包大小的总闸 |
| `maxElements` | `120` | 单次摘要列出的可交互元素上限 |
| `maxTextLines` | `24` | 摘要里保留的可见文本行数 |
| `consoleLimit` | `200` | console 环形缓冲大小 |

```yaml
- id: dsh-browser
  config:
    channel: chrome
    visibility: offscreen
```

## 焦点：别抢我的鼠标和输入法

agent 在后台干活时，最烦的是浏览器窗口突然跳到最前面，键盘输入和输入法跟着被抢走。`visibility` 就是为此存在的，三档的差别不是猜的，是本机实测的：

| 模式 | 是否创建窗口 | 是否抢前台焦点 | 适用场景 |
|---|---|---|---|
| `hidden`（默认） | 不创建 | **不抢** | agent 后台跑任务；日常使用 |
| `offscreen` | 创建，停在屏幕外（实测 -26214,-26214） | **仍会抢一次** | 要真实窗口的渲染效果，又不想被挡视线 |
| `visible` | 创建，正常显示 | 抢 | 需要盯着看，或要人工登录 |

实测时前台窗口从用户的 Edge（pid 17640）变成 agent 的浏览器（pid 36528），所以**只有 `hidden` 能保证不打断你**。`offscreen` 只是视觉上不挡人，焦点仍会被抢；`--start-minimized` 这类参数 Edge 直接忽略，不要指望。

登录一次再切回后台，这是推荐做法：

```yaml
# 临时：把浏览器显示出来，手动登录站点
- id: dsh-browser
  config:
    visibility: visible

# 登录完改回（或删掉这段），登录态留在持久 profile 里
- id: dsh-browser
  config:
    visibility: hidden
```

`hidden` 模式下浏览器不占屏幕、不进任务栏、不触发输入法切换，`browser_screenshot` 照常出图。

浏览器启动时会在宿主日志里留下一行实际使用的组合，便于确认探测结果：

```
dsh-plugin-browser: launched channel chrome (headed)
```

另一个环境变量：`DSH_BROWSER_CHANNEL`，仅在 `channel` 为 `'auto'` 时生效，适合 CI 里钉死 `bundled`。

## 设计要点

- **零运行时依赖**：工具定义是裸 `ToolDefinition` 对象 + 手写 raw JSON Schema，不需要 `pnpm add @deepseek-ai/dsh-tools`，安装不碰 registry、启动不解析额外包。代价是参数校验要自己做，`lib/index.mjs` 的 `validateArgs` 干这件事（`defineTool` 会把校验包进它自己的 `execute`，裸定义没有这层）。
- **schema 与 `defineTool` 逐字节一致**：`test/verify-tools.mjs` 用 DSH 自带的 `parameterSchemaSpecToJsonSchema` 编译等价 spec，断言两边 `deepEqual`。这是"绕过 `defineTool`"这个取巧行为的契约测试。
- **懒启动**：`apply()` 只注册工具；浏览器在第一次真正调用工具时才启动。
- **常驻与回收**：`ctx.effect` 在插件卸载时关掉浏览器；进程活着时始终复用同一个 persistent context。
- **探测式启动**：先试本机已装的 Chrome / Edge，再退到 bundled Chromium，全部失败时把每一次尝试的失败原因一次性报出来，而不是只报最后一层。
- **默认无窗口**：`visibility` 默认 `hidden`，agent 在后台跑任务时不会弹窗、不抢前台、不打断输入法。要看得见就显式切到 `offscreen` 或 `visible`。
- **有头失败可降级**：无头机器上探测失灵时，有头启动失败会自动再试一次无头，而不是直接报错。
- **对话框自动 dismiss**，否则 `browser_act` 会因为原生弹窗卡死。
- **ref 过期**给出可读错误（提示重新 `browser_snapshot`），而不是抛 Playwright 内部错误。
- **diff 用 LCS**：深长页面里的一处改动回一对 `+`/`-`，而不是把它之后的所有行整体位移。

## 测试

四个脚本，全部离线（除 `smoke` 需要本机有浏览器）：

| 命令 | 校验什么 | 额外要求 |
|---|---|---|
| `npm run verify` | 8 个 schema 与官方 `defineTool` 编译结果逐字节比对；`apply()` 恰好注册 8 个工具并交出 disposer | 能解析到 `@deepseek-ai/dsh-tools` |
| `npm run portability` | 全局 npm 根跨平台解析、`DSH_HOME` 解析、`visibility` 三档策略、无头判定、启动计划 | 无 |
| `npm run installer` | 离线安装器在临时 profile 上写入依赖、bundle、lockfile，并验证作用域包名加引号与幂等 | 无 |
| `npm run registry` | 挂载**真的** ToolRuntime，用加载器同样的 `{ name, inject, apply }` 形态挂载，跑通 navigate / eval / 非法参数 / 未知工具 | 能解析到 `@deepseek-ai/dsh-tools` 与 cordis |
| `npm run smoke` | 离线 fixture 上跑通导航、diff、点击、输入、选择、截图、标签页、console、wait、ref 过期 | 一个可用浏览器 |

```bash
npm test          # 依次跑前四个
```

`smoke` 与 `registry` 都用 `headless: true` 和临时 profile 目录，不会碰你真实的浏览器 profile。

`test/portability.mjs` 专门守两个只在非 Windows 机器上才暴露的历史 bug：`join(env.APPDATA ?? '', 'npm')` 在 macOS / Linux 上会产生相对路径 `npm`，以及写死的 `channel: 'msedge'` 会让没有 Edge 的机器第一次调用就失败。

## 基准

```bash
npm run bench          # 人读的表格
npm run bench -- --json # 机器可读
```

（`bench/` 同样只在源码检出里，npm 包不含。）

在本机（win32 / Node 25）跑出来的结果：

| 场景 | innerText | 无障碍树 ariaSnapshot | 本插件摘要 | 改动后的 diff 回包 |
|---|---|---|---|---|
| 表单（5 个可交互元素） | 60 tok | 158 tok | 171 tok | 63 tok |
| 台账（60 行表格） | 971 tok | 4533 tok | 1251 tok | — |
| 文章（24 节正文） | 1344 tok | 1547 tok | 769 tok | — |

连续 10 轮交互的累计成本：

- 表单（每轮点击都新增一行）：每轮回发完整摘要 1580 tok vs 只回 diff 680 tok —— **1/2.3**
- 台账（每轮点击都不改变页面）：每轮回发完整摘要 45330 tok vs 只回 diff 640 tok —— **1/70.8**

结论要按这个顺序读：**单页首次观察时摘要并不占优**，表格页甚至比 `ariaSnapshot` 更小有限；真正的差别在轮数上——diff 的成本与页面大小无关，快照的成本与页面大小成正比。

token 数为估算值（CJK 字符按 1 计，其余按 4 字符 1 计），只用于同机同场景的相对比较。脚本不联网、不依赖 MCP，你可以自己跑一遍。

## 安全与隐私

- **`browser_eval` 能执行任意页面 JS**，等于把页面当脚本环境。只在你自己打开的页面上用它；它和"这个工具能读页面"是同一件事的两种说法。
- **持久 profile 会存 cookie 和登录态**，默认落在 `<DSH_HOME>/browser/profile`。把它当密码等同等级的目录对待，不要随仓库提交、不要发给别人。
- **TLS 默认校验**。`ignoreHTTPSErrors: true` 只建议对自签名的内网环境打开。
- **截图可以写到任意绝对路径**（`browser_screenshot` 的 `name` 参数），这是给工作流留的口子，也意味着模型可以覆盖你磁盘上的同名 PNG。
- 本插件不联网、不采集、不上报；唯一的网络流量来自你自己打开的页面。

## 已知限制

- 一个进程一个浏览器（常驻），没有多浏览器 / 多 profile 并行。
- 摘要只描述**可交互元素 + 可见文本 + 标题**，不是完整无障碍树；深层结构用 `browser_eval` 取。
- 工具定义绕过了 `defineTool`，所以类型推断（`InferArgs`）和 `presentCall` 这类编译期/展示期便利没有；这是零依赖换来的。
- 不支持网络拦截、trace 录制、CDP 直连这些 MCP 版本有的能力。需要时请用 `browser_eval` 或另装 MCP。
- diff 只给增删行，不含上下文行；判断"改在哪"靠摘要本身的可读性。

## 与相关工作的区别

| 方案 | 形态 | 与本插件的差别 |
|---|---|---|
| Playwright MCP | 独立进程 + JSON-RPC | 工具更多、能力更全（网络拦截、trace）；每个会话多一层进程，观察页面返回整棵树 |
| npm 包 `dsh-browser`（另一位作者） | 同样是 DSH 插件 | 12 个工具、按 CSS selector 定位、默认无头；本插件用 ref 索引 + diff 回包，可在无窗口 / 离屏 / 可见三档之间切换。两者设计取向不同，可以并存比较 |

命名说明：`dsh-browser` 这个名字在 npm 上已被他人占用，因此本包使用 `@hesixian` 作用域。

## 贡献

欢迎 Issue 和 PR，先读 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全问题请走 [SECURITY.md](./SECURITY.md)，不要开公开 issue。

## 许可证

[MIT](./LICENSE)