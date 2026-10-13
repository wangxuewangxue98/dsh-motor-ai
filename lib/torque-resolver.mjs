/**
 * L0 扭矩解算器（方案生成阶段 P1 新增；P3/P5 双字段 + env 开关）
 * ===========================================================
 * 唯一扭矩入口。资料《L0 扭矩计算方法比较》第四节代码框架移植为 JS，
 * P5 起输出「双字段」口径（期望输出 vs 可达能力，两类物理量分离）：
 *
 *   期望输出（排序口径，primary）
 *     spec        : params.torque_nm 显式规格（最高优先，RMxprt 交接用）
 *     power_speed : 9550·P/n 恒等式（P/n 已知——额定点是确定性关系，无需"预测"）
 *     ↓ 无 P/n 时以可达能力兜底（保证下游总有数或显式 insufficient_data）
 *
 *   可达能力（可行性口径，capability）
 *     surrogate(T1) : 代理模型预测（env DSH_L0_SURROGATE_TORQUE=on 且扭矩置信>阈值）
 *     d2l(T2)       : 方法2 D²L 电磁负荷公式（Bδ/A 可解析）
 *     stress(T2b)   : 方法3 切向应力公式（显式 sigma 或 Bδ/A 派生）
 *     ↓ 均不可用 → capability_source='unavailable'（恒 0，不伪造能力值）
 *
 * 为什么双字段：额定转矩 = P/n 的确定性函数（恒等式 MAPE 0.9%），而 D²L/代理
 * 估计的是「该几何能输出多少」。旧版把能力值当主输出（15kW 示例行返回 188.69
 * vs 额定 98.1）会误导排序；两者服务于不同决策，必须分离标注。
 *
 * 设计要点：
 *   - 零依赖、纯函数、可被 node 直接 import 单测
 *   - env 开关 DSH_L0_SURROGATE_TORQUE 默认 OFF：P3 训练目标落地后 T1 也保持
 *     静默，显式打开才激活（单变量对照；toggle 证零回归）
 *   - 输出 torque_source / torque_confidence / capability_source / capability_confidence
 *     诚实标注每一字段用的哪一级方法，下游据此决定能否当规格承诺
 *     （仅 spec 级 torque 可交接 RMxprt）
 *
 * ⚠ 循环依赖：本文件 import formula-engine（computeTorque/computeTorqueD2L/Stress），
 *   而 formula-engine 的 quickL0Estimate 也 import 本文件的 l0TorqueEstimate。
 *   两者均仅在运行时调用对方，模块顶层只定义函数/常量，ESM live binding 安全。
 */

import {
  TORQUE_CONST, WINDING_FACTOR, STACKING_FACTOR,
  queryTypicalBLoading,
} from './motor-constants.mjs'
import {
  computeTorque, computeTorqueD2L, computeTorqueStress,
} from './formula-engine.mjs'

/** 各级置信度标记（资料建议值，可经 opts.tierConfidence 覆盖） */
const TIER_CONFIDENCE = {
  spec: 0.95,
  surrogate: 0.70, // 仅当扭矩置信度高于此才采用 T1
  d2l: 0.85,
  stress: 0.80,
  power_speed: 0.95,
}

/** 代理扭矩总开关（P5 新增，默认 OFF） */
export const SURROGATE_TORQUE_ENV = 'DSH_L0_SURROGATE_TORQUE'

function envFlag(name) {
  const v = typeof process !== 'undefined' ? process.env?.[name] : undefined
  if (v == null) return false
  const s = String(v).trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'on' || s === 'yes'
}

/**
 * 代理扭矩通道是否启用（env DSH_L0_SURROGATE_TORQUE）
 * 默认 OFF ⇒ 即使模型已注入 torque 段，T1 也不参与解算（单变量对照，toggle 证零回归）。
 * @returns {boolean}
 */
export function isSurrogateTorqueEnabled() {
  return envFlag(SURROGATE_TORQUE_ENV)
}

/** 气隙切向应力推导 σ = Bδ·A（Pa）；已知 Bδ/A 即无需显式 sigma（方法3 与方法2 同口径） */
function deriveSigma(bDelta, aLoading) {
  return bDelta > 0 && aLoading > 0 ? bDelta * aLoading : 0
}

/**
 * L0 扭矩估算（方案生成阶段唯一扭矩入口）
 * @param {object} params 行参数（含 stator_id/core_length/power_kw/speed/torque_nm/
 *                            motor_type/cooling/B_delta/electric_loading/sigma）
 * @param {object} [opts]
 * @param {number} [opts.powerKw]    已解析功率（避免重复 computePowerKw）
 * @param {number} [opts.statorIdMm] 已解析定子内径（公式通道派生值回灌，优先于 params）
 * @param {number} [opts.coreLengthMm] 已解析铁心长
 * @param {number} [opts.surrogateTorque]    代理可达转矩（N·m，已按 torque_target 换算）
 * @param {number} [opts.surrogateConfidence] 代理扭矩置信度（扭矩模型自身 cv_r2 口径）
 * @param {boolean} [opts.surrogateTorqueEnabled] 覆盖 env 开关（默认读 env，OFF）
 * @param {string} [opts.motorType]  已规范化电机类型
 * @param {string} [opts.cooling]
 * @param {number} [opts.kw]  绕组系数（默认 WINDING_FACTOR）
 * @param {number} [opts.kFe] 叠压系数（默认 STACKING_FACTOR）
 * @param {object} [opts.tierConfidence] 覆盖各级阈值
 * @returns {{torque:number, torque_density:number, source:string, confidence:number,
 *            torque_capability:number, capability_source:string, capability_confidence:number,
 *            bDelta?:number, aLoading?:number, sigma?:number, error?:string}}
 */
