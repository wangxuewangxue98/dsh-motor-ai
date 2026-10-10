/**
 * 激活机制核心模块（HMAC 验签 + 本地持久化）
 * ============================================================
 * 设计原则：
 *   1. Honor-system：门控是商业约定，非硬隔离。激活码可绕过（诚实说明）。
 *   2. HMAC-SHA256 签名：离线签码 + 本地验签，无需联网。
 *   3. 本地落盘：`$DSH_HOME/storages/dsh-motor-ai/activation.json`
 *   4. 默认关闭遥测（opt-in 弹一次，不在本模块处理——由 index.mjs 引导）。
 *   5. 零运行时依赖（纯 Node.js crypto/fs/path）。
 *
 * 激活码格式：`{type}:{issuer}:{buyer}:{ts}:{exp}:{hmac}`
 *   - type: 'l1' | 'l2' | 'full'
 *   - issuer: 签发者 ID（如 'wangxue98'）
 *   - buyer: 购买者标识（email / 昵称 / UUID，可选）
 *   - ts: 签发时间戳（ISO 8601）
 *   - exp: 过期时间戳（ISO 8601，null = 永不过期）
 *   - hmac: HMAC-SHA256 签名（密钥来自环境变量 ACTIVATION_HMAC_KEY）
 *
 * 密钥管理：
 *   - 签发时：ACTIVATION_HMAC_KEY（必须，由签发者持私钥）
 *   - 验签时：同样读取 ACTIVATION_HMAC_KEY（与签发者一致即可）
 *   - 不硬编码密钥：生产环境通过环境变量注入，开发环境可设测试密钥
 */

import { createHmac } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

// ============================================================
// 常量
// ============================================================
const ACTIVATE_CODE_VERSION = 'v1'
const DEFAULT_KEY_ID = 'default' // 密钥 ID（未来支持多密钥轮换）

/** 默认激活状态文件路径 */
export function getActivationFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-motor-ai', 'activation.json')
}

/** 获取 HMAC 密钥（环境变量，缺失时返回 null） */
export function getHmacKey() {
  return process.env.ACTIVATION_HMAC_KEY || null
}

// ============================================================
// 激活码编解码
// ============================================================

/**
 * 把激活码分段解析为结构体。
 * 编码约定（各字段均不含冒号，避免 split(':') 冲突）：
 *   v1:TYPE:ISSUER:BUYER_B64URL:TS_SEC:EXP_SEC:HMAC
 *   - BUYER_B64URL: base64url 编码的买家标识（可含任意字符，编码后无冒号）
 *   - TS_SEC: 签发 epoch 秒；EXP_SEC: 过期 epoch 秒，0 表示永久
 * @param {string} code
 * @returns {{ type: string, issuer: string, buyer: string, ts: string, exp: string | null, hmac: string, raw: string } | null}
 */
export function decodeActivateCode(code) {
  if (typeof code !== 'string' || !code.startsWith(`${ACTIVATE_CODE_VERSION}:`)) {
    return null
  }
  const parts = code.slice(ACTIVATE_CODE_VERSION.length + 1).split(':')
  // 期望 7 段：TYPE, ISSUER, BUYER_B64, TS_SEC, EXP_SEC, HMAC
  if (parts.length < 6) return null

  const [type, issuer, buyerB64, tsSec, expSec, hmac] = parts
  let buyer = ''
  try {
    buyer = buyerB64 ? Buffer.from(buyerB64, 'base64url').toString('utf-8') : ''
  } catch { buyer = '' }

  return {
    type: type || 'full',
    issuer: issuer || '',
    buyer,
    ts: tsSec || '',
    exp: expSec === '0' || expSec === '' ? null : expSec,
    hmac: hmac || '',
    raw: code,
  }
}

