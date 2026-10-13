/**
 * 代理模型引擎 —— L0 surrogate 预测通道（灰度集成版）
 * ===========================================================
 * 设计原则：
 *   1. **灰度安全**：默认不启用，需显式配置 l0Mode='surrogate'
 *   2. **分族模型**：异步/ PMSM 各分小/中/大型，基于 OD 自动选择
 *   3. **置信度门控**：低于 threshold 自动降级公式通道
 *   4. **格式兼容**：输出结构与 formula-engine.mjs 完全一致
 *   5. **零依赖**：只用 Node 内置能力，可被单测
 *
 * 模型文件：
 *   - models/l0_surrogate_family.json  ← 分族模型（推荐）
 *   - models/l0_surrogate_single.json  ← 单模型（备选）
 *
 * W5 阶段交付：正式 surrogate 模型权重替换 stub。
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { resolveMotorType, WINDING_FACTOR, STACKING_FACTOR, TORQUE_CONST } from './motor-constants.mjs'
import { buildL0Result } from './param-schema.mjs'
import { l0TorqueEstimate } from './torque-resolver.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 默认置信度阈值 (v2.0.0: 由 0.7 降到 0.4, 因分族模型最佳 cv_r2≈0.67, 原 0.7 会让所有段被判降级而永不启用) */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.4

/** 模型 schema 版本校验 */
const REQUIRED_SCHEMA = ['l0_surrogate_family', 'l0_surrogate_single']
/**
 * 支持的模型版本前缀（导出以便 verify.mjs 门禁断言）。
 * N3 (0.2.9 P3)：放行 3.x。
 *   背景：经验回流触发重训后产物 version=3.1.0-fixseg，而此前只认 1./2.
 *   ⇒ 重训产物在 loadSurrogateModel 直接抛「模型版本不支持」，回流闭环断在最后一环。
 *   安全性：3.1.0-fixseg 与现役 2.3.0-fixseg **特征集一致**（实测 133,652 个系数
 *   逐字节比对 max diff = 0.0，仅 version 字符串不同），放行不改变任何推理行为。
 *   ⚠ 若未来 3.x 引入新特征集（非 fixseg 口径），须同步扩展本白名单并补推理侧兼容。
 */
export const SUPPORTED_VERSION_PREFIXES = ['1.', '2.', '3.']

/**
 * 加载代理模型权重文件
 * @param {string} modelPath 模型文件路径（相对或绝对）
 * @returns {object} 模型对象
 */
export function loadSurrogateModel(modelPath) {
  // 支持相对路径（从 lib/ 目录）和绝对路径
  let absPath
  if (modelPath.startsWith('/') || modelPath.startsWith('C:\\') || modelPath.startsWith('file://')) {
    absPath = modelPath.replace('file://', '')
  } else if (modelPath.startsWith('models/')) {
    // 相对路径从 lib/ 目录的父目录出发（即项目根目录）
    absPath = resolve(__dirname, '..', modelPath)
  } else if (modelPath.startsWith('../')) {
    // 向上路径：从 lib/ 出发
    absPath = resolve(__dirname, modelPath)
  } else if (modelPath.startsWith('./')) {
    // 当前目录路径
    absPath = resolve(__dirname, modelPath)
  } else {
    // 默认从项目根目录出发
    absPath = resolve(__dirname, '..', modelPath)
  }
  
  try {
    const raw = readFileSync(absPath, 'utf-8')
    const model = JSON.parse(raw)
    
    // 基础校验
    if (!REQUIRED_SCHEMA.includes(model.schema)) {
      throw new Error(`模型 schema 不匹配: 期望 ${REQUIRED_SCHEMA.join('|')}, 实际 ${model.schema}`)
    }
    const versionOk = SUPPORTED_VERSION_PREFIXES.some((p) => model.version?.startsWith(p))
    if (!versionOk) {
      throw new Error(`模型版本不支持: ${model.version}, 需要 ${SUPPORTED_VERSION_PREFIXES.join(' / ')}`)
    }
    
    return model
  } catch (err) {
    if (err.message.includes('stub')) {
      throw new Error('代理模型仍为 stub 占位，请训练后替换模型文件')
    }
    throw new Error(`加载代理模型失败: ${err.message}`)
  }
}

