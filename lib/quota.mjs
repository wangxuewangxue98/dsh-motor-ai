/**
 * 每日调用额度闸门（G1）：免费档硬限 + 付费档宽松硬顶。
 *
 * 设计原则（分发后失联场景 —— 原点诉求）：
 *  1. **离线为本**：计数只认本地 free-quota.json，不依赖后端；
 *     后端可达时仅作旁路遥测（best-effort），不可达/异常不影响强制逻辑。
 *  2. **免费档 fail-closed（硬限制）**：默认 10 次/天，用尽直接抛 QuotaExceededError，
 *     即便后端不可达也拦（与旧版 fail-open 相反，旧版在分发场景形同虚设）。
 *  3. **付费档同样硬顶（防滥用兜底）**：默认 9999 次/天（DSH_PAID_DAILY_LIMIT 可覆盖）。
 *     正常人工使用永远触碰不到，但可阻断脚本化批量刷用/异常循环；
 *     上限宽松到「不可能误伤真实用户」，因此仍是 fail-closed 而非 fail-open。
 *  4. **多重植入 + 防重计**：assertFreeQuota 注入各模块函数/入口
 *     （L0 内部函数 buildParamMatrix / runL0Estimate / runL0Pipeline / runDesignValidate；
 *       L1 三个 execute；L2 两个 execute）；用「调用链一次性消费标记」
 *     （按 config 对象 Threading + 微任务重置）保证一次用户动作只计 1 次 ——
 *     pipeline 内连调多个内部函数不重复扣；绕过工具网关、直调内部函数同样被计。
 *
 * 存储：与激活态同目录（getActivationFilePath 的 dirname）/free-quota.json
 *   结构：{ day: 'YYYY-MM-DD'(本地自然日), free: number, paid: number }
 *   跨天自动重置（day 不匹配即归 0）。旧格式 {day, used} 兼容读取为 free。
 *
 * 诚实边界：本地限制本质是「软限制」——懂技术用户可删/改 free-quota.json 清零。
 * 但它比「完全不限（旧版 fail-open）」强一个数量级，且因植入内部函数，正常用户与
 * 直调内部函数者都无法无声跳过。真防破解仍需联网后端（与「离线」前提冲突，故作增益而非强制）。
 */
import {
  getDeviceId,
  queryActivation,
  getActivationFilePath,
  CONTACT_EMAIL,
} from './license.mjs'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

/** 插件侧上报的 plugin_id（与后端 free_call 默认值一致） */
export const DEFAULT_QUOTA_PLUGIN_ID = 'dsh-motor-ai-l0'

/** 每日免费额度默认上限（可用 DSH_FREE_DAILY_LIMIT 覆盖） */
export const DEFAULT_FREE_DAILY_LIMIT = 10

/** 每日付费档宽松硬顶（可用 DSH_PAID_DAILY_LIMIT 覆盖）：正常人工使用不可达，仅防脚本滥用 */
export const DEFAULT_PAID_DAILY_LIMIT = 9999

/**
 * 调用链一次性消费标记（**rc.14 重写：显式调用链令牌**；对齐 l0 v0.5.2）
 * ============================================================================
 * rc.13 及以前的写法是「_consumed WeakSet（key = config 对象）+ queueMicrotask 复位」，
 * 实测有两个致命缺陷（最小复现见 l0 scripts/_repro_syncbatch.mjs，同款实现同款结论）：
 *   ① **同步批量脱闸**：同步 for 循环复用同一 config 引用时，微任务在整段循环结束前
 *      不会执行 ⇒ 第 2~N 次 alreadyConsumed() 恒为 true ⇒ **整批只扣 1 次**。
 *      CI 脚本 / 压测循环正是这种写法，门禁形同虚设（P0-门1'）。
 *   ② **语义错位**：把「一次用户动作」错误等价于「config 对象引用相同」。
 * rc.14 改为由聚合入口（runL0Pipeline）新建**唯一调用链令牌**，并派生携带令牌的
 * config 透传给子纯函数：
 *   - 同链（同一令牌）⇒ 只扣 1 次，行为不变；
 *   - 跨调用（哪怕同一 config 引用、同一 macrotask、同步循环）⇒ 令牌不同 ⇒ 各计一次。
 */