/**
 * 生成激活码（离线签码，供签发者使用）
 * @param {object} opts
 * @param {string} opts.type - 'l1' | 'l2' | 'full'
 * @param {string} opts.issuer - 签发者 ID
 * @param {string} [opts.buyer] - 购买者标识
 * @param {number} [opts.validDays] - 有效期天数（null = 永不过期）
 * @param {string} opts.secret - HMAC 密钥（与 ACTIVATION_HMAC_KEY 一致）
 * @returns {string} 激活码
 */
export function createActivateCode({ type, issuer, buyer = '', validDays = null, secret }) {
  const tsSec = String(Math.floor(Date.now() / 1000))
  const expSec = validDays
    ? String(Math.floor(Date.now() / 1000) + validDays * 86400)
    : '0' // 0 = 永久

  const buyerB64 = buyer ? Buffer.from(buyer, 'utf-8').toString('base64url') : ''
  const payload = [type, issuer, buyerB64, tsSec, expSec].join(':')
  const sig = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 16) // 截断为 16 位 hex，方便人工输入

  return `${ACTIVATE_CODE_VERSION}:${payload}:${sig}`
}

/**
 * 由解码结果重算签名载荷（与 createActivateCode 保持对称）。
 * @param {object} decoded decodeActivateCode 的输出
 * @returns {string} 用于 HMAC 的规范载荷字符串
 */
function payloadOf(decoded) {
  const buyerB64 = decoded.buyer
    ? Buffer.from(decoded.buyer, 'utf-8').toString('base64url')
    : ''
  const expSec = decoded.exp === null || decoded.exp === '' ? '0' : String(decoded.exp)
  return [decoded.type, decoded.issuer, buyerB64, String(decoded.ts), expSec].join(':')
}

/**
 * 验签激活码
 * @param {object} decoded - decodeActivateCode 的输出
 * @param {string} secret - HMAC 密钥
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyActivateCode(decoded, secret) {
  if (!decoded || !secret) return { valid: false, reason: '缺少激活码或密钥' }

  // 重算签名并比对
  const payload = payloadOf(decoded)
  const expectedSig = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 16)

  if (decoded.hmac !== expectedSig) {
    return { valid: false, reason: '签名不匹配（激活码无效或被篡改）' }
  }

  // 检查过期（exp 为 epoch 秒，0 = 永久）
  if (decoded.exp !== null && decoded.exp !== '' && decoded.exp !== '0') {
    const expMs = Number(decoded.exp) * 1000
    if (isNaN(expMs) || expMs < Date.now()) {
      return { valid: false, reason: '激活码已过期' }
    }
  }

  return { valid: true }
}

// ============================================================
// 激活状态持久化
// ============================================================

/**
 * 加载激活状态（从 activation.json）
 * @returns {{ active: boolean, tier: 'free' | 'l1' | 'l2' | 'full', activatedAt: string, buyer: string, keyId: string } | null}
 */
export function loadActivationState() {
  try {
    const filePath = getActivationFilePath()
    if (!existsSync(filePath)) return null

    const raw = readFileSync(filePath, 'utf-8').trim()
    if (!raw) return null

    const state = JSON.parse(raw)
    if (!state || typeof state !== 'object') return null

    // 基本校验
    if (!state.active) return null
    if (!['free', 'l1', 'l2', 'full'].includes(state.tier)) return null

    return {
      active: true,
      tier: state.tier,
      activatedAt: state.activatedAt || new Date().toISOString(),
      buyer: state.buyer || '',
      keyId: state.keyId || DEFAULT_KEY_ID,
    }
  } catch {
    return null
  }
}

/**
 * 写入激活状态
 * @param {object} state
 * @param {boolean} state.active
 * @param {'free'|'l1'|'l2'|'full'} state.tier
 * @param {string} state.buyer
 * @param {string} [state.keyId]
 */
