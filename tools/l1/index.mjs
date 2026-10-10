/**
 * L1 工具统一注册入口
 * ============================================================
 * index.mjs（插件入口）在 W3 之后调用本模块注册 L1 工具。
 */

import { registerL1Tools } from './rmxprt-solve.mjs'

/** L1 工具名列表（从 rmxprt-solve.mjs 导出） */
export const L1_TOOL_NAMES = [
  'motor_l1_estimate',
  'motor_l1_pipeline',
  'motor_rmxprt_solve',
]

/**
 * 注册 L1 工具集
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @returns {Promise<string[]>}
 */
export async function registerL1Placeholders(ctx, config = {}, options = {}) {
  const { guideOnly = false } = options
  
  if (guideOnly) {
    // 仅记录跳过，不注册
    console.log('[dsh-motor-ai L1] guideOnly 模式，跳过工具注册')
    return []
  }
  
  return await registerL1Tools(ctx, config)
}

export { L1_TOOL_NAMES }
export default { registerL1Placeholders, L1_TOOL_NAMES }
