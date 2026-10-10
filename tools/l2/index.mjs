/**
 * L2 工具统一注册入口
 * ============================================================
 * index.mjs（插件入口）在 W3 之后调用本模块注册 L2 工具。
 */

import { registerL2Tools } from './motorcad-verify.mjs'

/** L2 工具名列表（从 motorcad-verify.mjs 导入） */
export const L2_TOOL_NAMES = [
  'motor_l2_validate',
  'motor_motorcad_verify',
]

/**
 * 注册 L2 工具集。
 * 设计原则：L2 工具**始终注册**（工具恒存在），授权检查推迟到调用时
 * （motorcad-verify.mjs 的 checkL2Activation）→ 未激活返回 LICENSE_REQUIRED 引导，
 * 绝不因未授权而拒绝加载插件或隐藏工具。L0 永远可用。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @returns {Promise<string[]>}
 */
export async function registerL2Placeholders(ctx, config = {}) {
  return await registerL2Tools(ctx, config)
}

export default { registerL2Placeholders, L2_TOOL_NAMES }
