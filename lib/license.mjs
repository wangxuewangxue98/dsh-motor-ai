/**
 * 激活机制核心模块（非对称验签 v2 + HMAC v1 兼容 + 本地持久化）
 * ============================================================
 * 设计原则：
 *   1. Honor-system：门控是商业约定，非硬隔离。激活码可绕过（诚实说明）。
 *   2. 非对称验签（v2，默认）：Ed25519 离线签码 + 公钥本地验签，无需联网。
 *      - 公钥随包发布（lib/activation-public.pem + 本文件内置常量），公开安全。
 *      - 私钥由作者自持（.secrets/activation-private.pem，绝不入库/不随包）。
 *      - 部署出去的公开包内置公钥即可验签，**外部买家可被真实放行**。
 *   3. HMAC 验签（v1，兼容兜底）：仅用于本地开发遗留码；需 ACTIVATION_HMAC_KEY。
 *      v1 已废弃，新签码一律走 v2。
 *   4. 本地落盘：`$DSH_HOME/storages/dsh-motor-ai/activation.json`
 *   5. 默认关闭遥测（opt-in 弹一次，不在本模块处理——由 index.mjs 引导）。
 *   6. 零运行时依赖（纯 Node.js crypto/fs/path）。
 *
 * 激活码格式：
 *   v1（HMAC，已废弃）：`v1:TYPE:ISSUER:BUYER_B64URL:TS_SEC:EXP_SEC:HMAC16`
 *   v2（非对称，默认）：`v2:TYPE:ISSUER:BUYER_B64URL:TS_SEC:EXP_SEC:SIG128`
 *   - TYPE: 'l1' | 'l2' | 'full'
 *   - ISSUER: 签发者 ID（如 'wangxue98'）
 *   - BUYER_B64URL: base64url 编码买家标识（编码后无冒号，规避 split 错位）
 *   - TS_SEC / EXP_SEC: epoch 秒；EXP_SEC=0 表示永久
 *   - HMAC16: HMAC-SHA256 截断 16 hex（v1）
 *   - SIG128: Ed25519 签名 64 字节 → 128 hex（v2）
 *
 * 密钥管理：
 *   - 验签公钥：内置常量 BUILTIN_PUBLIC_KEY_PEM（可用环境变量 ACTIVATION_PUBLIC_KEY_PEM 覆盖，测试用）
 *   - 签发私钥：作者本地 .secrets/activation-private.pem（不入库/不随包）
 */

import { createHmac, createPublicKey, createPrivateKey, sign, verify as cryptoVerify } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

// ============================================================
// 常量
// ============================================================
const ACTIVATE_CODE_VERSION = 'v2' // 新签码默认版本
const DEFAULT_KEY_ID = 'default' // 密钥 ID（未来支持多密钥轮换）

/**
 * 内置验签公钥（Ed25519，SPKI/PEM）。
 * 公钥公开，随包发布无泄露风险；硬编码保证验签不依赖文件 I/O / 路径解析。
 * 与 lib/activation-public.pem 内容一致（同步维护）。
 */