/**
 * 根据定子外径选择分族模型
 * @param {number} statorOd 定子外径 mm
 * @param {string} motorType 'induction' | 'pmsm'
 * @param {object} model 模型对象
 * @returns {object|null} 匹配的族模型或 null
 */
export function selectFamilySegment(statorOd, motorType, model) {
  if (model.schema !== 'l0_surrogate_family') {
    return null
  }
  
  const segments = model[`${motorType}_segments`]
  if (!segments) return null
  
  for (const [size, seg] of Object.entries(segments)) {
    const [lo, hi] = seg.od_range
    if (statorOd >= lo && statorOd < hi) {
      return { size, ...seg }
    }
  }
  
  return null
}

/**
 * 计算特征向量（标准化）
 * @param {object} params L0 参数字典
 * @param {object} norm 归一化参数
 * @returns {number[]} 特征向量
 */
export function extractFeatures(params, norm) {
  const features = []
  const order = norm.featureOrder || norm.feature_names || []
  
  for (const feat of order) {
    const raw = params[feat]
    if (raw === undefined || raw === null) {
      throw new Error(`特征 ${feat} 缺失`)
    }
    
    // 支持两种归一化格式
    let mean, std
    if (norm.stats && norm.stats[feat]) {
      mean = norm.stats[feat].mean
      std = norm.stats[feat].std
    } else {
      const idx = order.indexOf(feat)
      mean = norm.feature_mean?.[idx] ?? 0
      std = norm.feature_std?.[idx] ?? 1
    }
    
    const normalized = std > 0 ? (raw - mean) / std : 0
    features.push(normalized)
  }
  return features
}

/**
 * 线性回归预测（单输出）
 * @param {number[]} features 特征向量
 * @param {object} coeffs 系数对象
 * @returns {number} 预测值
 */
export function predictLinear(features, coeffs) {
  let result = coeffs.coef?.[0] ?? 0
  const order = coeffs.featureOrder || coeffs.feature_names || []
  
  for (let i = 1; i < coeffs.coef.length; i++) {
    if (features[i - 1] !== undefined) {
      result += features[i - 1] * coeffs.coef[i]
    }
  }
  return result
}

/**
 * 评估单棵 GBR 决策树（sklearn 数组导出格式）
 * 约定：feature[i] === -2 表示叶子节点，values[i] 为叶子输出；
 *       叶子节点 left/right 均为 -1。以 maxIter 兜底防异常树结构死循环。
 * @param {number[]} features 标准化特征向量
 * @param {object} tree 单棵树 { feature, threshold, left, right, values }
 * @returns {number} 该树对残差的贡献
 */
function applyTree(features, tree) {
  let node = 0
  const maxIter = tree.feature.length + 1
  for (let i = 0; i < maxIter; i++) {
    const f = tree.feature[node]
    if (f === -2) {
      return tree.values[node]
    }
    if (features[f] <= tree.threshold[node]) {
      node = tree.left[node]
    } else {
      node = tree.right[node]
    }
  }
  return tree.values[node] ?? 0
}

/**
 * GBR 残差校正预测（ridge_plus_gbr 第二阶段）
 * 公式（与训练端 M1 一致）：residual = init + learning_rate * Σ applyTree(features, tree)
 * 残差与 primary 线性预测同单位（效率百分点），最终效率 = primary + residual。
 * 模型无 gbr 字段时返回 0（退化为纯 ridge 通道，行为不变）。
 * @param {number[]} features 标准化特征向量
 * @param {object|undefined} gbr GBR 模型对象（含 init/learning_rate/trees）
 * @returns {number} 残差修正量（效率百分点）
 */