const QUOTA_CHAIN = Symbol('dsh-motor-ai-quota-chain')
let _chainConsumed = null // WeakSet<token>；令牌随调用链结束自然可回收，无需定时清理

/** 新建一次调用链的唯一令牌（聚合入口每次调用新建一个） */
export function newQuotaChain() {
  return {}
}

/**
 * 派生「属于同一调用链」的 config（携带不可枚举令牌）。
 * 不污染调用方传入的 config 对象本身 ⇒ 用户复用同一 config 时仍各自独立计数。
 * @param {object} [config] 调用方配置
 * @param {object} token newQuotaChain() 产出的令牌
 * @returns {object} 携带令牌的派生配置
 */
export function withQuotaChain(config, token) {
  const out = Object.assign({}, config || {})
  Object.defineProperty(out, QUOTA_CHAIN, {
    value: token, enumerable: false, writable: false, configurable: false,
  })
  return out
}

function chainConsumed(token) {
  return !!(token && _chainConsumed && _chainConsumed.has(token))
}
function markChainConsumed(token) {
  if (!token) return
  if (!_chainConsumed) _chainConsumed = new WeakSet()
  _chainConsumed.add(token)
}

/** 配额用尽错误：内部函数抛出，工具层捕获后转成引导文案 */
export class QuotaExceededError extends Error {
  /** @param {string} message @param {object} [info] */
  constructor(message, info = {}) {
    super(message)
    this.name = 'QuotaExceededError'
    this.quota = info
  }
}

/** 后端基址解析（优先级：config > env > 默认）。仅用于旁路遥测。 */
function backendBase(config = {}) {
  return String(
    config.commerceBackendUrl ||
    config.backendUrl ||
    process.env.DSH_BACKEND_URL ||
    'http://127.0.0.1:5000'
  ).trim().replace(/\/+$/, '')
}

/** 配额文件路径：与激活态同目录，降低被单独发现/清理的概率 */
function quotaFilePath() {
  try {
    return join(dirname(getActivationFilePath()), 'free-quota.json')
  } catch {
    return join(process.cwd(), 'free-quota.json')
  }
}

/** 本地自然日键（按机器本地时区，非 UTC，符合「按天重置」直觉） */
function localDayKey() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 每日上限：默认 10（DEFAULT_FREE_DAILY_LIMIT），环境变量 DSH_FREE_DAILY_LIMIT 可覆盖 */
export function getDailyLimit() {
  const n = Number(process.env.DSH_FREE_DAILY_LIMIT)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FREE_DAILY_LIMIT
}

/** 付费档每日上限：默认 9999（DEFAULT_PAID_DAILY_LIMIT），环境变量 DSH_PAID_DAILY_LIMIT 可覆盖 */
export function getPaidDailyLimit() {
  const n = Number(process.env.DSH_PAID_DAILY_LIMIT)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PAID_DAILY_LIMIT
}

/**
 * 读本地配额态；文件缺失/损坏/跨天 → 视为新的一天，从 0 开始。
 * 兼容旧格式 {day, used}（视为 free 计数）。
 */
function readLocalQuota() {
  const limit = getDailyLimit()
  const paidLimit = getPaidDailyLimit()
  const day = localDayKey()
  const file = quotaFilePath()
  let free = 0
  let paid = 0
  try {
    const raw = readFileSync(file, 'utf-8')
    const obj = JSON.parse(raw)
    if (obj && obj.day === day) {
      free = Math.max(0, Number(obj.free ?? obj.used) || 0)
      paid = Math.max(0, Number(obj.paid) || 0)
    }
  } catch {
    /* 缺失/损坏 → 新一天，从 0 */
  }
  return { day, free, paid, limit, paidLimit }
}

/** 写本地配额态；只读/损坏目录静默失败，仍按内存态强制，不崩 */
function writeLocalQuota(state) {
  const file = quotaFilePath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify(
        {
          day: state.day,
          free: state.free,
          paid: state.paid,
          limit: state.limit,
          paidLimit: state.paidLimit,
        },
        null,
        2
      ),
      'utf-8'
    )
  } catch {
    /* 静默：强制逻辑不依赖写盘成功 */
  }
}