export function saveActivationState(state) {
  try {
    const filePath = getActivationFilePath()
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })

    const payload = {
      active: state.active,
      tier: state.tier,
      activatedAt: state.activatedAt || new Date().toISOString(),
      buyer: state.buyer || '',
      keyId: state.keyId || DEFAULT_KEY_ID,
      version: ACTIVATE_CODE_VERSION,
    }

    writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
    return true
  } catch (err) {
    console.error('[license] 写激活状态失败:', err.message)
    return false
  }
}

// ============================================================
// 公共 API
// ============================================================

/**
 * 激活（验证激活码并写入状态）
 * @param {string} code - 激活码
 * @param {string} [secret] - HMAC 密钥（缺省读 ACTIVATION_HMAC_KEY）
 * @returns {{ success: boolean, tier?: string, buyer?: string, reason?: string }}
 */
export function activate(code, secret) {
  const key = secret || getHmacKey()
  if (!key) {
    return { success: false, reason: '未配置 ACTIVATION_HMAC_KEY 环境变量（激活服务不可用）' }
  }

  const decoded = decodeActivateCode(code)
  if (!decoded) {
    return { success: false, reason: '激活码格式无效（应形如 v1:type:issuer:buyer:ts:exp:hmac）' }
  }

  const verification = verifyActivateCode(decoded, key)
  if (!verification.valid) {
    return { success: false, reason: verification.reason }
  }

  // 确定 tier（code.type 决定可用层级）
  const tier = decoded.type === 'full' ? 'full'
    : decoded.type === 'l2' ? 'l2'
    : decoded.type === 'l1' ? 'l1'
    : 'free'

  const state = {
    active: true,
    tier,
    buyer: decoded.buyer || 'unknown',
    keyId: decoded.issuer || DEFAULT_KEY_ID,
  }

  const ok = saveActivationState(state)
  if (!ok) {
    return { success: false, reason: '激活状态写入失败（可能无写入权限）' }
  }

  return { success: true, tier, buyer: state.buyer }
}

/**
 * 查询当前激活状态
 * @returns {{ active: boolean, tier: 'free' | 'l1' | 'l2' | 'full', buyer: string }}
 */
export function queryActivation() {
  const state = loadActivationState()
  if (state) {
    return { active: true, tier: state.tier, buyer: state.buyer }
  }
  return { active: false, tier: 'free', buyer: '' }
}

/**
 * 检查是否允许访问指定层级
 * @param {'l1'|'l2'|'l0'} level
 * @returns {boolean}
 */
export function isLevelAllowed(level) {
  const { active, tier } = queryActivation()
  if (!active) return level === 'l0' // 免费版只能用 l0
  if (level === 'l0') return true
  if (level === 'l1') return tier === 'l1' || tier === 'l2' || tier === 'full'
  if (level === 'l2') return tier === 'l2' || tier === 'full'
  return false
}

/**
 * 生成激活引导信息（未激活时 L1/L2 工具的返回）
 * @param {'l1'|'l2'} level
 * @returns {object} 包含 status/tool/error/guide 的标准返回体
 */
export function buildActivationGuide(level) {
  return {
    status: 'requires_activation',
    tool: `motor_${level}_estimate`,
    level,
    error: `需要激活 ${level.toUpperCase()} 功能`,
    guide: {
      hint: '请向作者获取激活码（私域渠道），或使用命令 `/dsh-motor-ai-activate <code>`',
      nextSteps: [
        '1. 联系作者获取激活码',
        '2. 运行 `/dsh-motor-ai-activate <your-code>` 完成激活',
        '3. 激活后重新调用本工具',
      ],
      licenseNote: '本插件按 PolyForm Noncommercial 1.0 许可分发；商业用途需单独授权。',
    },
  }
}

// ============================================================
// 导出
// ============================================================
export default {
  // 编码/解码
  createActivateCode,
  decodeActivateCode,
  verifyActivateCode,
  // 持久化
  loadActivationState,
  saveActivationState,
  getActivationFilePath,
  // 公共 API
  activate,
  queryActivation,
  isLevelAllowed,
  // 辅助
  buildActivationGuide,
  getHmacKey,
}
