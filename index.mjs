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
import { registerEnvCheck, ENV_CHECK_TOOL_NAME } from './tools/env-check.mjs'
import { registerEnvBootstrap, ENV_BOOTSTRAP_TOOL_NAME } from './tools/env-bootstrap.mjs'
import { registerReportIssue, REPORT_ISSUE_TOOL_NAME } from './tools/report-issue.mjs'
import { registerFaultAssist, FAULT_ASSIST_TOOL_NAME } from './tools/fault-assist.mjs'

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
  // 知识积累闭环（贡献型、不占配额——问题解决后回流知识库，P1-B）
  'submit_resolved_case',
  // 故障协助（在线经验智能支持：脱敏故障上报 + 相似案例匹配，Part 二完整版）
  FAULT_ASSIST_TOOL_NAME,
  // L1 占位（待实现后替换为真工具）
  'motor_l1_estimate',
  'motor_l1_pipeline',
  'motor_rmxprt_solve',
  // L2 占位
  'motor_l2_validate',
  'motor_motorcad_verify',
  // 反馈（免费、无门控——问题回流通道）
  'motor_report_issue',
  // 环境自助配置（免费、不占配额——一键补齐 pyaedt/pywin32）
  ENV_BOOTSTRAP_TOOL_NAME,
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

  // 环境体检工具始终注册（免费、不占配额——自检/自救通道，见 tools/env-check.mjs 设计决策）
  await registerEnvCheck(ctx, config)
  registered.push(ENV_CHECK_TOOL_NAME)

  // 环境自助配置工具始终注册（免费、不占配额——一键补齐 pyaedt/pywin32，见 tools/env-bootstrap.mjs）
  await registerEnvBootstrap(ctx, config)
  registered.push(ENV_BOOTSTRAP_TOOL_NAME)

  // 问题反馈工具始终注册（免费、不占配额、无授权要求——分发失联时唯一问题回流通道，
  // 见 tools/report-issue.mjs 设计决策；任何门控都会把反馈掐死在起点）
  await registerReportIssue(ctx, config)
  registered.push(REPORT_ISSUE_TOOL_NAME)

  // 故障协助工具始终注册（免费、不占配额、无授权要求——报错路径的在线经验支持触点）
  await registerFaultAssist(ctx, config)
  registered.push(FAULT_ASSIST_TOOL_NAME)

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
    telemetryIntervalSec: {
      type: 'number',
      default: 300,
      description: '旧键（秒语义）：仅在未设置 telemetryMinIntervalMs 时生效',
    },
    // ---- 后端通道（rc.11 补声明：不声明会被 DSH 裁成 undefined）----
    // 空 = 依次回退环境变量 DSH_BACKEND_URL → 本机 http://127.0.0.1:5000。
    backendUrl: {
      type: 'string',
      default: '',
      description: '后端基址（配额旁路遥测 / 聚合遥测 / 激活在线校验共用）；空 = 用 env DSH_BACKEND_URL 或本机 5000',
    },
    commerceBackendUrl: {
      type: 'string',
      default: '',
      description: '商业化后端基址（优先于 backendUrl）；空 = 回退 backendUrl 逻辑',
    },
    // ---- L0 运行参数（默认值与代码内默认逐键对齐；cordis.patch.yml 的 bundle 值优先）----
    l0Mode: {
      type: 'string',
      enum: ['formula', 'surrogate', 'auto'],
      default: 'formula',
      description: "L0 通道：formula=公式（默认）/ surrogate=代理 / auto=代理失败自动回退公式；注意 cordis.patch.yml 默认 'auto'",
    },
    surrogatePath: {
      type: 'string',
      default: 'models/l0_surrogate_family.json',
      description: 'L0 代理模型文件（相对插件根）',
    },
    surrogateConfidenceThreshold: {
      type: 'number',
      default: 0.4,
      description: '代理模型置信度阈值（低于则回退公式通道）',
    },
    maxMatrixSize: {
      type: 'number',
      default: 2000,
      description: '参数矩阵规模上限（超过则截断并告警 MATRIX_TRUNCATED，防组合爆炸）',
    },
    // rc.16 P0-2：默认 false（截断只告警，兼容既有脚本）；true = 请求量超上限直接报错
    strictMaxMatrixSize: {
      type: 'boolean',
      default: false,
      description: '矩阵截断严格模式：请求 count 超过 maxMatrixSize 时直接报错而非静默截断',
    },
    defaultMotorType: {
      type: 'string',
      default: 'pmsm',
      description: '默认电机类型（im/synm/pmsm 等，工具入参可覆盖）',
    },
    line_freq_hz: {
      type: ['number', 'null'],
      default: null,
      description: '工频默认值（行入参缺省时兜底；null = 不注入）',
    },
    // ---- 物理校验口径（与 lib/regression-gate.mjs / tools/l0 内默认一致）----
    efficiencyCap: {
      type: 'number',
      default: 96,
      description: '效率上限校验值（%，对齐 motor_tools.py:752）',
    },
    tempRiseRange: {
      type: 'array',
      default: [45, 130],
      description: '温升限值区间 [min, max]（K）',
    },
    airGapFluxT: {
      type: 'number',
      default: 0.8,
      description: '气隙磁密基准（T）',
    },
    insulationClass: {
      type: 'string',
      default: 'F',
      description: '绝缘等级（B=80K / F=105K / H=125K），行入参可覆盖',
    },
    bgCaliber: {
      type: 'string',
      enum: ['actual', 'intent'],
      default: 'actual',
      description: '气隙磁密口径：actual=实测几何 / intent=设计意图（工具入参 bg_caliber 可覆盖）',
    },
    // ---- L2 Motor-CAD（与 tools/l2/motorcad-verify.mjs 内默认一致）----
    motorcadMode: {
      type: 'string',
      enum: ['com', 'backend', 'auto'],
      default: 'com',
      description: 'L2 通道：com=本机 COM 直驱（默认）/ backend=后端代理（预留未实现）/ auto',
    },
    motorcadProgid: {
      type: 'string',
      default: 'MotorCAD.AppAutomation',
      description: 'Motor-CAD COM ProgID',
    },
    l1Python: {
      type: 'string',
      default: '',
      description: '驱动 RMxprt worker 的 Python 解释器路径（需 pyaedt）；空 = 依次探测 PYTHON_BIN/PATH；motorcadPython 优先于本键',
    },
    motorcadPython: {
      type: 'string',
      default: '',
      description: '驱动 bridge 的 Python 解释器路径；空 = 依次探测 PATH/MotorDesign 内嵌',
    },
    motorcadTimeoutMs: {
      type: 'number',
      default: 600000,
      description: 'Motor-CAD 求解超时（ms；电磁分析约 190-200s，默认留足余量）',
    },
    motFile: {
      type: 'string',
      default: '',
      description: '默认 .mot 模板文件；空 = 不预载（也可用 env MOTORCAD_DEFAULT_MOT）',
    },
    runEmag: {
      type: 'boolean',
      default: true,
      description: 'L2 verify 是否执行电磁分析',
    },
    runThermal: {
      type: 'boolean',
      default: true,
      description: 'L2 verify 是否执行热分析',
    },
    fallbackToEquivalent: {
      type: 'boolean',
      default: true,
      description: 'L2 COM 不可用时是否降级等效电路法（runL0Estimate）兜底',
    },
    // ---- 配额 / 经验回传 / usage 落盘（与 lib 内默认一致）----
    quotaPluginId: {
      type: 'string',
      default: 'dsh-motor-ai-full',
      description: '后端额度账 plugin_id（完整版独立记账：与免费版 l0 分桶，供制作者侧区分来源）',
    },
    freeQuotaEnabled: {
      type: 'boolean',
      default: true,
      description: '免费档每日硬配额开关；false = 关闭本地配额（不推荐）',
    },
    usageLog: {
      type: 'boolean',
      default: true,
      description: '本地 usage.jsonl 落盘开关；false = 不落盘（遥测聚合也会无源）',
    },
    designExperienceUpload: {
      type: 'boolean',
      default: true,
      description: '脱敏设计经验回传（design_exp 通道）；2026-10-21 起默认开（与 cordis.patch.yml 一致，opt-out 置 false）',
    },
    experienceEndpoint: {
      type: 'string',
      default: '',
      description: 'design_exp 通道端点；空 = 回退 telemetryEndpoint',
    },
    experienceBatchSize: {
      type: 'number',
      default: 200,
      description: 'design_exp 单批上限条数',
    },
    experienceMinIntervalMs: {
      type: 'number',
      default: 60000,
      description: 'design_exp 上报节流窗口（毫秒）；0 = 不节流。未设时回退 telemetryMinIntervalMs',
    },
    // ---- 已解决问题回流（P1-B；贡献型、不占配额，默认关闭）----
    // 用户在插件里解决问题后，通过 submit_resolved_case 工具把「问题分类 / 症状 /
    // 根因 / 改进措施 / 解决过程」发回接收端（/api/dsh/issue-resolved），喂在线知识库。
    // 身份类字段（账号 / 路径 / 提示词 / 密钥）经白名单硬排除；fire-and-forget 不影响主流程。
    issueResolvedEnabled: {
      type: 'boolean',
      default: true,
      description: '已解决问题回流总开关（2026-10-21 起默认开，知识经验回流；opt-out 置 false）',
    },
    issueResolvedEndpoint: {
      type: 'string',
      default: '',
      description: '已解决问题回传目标 URL；空 = 自动回退 commerceBackendUrl + /api/dsh/issue-resolved；二者都空 = 不启用',
    },
    // ---- 故障协助（在线经验智能支持，Part 二完整版）----
    // 用户报故障时，提示上传脱敏故障情况 → 自动匹配在线知识库相似案例给经验建议；
    // 解决后用 submit_resolved_case 回流。受 issueResolvedEndpoint 同源后端约束。
    faultAssistEnabled: {
      type: 'boolean',
      default: true,
      description: '故障协助总开关（默认开；显式 false 退出在线经验支持引导与故障上报，opt-out）',
    },
    faultReportEndpoint: {
      type: 'string',
      default: '',
      description: '脱敏故障上报目标 URL；空 = 自动回退 commerceBackendUrl + /api/dsh/fault-report；二者都空 = 不启用',
    },
    issueQueryEndpoint: {
      type: 'string',
      default: '',
      description: '相似案例查询目标 URL；空 = 自动回退 commerceBackendUrl + /api/dsh/issue-resolved/query；二者都空 = 仅提示不查询',
    },
    // ---- 在线知识库入口（P1-C；为空 = 所有文案不带链接）----
    knowledgeBaseUrl: {
      type: 'string',
      default: 'https://workbuddy.link/p/xWcD0qQyCUoGVl98S2LHei',
      description: '在线知识库地址（公开导航页）；配置后，故障协助 / 额度用尽文案 / submit_resolved_case 提示会带「先查知识库」入口',
    },
    kbQueryEndpoint: {
      type: 'string',
      default: '',
      description: '设计经验统一查询端点（design-assist）；空 = 自动回退 commerceBackendUrl + /api/dsh/kb/query；二者都空 = 设计前不注入经验',
    },
    designAssistEnabled: {
      type: 'boolean',
      default: true,
      description: '设计经验注入（design-assist）总开关（默认开；显式 false 退出设计前经验注入，opt-out）',
    },
    // ---- 工程 / 回归（与 lib/regression-gate.mjs、tools/l0/pipeline.mjs 内默认一致）----
    motorDesignRoot: {
      type: 'string',
      default: '',
      description: 'MotorDesign 仓库根（求解器路径拼接源）；空 = 用 env MOTORDESIGN_ROOT',
    },
    // rc.18 补声明：lib/env-probe.mjs:484 读取（env-bootstrap 自定义 venv 目标）；
    // 不声明会被 DSH 裁键 → 恒 undefined，「自定义 venv 路径」参数失效。
    bootstrapVenvPath: {
      type: 'string',
      default: '',
      description: 'env-bootstrap 创建 venv 的目标目录；空 = {motorDesignRoot}/venv 或 ~/.dsh-motor-ai/bootstrap-venv',
    },
    handoffDir: {
      type: 'string',
      default: '',
      description: 'L0 pipeline 交接目录；空 = 进程 cwd 下 l0-handoff',
    },
    budget: {
      type: 'object',
      default: { efficiency_pt: 2, temp_k: 10 },
      description: '回归门预算 { efficiency_pt, temp_k }',
    },
    sanityBlocking: {
      type: 'boolean',
      default: false,
      description: '回归 sanity 检查是否阻断（true = fail-fast）',
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
  registerFaultAssist,
  FAULT_ASSIST_TOOL_NAME,
  registerActivateCommand,
  ACTIVATE_TOOL_NAME,
  activateLicense,
  queryActivation,
  isLevelAllowed,
  createActivateCode,
  buildActivationGuide,
}