/** 是否免费档：无激活态或 tier==='free' → 免费 */
function isFreeTier() {
  const a = queryActivation()
  return !(a && a.active === true && a.tier && a.tier !== 'free')
}

/** 当前档位：'free' | 'paid' */
export function currentTier() {
  return isFreeTier() ? 'free' : 'paid'
}

/**
 * 硬限闸（消耗型）—— 注入各模块函数/工具入口顶部。
 *  - 免费档：本地 free 计数，达到 limit（默认 10）抛 QuotaExceededError（fail-closed）。
 *  - 付费档：本地 paid 计数，达到 paidLimit（默认 9999）同样抛错（宽松硬顶，防脚本滥用）。
 *  - 同一调用链只消耗一次：判据是**调用链令牌**（rc.14），不是 config 对象引用。
 *    pipeline 新建令牌并用 withQuotaChain() 派生配置透传给三个子纯函数 ⇒ 整链只扣 1 次；
 *    而调用方同步循环复用同一 config 引用时，因每次顶层调用令牌不同 ⇒ **各计一次**
 *    （rc.13 此处整批只扣 1 次，P0-门1'）。
 *  - config.freeQuotaEnabled === false → 直接放行（运维开关；纯函数入口同样尊重，
 *    内部离线批量工具 experience-hub capture / case-feedback 聚合据此显式 bypass）。
 * @param {string} [tool] 调用来源标记（仅用于审计/日志）
 * @param {object} [config] 配置对象；同链子调用须传 withQuotaChain() 派生的带令牌对象
 */
export function assertFreeQuota(tool = 'l0', config = {}) {
  // rc.13（对齐 l0 v0.5.1）：运维开关在纯函数入口同样尊重
  if (config && config.freeQuotaEnabled === false) return
  // rc.14：同链判据 = 调用链令牌（无令牌 ⇒ 视为独立顶层调用，必计一次）
  const token = config && typeof config === 'object' ? config[QUOTA_CHAIN] : null
  if (chainConsumed(token)) return // 本调用链已消耗：不重复扣
  const tier = isFreeTier() ? 'free' : 'paid'
  const state = readLocalQuota()
  const used = tier === 'free' ? state.free : state.paid
  const limit = tier === 'free' ? state.limit : state.paidLimit
  if (used >= limit) {
    throw new QuotaExceededError(buildQuotaExceededMessage({ limit, used, tier }), {
      limit,
      used,
      tier,
      reason: tier === 'free' ? 'quota-exhausted' : 'paid-quota-exhausted',
      day: state.day,
      tool,
    })
  }
  writeLocalQuota({
    day: state.day,
    free: state.free + (tier === 'free' ? 1 : 0),
    paid: state.paid + (tier === 'paid' ? 1 : 0),
    limit: state.limit,
    paidLimit: state.paidLimit,
  })
  markChainConsumed(token) // rc.14：按调用链令牌标记，同链子调用据此跳过
}

/**
 * 旁路遥测（best-effort，不参与放行决策）：后端可达时 POST /api/dsh/free-call
 * 同步计数；若后端返 used 更大（换机/多副本场景），取 max 回写本地。
 * 仅免费档调用（付费档不占后端免费额度）。
 */
