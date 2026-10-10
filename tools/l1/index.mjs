/**
 * L1 工具占位注册器
 * ============================================================
 * 当前版本（1.0.0-alpha）L1 功能尚未实现，所有工具注册为占位符。
 * 用户调用时会收到明确的引导错误。
 * 
 * 实现计划：
 *   - motor_l1_estimate: RMxprt 磁路法快速估算
 *   - motor_l1_pipeline: RMxprt 批量求解 + TopN 筛选
 *   - motor_rmxprt_solve: 单次 RMxprt 求解（精细几何）
 */

import { normalizeLevel, isLevelEnabled } from '@yourscope/dsh-motor-ai-core'

/** L1 工具名列表 */
export const L1_TOOL_NAMES = [
  'motor_l1_estimate',
  'motor_l1_pipeline',
  'motor_rmxprt_solve',
]

/**
 * L1 占位工具的描述模板
 */
const PLACEHOLDER_DESCRIPTION = (toolName, config) => {
  const level = normalizeLevel(config?.level)
  
  if (!isLevelEnabled(config, 'l1')) {
    return `[L1 未启用] ${toolName} 需要配置 l1Enabled: true。\n` +
           `当前插件层级: ${level}，L1 功能暂不可用。`
  }
  
  return `[L1 占位] ${toolName} 功能正在开发中。\n` +
         `完整版 dsh-motor-ai v1.0.0-alpha 包含 L0 公式通道，\n` +
         `L1 RMxprt 求解器即将上线，请关注更新。`
}

/**
 * L1 占位工具的执行函数（始终抛错）
 */
const PLACEHOLDER_EXECUTE = (toolName, config) => {
  return async () => {
    throw new Error(
      `[${toolName}] 功能尚未实现。\n` +
      `完整版 dsh-motor-ai L1 RMxprt 求解器开发中，敬请期待。\n` +
      `当前可用功能: L0 公式估算 (motor_l0_estimate)`
    )
  }
}

/**
 * 注册 L1 占位工具
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 插件配置
 * @param {object} options
 * @param {boolean} options.guideOnly - 仅注册引导错误（不注册工具）
 * @returns {Promise<string[]>} 已注册/跳过的工具名
 */
export async function registerL1Placeholders(ctx, config = {}, options = {}) {
  const { guideOnly = false } = options
  const registered = []
  
  for (const toolName of L1_TOOL_NAMES) {
    if (guideOnly) {
      // 仅记录跳过，不注册
      continue
    }
    
    try {
      // 注册占位工具
      if (ctx.tools && ctx.tools.register) {
        ctx.tools.register({
          name: toolName,
          description: PLACEHOLDER_DESCRIPTION(toolName, config),
          parameters: {
            type: 'object',
            properties: {
              spec: { type: 'object', description: '电机规格参数' },
              geo: { type: 'object', description: '几何参数' },
            },
          },
          execute: PLACEHOLDER_EXECUTE(toolName, config),
        })
        registered.push(toolName)
        console.log(`[dsh-motor-ai] L1 占位注册: ${toolName}`)
      }
    } catch (err) {
      console.warn(`[dsh-motor-ai] L1 占位注册失败: ${toolName}`, err.message)
    }
  }
  
  return registered
}

export default { registerL1Placeholders, L1_TOOL_NAMES }
