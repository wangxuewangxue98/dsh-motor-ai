/**
 * dsh-motor-ai 完整版插件入口
 * ============================================================
 * 这是完整版，包含 L0（公式）+ L1（RMxprt）+ L2（Motor-CAD）三层。
 * 
 * 与免费版（dsh-motor-ai-l0）互斥：
 *   - 两者不能同时加载到同一个 DSH 实例
 *   - 启动时会检测全局标记并抛错提示
 * 
 * 使用方式：
 *   1. npm uninstall dsh-motor-ai-l0
 *   2. npm install dsh-motor-ai
 *   3. 更新 cordis.patch.yml 中 level 至 'l1' 或 'l2'
 */

import {
  LEVEL_ORDER,
  normalizeLevel,
  isLevelEnabled,
  tierOf,
} from '@yourscope/dsh-motor-ai-core'
import { registerL0Tools, L0_TOOL_NAMES } from './tools/l0/index.mjs'

// L1/L2 占位工具注册器（后续实现）
import { registerL1Placeholders } from './tools/l1/index.mjs'
import { registerL2Placeholders } from './tools/l2/index.mjs'

/** 所有已注册工具名（供日志与自检查询） */
export const ALL_TOOL_NAMES = [
  ...L0_TOOL_NAMES,
  // L1 占位（待实现后替换为真工具）
  'motor_l1_estimate',
  'motor_l1_pipeline',
  'motor_rmxprt_solve',
  // L2 占位
  'motor_l2_validate',
  'motor_motorcad_verify',
]

// ============================================================
// 互斥检测：检测是否已与免费版同时加载
// ============================================================
const GLOBAL_FLAG_KEY = '__DSH_MOTOR_AI_FULL_LOADED__'

if (globalThis[GLOBAL_FLAG_KEY]) {
  throw new Error(
    `[dsh-motor-ai] 检测到冲突！完整版 dsh-motor-ai 与免费版 dsh-motor-ai-l0 不能同时加载。\n` +
    `请执行：npm uninstall dsh-motor-ai-l0 && npm install dsh-motor-ai`
  )
}

// 注册全局标记
globalThis[GLOBAL_FLAG_KEY] = true

// ============================================================
// 插件注册
// ============================================================
/**
 * 注册所有工具（L0 + L1 + L2）
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 插件配置
 * @returns {Promise<{registered: string[], skipped: string[], config: object}>}
 */
export async function registerAll(ctx, config = {}) {
  const level = normalizeLevel(config?.level || 'l0')
  const registered = []
  const skipped = []
  
  // L0 始终注册（免费层）
  if (level === 'l0' || isLevelEnabled(config, 'l0')) {
    await registerL0Tools(ctx, config)
    registered.push(...L0_TOOL_NAMES)
  } else {
    skipped.push(...L0_TOOL_NAMES)
  }
  
  // L1 条件注册
  if (level === 'l1' && isLevelEnabled(config, 'l1')) {
    const l1Tools = await registerL1Placeholders(ctx, config)
    registered.push(...l1Tools)
  } else if (level === 'l1' && !isLevelEnabled(config, 'l1')) {
    // 配置了 L1 但未启用，注册占位符并给出引导
    const l1Tools = await registerL1Placeholders(ctx, config, { guideOnly: true })
    skipped.push(...l1Tools)
  }
  
  // L2 条件注册
  if (level === 'l2' && isLevelEnabled(config, 'l2')) {
    const l2Tools = await registerL2Placeholders(ctx, config)
    registered.push(...l2Tools)
  } else if (level === 'l2' && !isLevelEnabled(config, 'l2')) {
    const l2Tools = await registerL2Placeholders(ctx, config, { guideOnly: true })
    skipped.push(...l2Tools)
  }
  
  return { registered, skipped, config }
}

/**
 * 插件 Config Schema
 */
const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    level: {
      type: 'string',
      enum: ['l0', 'l1', 'l2'],
      default: 'l0',
      description: '插件工作层级：l0=公式，l1=RMxprt，l2=Motor-CAD',
    },
    l1Enabled: {
      type: 'boolean',
      default: false,
      description: '是否启用 L1（RMxprt 求解器）',
    },
    l2Enabled: {
      type: 'boolean',
      default: false,
      description: '是否启用 L2（Motor-CAD 验证器）',
    },
    // ... 其他配置项可继承自 core
  },
}

/**
 * 插件入口函数（DSH 框架调用）
 */
export default async function pluginEntry(ctx, config) {
  console.log('[dsh-motor-ai] 加载完整版，层级:', config?.level || 'l0')
  console.log('[dsh-motor-ai] L1 已启用:', config?.l1Enabled)
  console.log('[dsh-motor-ai] L2 已启用:', config?.l2Enabled)
  
  const { registered, skipped } = await registerAll(ctx, config)
  
  console.log(`[dsh-motor-ai] 已注册 ${registered.length} 个工具:`, registered)
  if (skipped.length > 0) {
    console.log(`[dsh-motor-ai] 跳过 ${skipped.length} 个工具:`, skipped)
  }
  
  return { registered, skipped }
}

// 导出公共 API（供外部脚本使用）
export {
  LEVEL_ORDER,
  normalizeLevel,
  isLevelEnabled,
  tierOf,
  registerL0Tools,
  registerL1Placeholders,
  registerL2Placeholders,
  ALL_TOOL_NAMES,
  CONFIG_SCHEMA,
}
