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
} from '@wangxue98/dsh-motor-ai-core'
import { registerL0Tools, L0_TOOL_NAMES } from './tools/l0/index.mjs'

// L1/L2 占位工具注册器（后续实现）
import { registerL1Placeholders } from './tools/l1/index.mjs'
import { registerL2Placeholders } from './tools/l2/index.mjs'

// 激活机制（收费轨 A）
import { registerActivateCommand, ACTIVATE_TOOL_NAME } from './tools/activate.mjs'
import {
  activate as activateLicense,
  queryActivation,
  isLevelAllowed,
  createActivateCode,
  buildActivationGuide,
} from './lib/license.mjs'

/** 注入依赖：tools（工具注册能力，与免费版 dsh-motor-ai-l0 同一要求） */
export const inject = ['tools']

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

  // 激活命令始终注册（免费用户用它解锁 L1/L2；已激活用户可查询状态）
  await registerActivateCommand(ctx, config)
  registered.push(ACTIVATE_TOOL_NAME)

  // L0 始终注册（免费层）
  if (level === 'l0' || isLevelEnabled(config, 'l0')) {
    await registerL0Tools(ctx, config)
    registered.push(...L0_TOOL_NAMES)
  } else {
    skipped.push(...L0_TOOL_NAMES)
  }

  // L1 始终注册（工具恒存在）；调用时按许可证门控——
  // 无码/过期/无效 → 返回 LICENSE_REQUIRED 引导，L0 不受影响（落实引流触点 2）
  const l1Tools = await registerL1Placeholders(ctx, config)
  registered.push(...l1Tools)

  // L2 始终注册（同上）
  const l2Tools = await registerL2Placeholders(ctx, config)
  registered.push(...l2Tools)

  // 附带当前激活状态（供前端/调用方展示）
  const activation = queryActivation()
  return {
    registered,
    skipped,
    config,
    activation,
    l1Allowed: isLevelAllowed('l1'),
    l2Allowed: isLevelAllowed('l2'),
  }
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
    activationPublicKeyPem: {
      type: 'string',
      default: '',
      description: '验签公钥 PEM 覆盖（缺省用 lib/license.mjs 内置公钥；仅密钥轮换或测试时填，覆盖 ACTIVATION_PUBLIC_KEY_PEM）',
    },
    // ---- 脱敏聚合遥测（完整版默认开，2026-10-14）----
    // 只上报「按工具聚合的白名单统计量」（次数/成败/耗时/规模），不含设计参数正文。
    // 必须在此声明：DSH 会裁掉 schema 未声明的键（backendUrl 恒 undefined 的前车之鉴）。
    telemetryEnabled: {
      type: 'boolean',
      default: true,
      description: '脱敏聚合遥测总开关（默认开；置 false 显式退出）。白名单见 lib/telemetry.mjs',
    },
    telemetryEndpoint: {
      type: 'string',
      default: '',
      description: '聚合遥测 POST 目标；空 = 回退 {后端}/api/dsh/dsh-plugins/dsh-motor-ai/usage-report',
    },
    telemetryBatchSize: {
      type: 'number',
      default: 50,
      description: '每批最多上报的 usage 记录条数（offset 按实际发送推进）',
    },
    telemetryMinIntervalMs: {
      type: 'number',
      default: 60000,
      description: '两次上报尝试之间的最小间隔毫秒（0 = 不节流；兼容旧键 telemetryIntervalSec 秒语义）',
    },
    // ... 其他配置项可继承自 core
  },
}

/**
 * 插件入口函数（DSH 框架调用）
 */
export default async function pluginEntry(ctx, config) {
  const activation = queryActivation()
  console.log('[dsh-motor-ai] 加载完整版，层级:', config?.level || 'l0')
  console.log('[dsh-motor-ai] L1 已启用:', config?.l1Enabled)
  console.log('[dsh-motor-ai] L2 已启用:', config?.l2Enabled)
  console.log('[dsh-motor-ai] 激活状态:', activation.active
    ? `${activation.tier.toUpperCase()}（${activation.buyer || 'anonymous'}）`
    : '未激活（L0 免费可用，L1/L2 需激活）')

  const { registered, skipped } = await registerAll(ctx, config)

  console.log(`[dsh-motor-ai] 已注册 ${registered.length} 个工具:`, registered)
  if (skipped.length > 0) {
    console.log(`[dsh-motor-ai] 跳过 ${skipped.length} 个工具:`, skipped)
  }

  // ⚠️ 此处**绝不能 return 普通对象**：cordis 把插件 apply 的返回值当作 effect，
  // 只接受 disposer 函数或 null/undefined（cordis/lib/index.js:1138-1144）。
  // async 入口若 resolve 成对象，会走 effect.then(safeCollect)
  // ⇒ TypeError: Invalid effect at safeCollect ⇒ "装得上、启用失败"。
  // （已由 scripts/verify.mjs 门禁 F 锁定）
  // 外部脚本若需要 registered/skipped/activation 信息，直接调用命名导出 registerAll()。
}

// cordis 在**调用 apply 之前**就读取插件对象自身的 inject 属性判定可访问服务；
// 裸函数导出必须在模块加载时挂上，否则 ctx.tools 访问被拒
// （报错形态：cannot get property "tools" without inject）
pluginEntry.inject = inject

// 导出公共 API（供外部脚本使用）
export {
  LEVEL_ORDER,
  normalizeLevel,
  isLevelEnabled,
  tierOf,
  registerL0Tools,
  registerL1Placeholders,
  registerL2Placeholders,
  registerActivateCommand,
  ACTIVATE_TOOL_NAME,
  activateLicense,
  queryActivation,
  isLevelAllowed,
  createActivateCode,
  buildActivationGuide,
}