export function predictGBR(features, gbr) {
  if (!gbr || !Array.isArray(gbr.trees) || gbr.trees.length === 0) {
    return 0
  }
  let sum = 0
  for (const tree of gbr.trees) {
    sum += applyTree(features, tree)
  }
  return (gbr.init ?? 0) + (gbr.learning_rate ?? 1) * sum
}

/**
 * 预测 torque 目标（P3 多目标扩展，方案生成阶段）
 * ===========================================================
 * 模型段含 torque_primary（Ridge 系数，口径：RMxprt 可达转矩 N·m）
 * + 可选 torque_gbr（残差树，同 GBR 口径）时输出预测值。
 *
 * 零回归保证：以下情形一律返回 {torque: 0, cv_r2: null}，
 *   调用方（torque-resolver.mjs T1）见到 torque=0 即自动降级到
 *   D²L(T2)/切向应力(T2b)/功率转速(T3)，行为与 P3 前完全一致：
 *     1. 模型无 torque 段（现役 2.3.0-fixseg 即此状态）
 *     2. torque_primary.coef 非法/长度不足
 *     3. 特征缺失或结构异常（extractFeatures 抛错）
 *
 * ⚠ 口径：torque 是「几何+绕组可达转矩」估算，不是额定转矩（9550·P/n）；
 *   不得顶替 spec torque_nm 交接 RMxprt（见 l0-estimate.mjs torque_contract）。
 *
 * @param {object} params L0 参数字典
 * @param {object} seg 族段对象（single 模型时传 model 本身）
 * @param {object} model 模型对象
 * @returns {{torque:number, cv_r2:number|null}}
 */
export function predictTorqueTarget(params, seg, model) {
  const tp = seg?.torque_primary ?? model?.targets?.torque?.primary
  if (!tp || !Array.isArray(tp.coef) || tp.coef.length < 2) {
    return { torque: 0, cv_r2: null, confidence: 0 }
  }
  // 目标口径（train_surrogate_family_multi_target.py --torque-target，段内 torque_target 字段）：
  //   torque_nm       模型输出即绝对转矩 N·m
  //   torque_density  模型输出为 N·m/m³（Dso²·L 体积口径）⇒ 须 ×(Dso²·L) 换算为绝对转矩
  //   ratio           模型输出为 torque/(9550·P/n) ⇒ 须 ×(9550·P/n) 换算为绝对转矩
  // ⚠ 无此换算会把密度值（数千 N·m/m³）当绝对转矩直接交给 resolver ⇒ 转矩静默放大百倍。
  const target = tp.torque_target ?? seg?.torque_target ?? model?.torque_target ?? 'torque_nm'
  try {
    const norm = {
      featureOrder: tp.feature_names ?? model.torque_features ?? model.features,
      feature_mean: tp.feature_mean,
      feature_std: tp.feature_std,
    }
    const features = extractFeatures(params, norm)
    const raw = predictLinear(features, tp)
    const gbr = seg?.torque_gbr ?? model?.targets?.torque?.gbr
    const residual = predictGBR(features, gbr)
    // 物理钳位：原始输出非负（退化样本/超域预测可能给负值）
    const rawOut = Math.max(0, raw + residual)
    let torque = rawOut
    if (target === 'torque_density') {
      const odM = Number(params.stator_od ?? params.statorOd ?? 0) / 1000
      const lM = Number(params.core_length ?? params.coreLength ?? 0) / 1000
      const vol = odM * odM * lM
      if (!(vol > 0)) {
        return { torque: 0, cv_r2: tp.cv_r2 ?? null, confidence: 0, torque_target: target }
      }
      torque = rawOut * vol
    } else if (target === 'ratio') {
      const p = Number(params.power_kw ?? 0)
      const n = Number(params.speed_rpm ?? params.speed ?? 0)
      if (!(p > 0 && n > 0)) {
        return { torque: 0, cv_r2: tp.cv_r2 ?? null, confidence: 0, torque_target: target }
      }
      torque = rawOut * (TORQUE_CONST * p / n)
    }
    const rounded = Math.round(torque * 100) / 100
    // 扭矩专属置信度（P3）：与效率置信度分离——T1 门控必须以扭矩模型自身
    // cv_r2 + 特征范围为准，不能用效率置信度（否则效率高置信会放行低质量扭矩预测）
    const confidence = rounded > 0 ? estimateConfidence(features, norm, tp.cv_r2 ?? 0) : 0
    return { torque: rounded, cv_r2: tp.cv_r2 ?? null, confidence, torque_target: target }
  } catch (_) {
    // 特征缺失/结构异常 → 静默降级（与代理通道整体降级语义一致）
    return { torque: 0, cv_r2: null, confidence: 0 }
  }
}

