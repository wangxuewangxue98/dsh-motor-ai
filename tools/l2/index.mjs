/**
 * L2 工具统一注册入口
 * ============================================================
 * index.mjs（插件入口）在 W3 之后调用本模块注册 L2 工具。
 */

import { registerL2Tools } from './motorcad-verify.mjs'

/** L2 工具名列表（从 motorcad-verify.mjs 导出） */
export const L2_TOOL_NAMES = [
  'motor_l2_validate',
  'motor_motorcad_verify',
]

/**
 * 注册 L2 工具集
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @returns {Promise<string[]>}
 */
export async function registerL2Placeholders(ctx, config = {}, options = {}) {
  const { guideOnly = false } = options
  
  if (guideOnly) {
    // 仅记录跳过，不注册
    console.log('[dsh-motor-ai L2] guideOnly 模式，跳过工具注册')
    return []
  }
  
  return await registerL2Tools(ctx, config)
}

export { L2_TOOL_NAMES }
export default { registerL2Placeholders, L2_TOOL_NAMES }
