# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 0.1.0 — 2026-10-22

首个公开版本。相对内部使用的 1.0.0，这一版的主要工作是去掉对本机环境的假设。

### 新增

- `visibility` 配置项（`hidden` / `offscreen` / `visible`）：决定浏览器在哪运行，以及会不会抢走前台焦点。默认 `hidden`，即不创建窗口——这是唯一不会抢鼠标、键盘和输入法的模式。
- `activateOnSelect` 配置项（默认 `false`）：`browser_tab` 选中标签页时不再无条件 `bringToFront()`，除非显式要求。
- `test/portability.mjs`：跨平台启动策略与模块解析的回归测试。
- `bench/tokens.mjs`：可复现的 token 成本实测（摘要 vs 无障碍树 vs diff 轮次）。
- `lib/dsh-paths.mjs`：DSH 包定位逻辑上移到 `lib/`，测试与安装器共用。
- `LICENSE`、`CONTRIBUTING.md`、`SECURITY.md`、GitHub Actions CI。

### 变更

- **包名**从 `dsh-browser` 改为 `@hesixian/dsh-plugin-browser`——`dsh-browser` 在 npm 上已被他人占用。
- **默认不再弹窗**：`visibility` 默认 `hidden`。此前的默认是「有显示器就带头」，会在 agent 每次工作时抢走前台焦点。三档模式的取舍经本机实测：`hidden` 不创建窗口且前台 pid 不变；`offscreen` 窗口停在 -26214,-26214 但前台 pid 仍被夺走；`--start-minimized` 被 Edge 忽略，不可依赖。
- `channel` 默认值从 `'msedge'` 改为 `'auto'`：依次探测 msedge / chrome / chromium，最后回退到 bundled Chromium。
- `headless` 默认值改为 `'auto'`，并退居为 `visibility` 的覆盖项：显式 `true` / `false` 才优先。
- `ignoreHTTPSErrors` 默认值从 `true` 改为 `false`。
- 新增 `acceptDownloads` 配置项（默认 `true`）。
- 浏览器启动失败时，报出**每一次**尝试的失败原因，而不是最后一层。
- 有头启动失败会自动再试一次无头。
- 新增 `DSH_BROWSER_CHANNEL` 环境变量，在 `channel` 为 `'auto'` 时生效。
- 离线安装器 `tools/link-profile.mjs` 重写为 `tools/offline-install.mjs`：不再依赖 `dsh-safe-plugin` 的私有 API，不再改写端口与 Cloudflare 隧道，验证方式改为「在 profile 的解析路径下真挂载一次并断言 8 个工具注册」。验证失败会自动回滚。

### 修复

- **测试适配 DSH 0.2.x 的新派发契约**：`dsh-tools` 不再自己执行工具，`ctx.tools.execute` 在缺少 provider 时会抛 `ToolExecutorUnavailableError`；入参也从单次调用变成 `{ calls, signal }` 批量、返回值变成 `{ results }`。`test/registry.mjs` 现按真实部署的方式挂载 `@deepseek-ai/dsh-tool-executor-native`，而不是用 stub 绕过。

- **非 Windows 平台上的模块解析回退成相对路径**：`join(env.APPDATA ?? '', 'npm')` 在 macOS / Linux 上得到相对路径 `npm`，会去当前工作目录旁边的 `node_modules` 里找 Playwright。现已改为按平台展开全局 npm 根，并拒绝任何相对路径。
- **没有 Edge 的机器首次调用直接失败**：写死的 `channel: 'msedge'` 让 macOS / Linux 用户装完就报错。现在逐级回退，全部失败时给出可读的聚合错误。
- 全局安装的 DSH 依赖嵌套在 `@deepseek-ai/dsh/node_modules` 下时无法解析，测试与安装器都会失败。
- 安装器在 `pnpm-lock.yaml` 无 importer 块时会写坏文件。
- **安装器写入的 lockfile 条目缺少引号**：`@scope/name` 以 `@` 开头，是 YAML 的保留字符，不带引号的键会让整个 lockfile 解析失败。这个 bug 在第一次真实安装（作用域包名）时才暴露，现已在写入时按 pnpm 的写法加单引号，并补了 `test/installer.mjs` 回归测试。
- 安装器在写入阶段抛错时不再留下半改的 profile，而是从备份回滚。