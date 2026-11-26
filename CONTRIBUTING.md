# 贡献指南

感谢你愿意花时间。这个项目刻意保持小：`lib/` 两个文件、零运行时依赖。请把新代码也限制在这个体量里。

## 开发环境

```bash
git clone https://github.com/hesixian/dsh-plugin-browser.git
cd dsh-plugin-browser
npm i -g @deepseek-ai/dsh        # 只有 verify / registry 两个测试需要
npm i -g playwright-core         # 只有 smoke 与 bench 需要
npx playwright install chromium  # 如果本机没有 Chrome / Edge
```

本插件没有 `dependencies`。请不要提交会引入运行时依赖的改动——「安装不碰 registry」是这个项目的核心约束之一。如果确实需要依赖，先在 Issue 里讨论。

## 跑测试

```bash
npm run verify       # schema 与官方 defineTool 逐字节比对
npm run portability  # 跨平台启动策略，无外部依赖
npm run registry     # 挂载真的 ToolRuntime
npm run smoke        # 离线 fixture 上驱动真实浏览器
npm test             # 以上四个
npm run bench        # token 成本实测（数字会变，别把旧数字写进断言）
```

`portability` 不联网、不需要浏览器，改启动相关代码时必跑。`smoke` 与 `registry` 都用临时 profile 和 `headless: true`，不会碰到你日常用的浏览器数据。

## 代码约定

- Node >= 20.6，纯 ESM，`.mjs`。
- 每个导出函数都有 JSDoc，带 `@param` / `@returns`。已有的注释解释的是「为什么」而不是「是什么」，请保持这个习惯。
- 错误信息要能直接指导下一步：写明试过什么、缺什么、可以改哪个配置。参考 `lib/session.mjs` 里启动失败时那条聚合错误。
- 只读的辅助函数要能被单测直接调用（`launchPlans`、`npmGlobalRoots`、`diffLines` 都是这么来的）。不要为了可测性引入 mock 框架，Node 内置 `node:assert` 够了。
- 中文文档按中英文之间加空格、中文用全角标点来写。

## 提交

- 一个提交做一件事。修 bug 和重构分开。
- 提交信息用中文，第一行不超过 50 字，说清楚「改了什么」和「为什么」。
- 改动 `lib/session.mjs` 的启动路径时，在提交信息里说明在哪些平台验证过（Windows / macOS / Linux）。
- 不要提交 `*.bak-*` 备份文件、临时 profile、截图产物。

## Pull Request

PR 描述里请包含：

1. 要解决的问题（如果能复现，给出最小复现步骤）。
2. 改动会影响的平台（本项目的 bug 大多只在非 Windows 上暴露）。
3. 跑过哪些命令，输出贴关键几行即可。

涉及行为的改动请同时更新 `README.md` 与 `CHANGELOG.md`，后者按倒序追加在顶部。

## 安全问题

不要开公开 issue，见 [SECURITY.md](./SECURITY.md)。