# @deepseek-ai/dsh-tools 本地冒烟桩

`package.json` 以 `file:./dev-stubs/dsh-tools` 引入本目录（devDependencies）。

- 用途：让 `scripts/verify.mjs` 在无 DSH 宿主的机器上完成插件加载冒烟
  （`await import('@deepseek-ai/dsh-tools')` 解析到本桩的 `defineTool` 透传）。
- 不发布：`files` 白名单不含 `dev-stubs/`，npm pack 不会带入。
- 运行时无关：用户机器上该包由 DSH 宿主提供。

详见 `index.mjs` 头部注释（为何不用真实注册表版本）。