/**
 * 代理模型预测单个样本（分族模型）
 * @param {object} params L0 参数字典
 * @param {object} model 模型对象
 * @param {string} [motorType] 电机类型（'induction' | 'pmsm'），不传则自动检测
 * @returns {object|null} 预测结果或 null（超出范围时）
 */
export function predictSurrogate(params, model, motorType = null) {
  const statorOd = params.stator_od
  const type = motorType ?? detectMotorType(params)

  // 分族模型
  if (model.schema === 'l0_surrogate_family') {
    const segment = selectFamilySegment(statorOd, type, model)
    if (segment) {
      return predictFromSegment(params, segment, model, type)
    }
    // 超出范围，返回 null 让调用方降级
    return null
  }

  // 单模型
  if (model.schema === 'l0_surrogate_single') {
    return predictFromSingle(params, model, type)
  }

  throw new Error(`不支持的模型 schema: ${model.schema}`)
}

/**
 * 从分族模型预测
 */
function predictFromSegment(params, segment, model, motorType) {
  const primary = segment.primary
  const norm = {
    // primary.feature_names 是 v1.x 格式；v2.x 把特征顺序存在顶层 model.features
    featureOrder: primary.feature_names ?? model.features,
    feature_mean: primary.feature_mean,
    feature_std: primary.feature_std
  }
  const features = extractFeatures(params, norm)

  // 基础预测（加权 Ridge）
  const rawEff = predictLinear(features, primary)

  // GBR 残差校正（ridge_plus_gbr 第二阶段）：final = base + residual
  // 残差与 primary 同单位（效率百分点），模型无 gbr 字段时退化为纯 ridge（行为不变）
  const gbrResidual = predictGBR(features, segment.gbr)
  const correctedEff = rawEff + gbrResidual

  // 预测效率 (物理合理性钳位: 效率不可能 <50% 或 >99%)
  const efficiency = Math.min(99, Math.max(50, correctedEff))

  const usedGbr = !!segment.gbr && Array.isArray(segment.gbr.trees) && segment.gbr.trees.length > 0

  // 置信度：基于 R² 和特征范围（维持与纯 ridge 通道一致，避免改变降级判定）
  const confidence = estimateConfidence(features, norm, primary.cv_r2)

  // ── P3 多目标：torque 可达转矩预测（模型无 torque 段 → 0，调用方降级 T2/T3）──
  const torquePred = predictTorqueTarget(params, segment, model)

  return {
    efficiency: Math.round(efficiency * 100) / 100,
    temp_rise: params.temp_rise ?? 0, // 暂不支持温升预测
    total_loss: estimateTotalLoss(params, efficiency),
    torque: torquePred.torque,
    torque_cv_r2: torquePred.cv_r2,
    torque_confidence: torquePred.confidence ?? 0, // P3: T1 门控用扭矩专属置信度
    confidence,
    prediction_source: 'surrogate',
    family: { motor_type: motorType, size: primary.tag?.split('_')[0] },
    cv_r2: primary.cv_r2,
    used_gbr: usedGbr,
    gbr_residual_pp: usedGbr ? Math.round(gbrResidual * 1000) / 1000 : 0,
  }
}