export function l0TorqueEstimate(params = {}, opts = {}) {
  const TC = { ...TIER_CONFIDENCE, ...(opts.tierConfidence || {}) }
  const statorId = Number(opts.statorIdMm ?? params.stator_id ?? params.statorId ?? 0)
  const coreLength = Number(opts.coreLengthMm ?? params.core_length ?? params.coreLength ?? 0)
  const speed = Number(params.speed ?? params.speed_rpm ?? 0)

  // 功率解析（优先 opts.powerKw，其次 params.power_kw，再退 torque_nm·n/9550）
  let powerKw = Number.isFinite(Number(opts.powerKw)) ? Number(opts.powerKw) : NaN
  if (!Number.isFinite(powerKw)) {
    powerKw = Number(params.power_kw ?? 0)
  }
  if (!(powerKw > 0) && Number(params.torque_nm) > 0 && speed > 0) {
    powerKw = round2((Number(params.torque_nm) * speed) / TORQUE_CONST)
  }

  // 解析 Bδ / A：params 显式覆盖 > 知识表查询（能力口径共用）
  const motorType = opts.motorType ?? params.motor_type
  const cooling = opts.cooling ?? params.cooling
  const q = queryTypicalBLoading(motorType, cooling)
  const bDelta = Number(params.B_delta ?? params.b_delta ?? q.bDelta) || 0
  const aLoading = Number(params.electric_loading ?? params.aLoading ?? q.aLoading) || 0
  const sigma = Number(params.sigma ?? deriveSigma(bDelta, aLoading)) || 0

  // ── 可达能力（可行性口径）：T1 代理（env 门控）→ T2 D²L → T2b 切向应力 ──
  let capability = null
  const surrogateOn = opts.surrogateTorqueEnabled ?? isSurrogateTorqueEnabled()
  const sTorque = Number(opts.surrogateTorque ?? 0)
  const sConf = Number(opts.surrogateConfidence ?? 0)
  if (surrogateOn && sTorque > 0 && sConf > TC.surrogate) {
    capability = { torque: sTorque, source: 'surrogate', confidence: round2(sConf) }
  } else if (statorId > 0 && coreLength > 0 && bDelta > 0 && aLoading > 0) {
    const T = computeTorqueD2L({
      bDelta, aLoading, statorIdMm: statorId, coreLengthMm: coreLength,
      kw: opts.kw ?? WINDING_FACTOR, kFe: opts.kFe ?? STACKING_FACTOR,
    })
    capability = { torque: T, source: 'd2l', confidence: TC.d2l, bDelta, aLoading }
  } else if (statorId > 0 && coreLength > 0 && sigma > 0) {
    const T = computeTorqueStress({ statorIdMm: statorId, coreLengthMm: coreLength, sigma })
    capability = { torque: T, source: 'stress', confidence: TC.stress, sigma }
  }

  // ── 期望输出（排序口径）：spec → 恒等式 9550·P/n → 能力兜底 ──
  let primary = null
  const specTorque = Number(params.torque_nm ?? 0)
  if (specTorque > 0) {
    primary = { torque: specTorque, source: 'spec', confidence: TC.spec }
  } else if (powerKw > 0 && speed > 0) {
    primary = { torque: computeTorque(powerKw, speed), source: 'power_speed', confidence: TC.power_speed }
  } else if (capability) {
    // 无 P/n 时以能力值兜底（保持旧行为：总有数或显式 insufficient_data）
    primary = { ...capability }
  }

  if (!primary) {
    return {
      torque: 0, torque_density: 0, source: 'insufficient_data', confidence: 0,
      torque_capability: 0, capability_source: 'unavailable', capability_confidence: 0,
      error: 'insufficient_data',
    }
  }

  return finalize(primary, capability, statorId, coreLength)
}

/** 组装返回体 + 双字段密度（期望口径体积用 Dso²·L；能力口径按同体积可比） */
function finalize(primary, capability, statorIdMm, coreLengthMm) {
  const volumeM3 = (statorIdMm / 1000) ** 2 * (coreLengthMm / 1000)
  const density = (t) => (volumeM3 > 0 ? Math.round((Number(t) || 0) / volumeM3) : 0)
  const cap = capability ?? { torque: 0, source: 'unavailable', confidence: 0 }
  const out = {
    // 期望输出（排序口径）
    torque: round2(primary.torque),
    torque_density: density(primary.torque),
    source: primary.source,
    confidence: primary.confidence,
    // 可达能力（可行性口径）
    torque_capability: round2(cap.torque),
    capability_source: cap.source,
    capability_confidence: cap.confidence ?? 0,
  }
  const diag = cap.bDelta !== undefined
    ? { bDelta: cap.bDelta, aLoading: cap.aLoading }
    : (cap.sigma !== undefined ? { sigma: cap.sigma } : null)
  return diag ? { ...out, ...diag } : out
}

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100
}

export default { l0TorqueEstimate, isSurrogateTorqueEnabled, SURROGATE_TORQUE_ENV }