const BUILTIN_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFiyA2MWskbINENkPweftiKbs1wKs6jpLsTplINyikFw=
-----END PUBLIC KEY-----`

/** 默认激活状态文件路径 */
export function getActivationFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-motor-ai', 'activation.json')
}

/** 获取 HMAC 密钥（v1 兼容，环境变量，缺失时返回 null） */
export function getHmacKey() {
  return process.env.ACTIVATION_HMAC_KEY || null
}

/**
 * 获取验签公钥（v2 非对称）。
 * 优先环境变量 ACTIVATION_PUBLIC_KEY_PEM 覆盖（测试用），否则内置常量。
 * @returns {import('node:crypto').KeyObject | null}
 */
export function getVerifyKey() {
  try {
    const pem = process.env.ACTIVATION_PUBLIC_KEY_PEM || BUILTIN_PUBLIC_KEY_PEM
    return createPublicKey(pem)
  } catch {
    return null
  }
}

// ============================================================
// 激活码编解码
// ============================================================

/**
 * 把激活码分段解析为结构体。支持 v1（HMAC）与 v2（非对称）。
 * @param {string} code
 * @returns {{ version: string, type: string, issuer: string, buyer: string, ts: string, exp: string | null, sig: string, raw: string } | null}
 */
export function decodeActivateCode(code) {
  if (typeof code !== 'string') return null
  const m = code.match(/^v(\d+):(.*)$/)
  if (!m) return null
  const version = `v${m[1]}`
  if (!['v1', 'v2'].includes(version)) return null

  const rest = m[2].split(':')
  // 期望 6 段：TYPE, ISSUER, BUYER_B64, TS_SEC, EXP_SEC, SIG/HMAC
  if (rest.length < 6) return null

  const [type, issuer, buyerB64, tsSec, expSec, sig] = rest
  let buyer = ''
  try {
    buyer = buyerB64 ? Buffer.from(buyerB64, 'base64url').toString('utf-8') : ''
  } catch { buyer = '' }

  return {
    version,
    type: type || 'full',
    issuer: issuer || '',
    buyer,
    ts: tsSec || '',
    exp: expSec === '0' || expSec === '' ? null : expSec,
    sig: sig || '',
    raw: code,
  }
}

/**
 * 生成激活码。
 *   - 传 privateKey（Ed25519）→ 产 v2 非对称码（推荐）
 *   - 传 secret（HMAC）→ 产 v1 兼容码（本地开发遗留用）
 * @param {object} opts
 * @param {string} opts.type - 'l1' | 'l2' | 'full'
 * @param {string} opts.issuer - 签发者 ID
 * @param {string} [opts.buyer] - 购买者标识
 * @param {number} [opts.validDays] - 有效期天数（null = 永不过期）
 * @param {string|import('node:crypto').KeyObject} [opts.privateKey] - Ed25519 私钥（v2）
 * @param {string} [opts.secret] - HMAC 密钥（v1 兼容）
 * @returns {string} 激活码
 */
export function createActivateCode({ type, issuer, buyer = '', validDays = null, privateKey, secret }) {
  const tsSec = String(Math.floor(Date.now() / 1000))
  const expSec = validDays
    ? String(Math.floor(Date.now() / 1000) + validDays * 86400)
    : '0' // 0 = 永久

  const buyerB64 = buyer ? Buffer.from(buyer, 'utf-8').toString('base64url') : ''
  const payload = [type, issuer, buyerB64, tsSec, expSec].join(':')

  // 非对称优先（v2）
  if (privateKey) {
    const pk = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey
    const sig = sign(null, Buffer.from(payload, 'utf-8'), pk).toString('hex')
    return `v2:${payload}:${sig}`
  }

  // HMAC 兼容（v1，已废弃）
  if (secret) {
    const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16)
    return `v1:${payload}:${sig}`
  }

  throw new Error('createActivateCode 需要 privateKey（v2 非对称）或 secret（v1 兼容）')
}

/**
 * 由解码结果重算签名载荷（与 createActivateCode 保持对称）。
 * @param {object} decoded decodeActivateCode 的输出
 * @returns {string} 用于签名的规范载荷字符串
 */
function payloadOf(decoded) {
  const buyerB64 = decoded.buyer
    ? Buffer.from(decoded.buyer, 'utf-8').toString('base64url')
    : ''
  const expSec = decoded.exp === null || decoded.exp === '' ? '0' : String(decoded.exp)
  return [decoded.type, decoded.issuer, buyerB64, String(decoded.ts), expSec].join(':')
}

/**
 * 验签激活码。
 *   - v2：用内置/配置公钥做 Ed25519 验签
 *   - v1：用 HMAC（secret || ACTIVATION_HMAC_KEY），仅兼容遗留码
 * @param {object} decoded - decodeActivateCode 的输出
 * @param {string} [secret] - v1 兼容 HMAC 密钥（可选）
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyActivateCode(decoded, secret) {
  if (!decoded || !decoded.version) return { valid: false, reason: '缺少激活码或版本' }

  const payload = payloadOf(decoded)

  if (decoded.version === 'v2') {
    const key = getVerifyKey()
    if (!key) return { valid: false, reason: '未内置验签公钥（激活服务不可用）' }
    let ok = false
    try {
      ok = cryptoVerify(null, Buffer.from(payload, 'utf-8'), key, Buffer.from(decoded.sig, 'hex'))
    } catch { ok = false }
    if (!ok) return { valid: false, reason: '签名不匹配（激活码无效或被篡改）' }
  } else {
    // v1 HMAC 兼容
    const hmacKey = secret || getHmacKey()
    if (!hmacKey) return { valid: false, reason: 'v1 激活码需 ACTIVATION_HMAC_KEY（已废弃，请用 v2）' }
    const expected = createHmac('sha256', hmacKey).update(payload).digest('hex').slice(0, 16)
    if (decoded.sig !== expected) return { valid: false, reason: '签名不匹配（激活码无效或被篡改）' }
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
 * 激活（验证激活码并写入状态）。
 * v2 码无需 secret（用内置公钥）；v1 码可传 secret 兼容。
 * @param {string} code - 激活码
 * @param {string} [secret] - v1 兼容 HMAC 密钥（缺省读 ACTIVATION_HMAC_KEY）
 * @returns {{ success: boolean, tier?: string, buyer?: string, reason?: string }}
 */
export function activate(code, secret) {
  const decoded = decodeActivateCode(code)
  if (!decoded) {
    return { success: false, reason: '激活码格式无效（应形如 v2:type:issuer:buyer:ts:exp:sig）' }
  }

  const verification = verifyActivateCode(decoded, secret)
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

/** 商业授权联系邮箱（未激活引导与 README 共用） */
export const CONTACT_EMAIL = '13546196530@163.com'

/**
 * 生成激活引导信息（未激活时 L1/L2 工具的返回）
 * 始终返回结构化引导，绝不抛错/拒绝加载；L0 不受影响。
 * @param {'l1'|'l2'} level
 * @returns {object} 含 error/action.contact 的引导体
 */
export function buildActivationGuide(level) {
  const layerName = level === 'l1' ? 'L1 (RMxprt)' : 'L2 (Motor-CAD)'
  return {
    status: 'requires_activation',
    error: 'LICENSE_REQUIRED',
    level,
    tool: `motor_${level}_estimate`,
    message: `${layerName} 需要有效授权。当前未检测到许可证。L0 快速筛选不受影响，可继续使用。`,
    action: {
      hint: '如已购买，请在设置中填入激活码，或运行 /dsh-motor-ai-activate <code>。',
      contact: CONTACT_EMAIL,
    },
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
  getVerifyKey,
}