/**
 * 从单模型预测
 */
function predictFromSingle(params, model) {
  const targets = model.targets
  const effPrimary = targets.efficiency?.primary
  if (!effPrimary) {
    throw new Error('单模型缺少 efficiency 系数')
  }
  
  const norm = {
    featureOrder: effPrimary.feature_names,
    feature_mean: effPrimary.feature_mean,
    feature_std: effPrimary.feature_std
  }
  const features = extractFeatures(params, norm)

  // 直接预测效率 (物理合理性钳位)
  const rawEff = predictLinear(features, effPrimary)
  const efficiency = Math.min(99, Math.max(50, rawEff))
  
  // 置信度
  const confidence = estimateConfidence(features, norm, 0.487) // 单模型 R²≈0.49

  // ── P3 多目标：torque 可达转矩预测（模型无 torque 段 → 0，调用方降级 T2/T3）──
  const torquePred = predictTorqueTarget(params, model, model)

  return {
    efficiency: Math.round(efficiency * 100) / 100,
    temp_rise: 0, // 单模型 temp_rise 不可用
    total_loss: estimateTotalLoss(params, efficiency),
    torque: torquePred.torque,
    torque_cv_r2: torquePred.cv_r2,
    torque_confidence: torquePred.confidence ?? 0, // P3: T1 门控用扭矩专属置信度
    confidence,
    prediction_source: 'surrogate',
    family: { motor_type: detectMotorType(params), size: 'single' },
    cv_r2: 0.487,
  }
}

/**
 * 检测电机类型（0.2.6 P0 重写）：显式别名经 resolveMotorType 规范化，
 * 缺省一律判 induction —— 与生成路径（buildParamMatrix 缺省按异步几何产行）同默认。
 *
 * ⚠ 旧实现的 OD 启发式（od<400 → pmsm）已删除：它与生成默认矛盾，
 *   导致 OD<612.4mm 的中小型异步机在代理通道被静默误判 pmsm → 分族选段失败
 *   → skipped（10 万案例压测实测 19.8%）。几何是按异步口径生成的，
 *   推理端再"聪明"地猜 pmsm 也只是放大错误，不是修正错误。
 */
function detectMotorType(params) {
  return resolveMotorType(params?.motor_type).type
}

/**
 * 估算总损耗（基于效率反推）
 * 修复（0.1.7-P0）：efficiency 是百分数口径（如 91.34 表示 91.34%），
 * 旧实现按小数口径算 (1/eff-1) 会得到负值/错误量级；先归一到 [0,1] 再反推。
 */
function estimateTotalLoss(params, efficiency) {
  const powerKw = params.power_kw ?? 0
  if (!powerKw) return 0
  const eff = efficiency / 100
  if (!(eff > 0) || eff >= 1) return 0 // η≤0 或 η≥100% 时无法反推，返回 0 交公式通道兜底
  const powerW = powerKw * 1000
  return Math.round(powerW * (1 / eff - 1) * 100) / 100
}

/**
 * 置信度估算（基于 R² 和特征距离）
 * @param {number[]} features 标准化特征
 * @param {object} norm 归一化参数
 * @param {number} r2 R² 值
 * @returns {number} 置信度 [0, 1]
 */
function estimateConfidence(features, norm, r2) {
  // 基础置信度 = R²
  let confidence = Math.max(0, r2)
  
  // 特征范围惩罚
  let outOfRangeCount = 0
  for (let i = 0; i < features.length; i++) {
    if (Math.abs(features[i]) > 3) { // 3σ 外
      outOfRangeCount++
    }
  }
  const ratio = outOfRangeCount / features.length
  confidence *= (1 - ratio * 0.5)
  
  return Math.max(0, Math.min(1, confidence))
}

