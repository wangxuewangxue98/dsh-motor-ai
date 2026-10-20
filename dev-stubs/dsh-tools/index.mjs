// 本地冒烟测试 stub：仅模拟宿主 defineTool 透传。不发布、不进 tarball
// （package.json 的 files 是白名单，不含 dev-stubs/）。
//
// 为什么用桩而不是真实包：
//   真实 @deepseek-ai/dsh-tools 在 npmjs 上只有 0.2.x prerelease
//   （dist-tags: latest=next=0.2.1-rc.2），且带 11 个 @deepseek-ai peer
//   （cordis/dsh-agent/dsh-llm/dsh-sandbox/dsh-session/... 全部 0.2.1-rc.2）——
//   本地门禁只需要 defineTool 把工具定义透传给 ctx.tools.register；
//   scripts/verify.mjs 的门禁 D/E/F 已自带与 dsh-tools register() 及 cordis
//   _execute 同形态的校验器（output 声明 / inject / effect 契约逐工具实测），
//   无需引入整棵宿主框架。
//
// 运行时（用户机器）上，@deepseek-ai/dsh-tools 由 DSH 宿主提供，
// 插件源码里的 `await import('@deepseek-ai/dsh-tools')` 解析到宿主包，
// 与本桩无关。
export function defineTool(def) { return def }
export default { defineTool }
