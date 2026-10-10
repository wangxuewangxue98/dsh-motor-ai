/**
 * L1 工具统一注册入口
 * ============================================================
 * index.mjs（插件入口）在 W3 之后调用本模块注册 L1 工具。
 */

import { registerL1Tools } from './rmxprt-solve.mjs'

/** L1 工具名列表（从 rmxprt-solve.mjs 导入） */
export const L1_TOOL_NAMES = [
  'motor_l1_estimate',
  'motor_l1_pipeline',
  'motor_rmxprt_solve',
]

/**
 * 注册 L1 工具集。
 * 设计原则：L1 工具**始终注册**（工具恒存在），授权检查推迟到调用时
 * （rmxprt-solve.mjs 的 checkActivation）→ 未激活返回 LICENSE_REQUIRED 引导，
 * 绝不因未授权而拒绝加载插件或隐藏工具。L0 永远可用。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @returns {Promise<string[]>}
 */
export async function registerL1Placeholders(ctx, config = {}) {
  return await registerL1Tools(ctx, config)
}

export default { registerL1Placeholders, L1_TOOL_NAMES }