/**
 * 批量预测（带置信度门控和范围外降级）
 * @param {Array<object>} paramsList 参数列表
 * @param {object} model 模型对象
 * @param {number} confidenceThreshold 置信度阈值
 * @returns {object} { results, fallbacks, skipped }
 */
export function predictBatch(paramsList, model, confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD) {
  const results = []
  const fallbacks = []
  let skipped = 0

  for (const params of paramsList) {
    try {
      const pred = predictSurrogate(params, model)

      if (pred === null) {
        // 超出模型范围，标记为需降级
        results.push({
          error: 'OD 超出模型训练范围',
          fallback_to_formula: true,
          confidence: 0,
          skipped: true,
        })
        skipped++
        continue
      }

      if (pred.confidence < confidenceThreshold) {
        // 置信度不足，标记降级
        pred.fallback_to_formula = true
        pred.confidence_reason = `置信度 ${pred.confidence.toFixed(2)} < 阈值 ${confidenceThreshold}`
        fallbacks.push(pred)
      }

      results.push(pred)
    } catch (err) {
      // 预测失败，标记降级
      results.push({
        error: err.message,
        fallback_to_formula: true,
        confidence: 0,
      })
      skipped++
    }
  }

  return { results, fallbacks: fallbacks.length, skipped }
}

/**
 * 构建 L0 结果（兼容公式通道格式）
 * @param {object} params 原始参数
 * @param {object} prediction 预测结果
 * @returns {object} L0 结果字典
 */
export function buildSurrogateResult(params, prediction) {
  // 方案生成阶段 P4/P5：扭矩走双字段解算器（唯一入口 lib/torque-resolver.mjs）。
  // 期望输出：spec/9550·P/n 恒等式优先；可达能力：代理 T1（env DSH_L0_SURROGATE_TORQUE
  // 门控）→ D²L(T2) → 切向应力(T2b)。代理 torque=0 或置信不足 ⇒ T1 自动降级。
  const torqueRes = l0TorqueEstimate(params, {
    motorType: resolveMotorType(params.motor_type).type,
    cooling: params.cooling,
    kw: WINDING_FACTOR,
    kFe: STACKING_FACTOR,
    surrogateTorque: prediction?.torque ?? 0,        // P3 落地后非 0 即参与 T1（已按 torque_target 换算为 N·m）
    surrogateConfidence: prediction?.torque_confidence ?? 0, // P3: 扭矩专属置信度（无扭矩目标 ⇒ 0 ⇒ T1 跳过）
  })
  const native = {
    efficiency: prediction.efficiency ?? 0,
    torque: torqueRes.torque,
    temp_rise: prediction.temp_rise ?? 0,
    total_loss: prediction.total_loss ?? 0,
    torque_density: torqueRes.torque_density,
    torque_source: torqueRes.source,
    torque_confidence: torqueRes.confidence,
    torque_capability: torqueRes.torque_capability,
    capability_source: torqueRes.capability_source,
    capability_confidence: torqueRes.capability_confidence,
    prediction_source: 'surrogate',
  }
  
  const mirror = {
    max_temp: (prediction.temp_rise ?? 0) + 25, // 环境温度 25°C
    power: 0,
    copper_loss: 0,
    iron_loss: 0,
    mechanical_loss: 0,
    solve_mode: 'l0',
    l1_efficiency_proxy: prediction.efficiency ?? 0,
    l1_temp_proxy: (prediction.temp_rise ?? 0) + 25,
  }
  
  return buildL0Result({ params, native, mirror, confidence: prediction.confidence })
}

export default {
  loadSurrogateModel,
  predictSurrogate,
  predictBatch,
  buildSurrogateResult,
  predictTorqueTarget,
  extractFeatures,
  selectFamilySegment,
  predictGBR,
  DEFAULT_CONFIDENCE_THRESHOLD,
}