async function syncBackendTelemetry(config, localUsed) {
  const base = backendBase(config)
  const pluginId = String(config.quotaPluginId || DEFAULT_QUOTA_PLUGIN_ID)
  const deviceId = getDeviceId()
  try {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 4000) : null
    const res = await fetch(`${base}/api/dsh/free-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // P1（对齐 l0 v0.5.1）：附带本地自然日与本地限额，接收端按同一把尺计数，
      // 消「接收端 UTC+8 vs 插件本地时区」「接收端固定 10 vs 插件可覆盖」两个口径差。
      // 本函数仅免费档调用（见 :290 的 tier==='free' 门），故 limit 取免费档口径。
      body: JSON.stringify({
        plugin_id: pluginId,
        device_id: deviceId,
        day: localDayKey(),
        limit: getDailyLimit(),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (timer) clearTimeout(timer)
    try {
      const body = await res.json()
      if (body && body.allowed === false && Number(body.used) > localUsed) {
        const state = readLocalQuota()
        writeLocalQuota({
          day: state.day,
          free: Math.max(state.free, Number(body.used) || 0),
          paid: state.paid,
          limit: state.limit,
          paidLimit: state.paidLimit,
        })
      }
    } catch {
      /* 响应非 JSON → 忽略 */
    }
  } catch {
    /* 失联 → 忽略，本地为准 */
  }
}

/**
 * 只读查询（不消耗）—— 供工具入口做友好提前拒绝 + 后端旁路遥测。
 * 免费档：本地读 free 计数，用尽返回 allowed:false。
 * 付费档：本地读 paid 计数，达 9999 硬顶返回 allowed:false；否则 allowed:true
 *        （reason 仍为 'activated'，附带 used/remaining/limit/tier 便于诊断）。
 * 注意：放行决策以本地为准，后端仅遥测，不决定放行。
 * @param {object} [config]
 * @returns {Promise<{allowed: boolean, used?: number, remaining?: number, limit?: number, tier?: string, reason: string}>}
 */
export async function checkFreeQuota(config = {}) {
  const tier = isFreeTier() ? 'free' : 'paid'
  const state = readLocalQuota()
  const used = tier === 'free' ? state.free : state.paid
  const limit = tier === 'free' ? state.limit : state.paidLimit
  if (used >= limit) {
    return {
      allowed: false,
      reason: tier === 'free' ? 'quota-exhausted' : 'paid-quota-exhausted',
      used,
      limit,
      tier,
      day: state.day,
    }
  }
  // 旁路遥测（best-effort，不阻塞、不影响放行）：仅免费档
  if (tier === 'free') syncBackendTelemetry(config, used).catch(() => {})
  return {
    allowed: true,
    reason: tier === 'free' ? 'within-quota' : 'activated',
    used,
    remaining: limit - used,
    limit,
    tier,
    day: state.day,
  }
}

/** 额度用尽时的引导文案（含购买/激活方式，别只说"不行"） */
export function buildQuotaExceededMessage(info = {}) {
  const tier = info.tier || 'free'
  const limit = info.limit ?? (tier === 'free' ? getDailyLimit() : getPaidDailyLimit())
  const used = info.used ?? limit
  const contact = CONTACT_EMAIL
  if (tier === 'paid') {
    return (
      `今日调用次数已达授权档上限（${used}/${limit} 次/天，按本地自然日重置）。\n` +
      `该上限为防脚本滥用的兜底阈值，正常使用不会触发。\n` +
      `若确属批量计算需求，请联系 ${contact} 申请批量授权；\n` +
      `或次日自动重置后再用。`
    )
  }
  return (
    `今日免费额度已用尽（${used}/${limit} 次/天，按本地自然日重置）。\n` +
    `请选择：\n` +
    `1) 明天再用（额度自动重置）；\n` +
    `2) 输入激活口令解锁：执行 activate 工具并粘贴 DM-XXXX-XXXX（授权档上限 ${getPaidDailyLimit()} 次/天）；\n` +
    `3) 购买授权请联系 ${contact}。`
  )
}

/**
 * 工具执行前的统一闸门（消耗型）：返回 null 表示放行，否则返回错误对象。
 * 内部通过 assertFreeQuota 完成真实消耗，并在 config 上打「本链已消耗」标记，
 * 使后续内部函数不再重复扣。
 * @param {object} config
 * @returns {Promise<null | {error: string, quota: object}>}
 */
export async function enforceQuota(config = {}) {
  if (config.freeQuotaEnabled === false) return null
  try {
    assertFreeQuota('tool-gate', config)
    return null
  } catch (e) {
    if (e instanceof QuotaExceededError) return { error: e.message, quota: e.quota }
    throw e
  }
}

export default {
  checkFreeQuota,
  enforceQuota,
  assertFreeQuota,
  buildQuotaExceededMessage,
  QuotaExceededError,
  DEFAULT_QUOTA_PLUGIN_ID,
  DEFAULT_FREE_DAILY_LIMIT,
  DEFAULT_PAID_DAILY_LIMIT,
  getDailyLimit,
  getPaidDailyLimit,
  currentTier,
}
