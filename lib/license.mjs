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

import { createHmac, createPublicKey, createPrivateKey, sign, verify as cryptoVerify, createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, hostname } from 'node:os'

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
// 设备指纹 + 服务端口令（DM-XXXX-XXXX）形态
// ============================================================

/**
 * 设备指纹（不可逆）：sha256(hostname|platform|arch) 前 16 hex。
 * 仅用于服务端口令的「设备绑定 / 解绑 / 吊销」闭环，
 * 不进入遥测白名单（lib/telemetry.mjs 明确 client_id 不外发）。
 * @returns {string}
 */
export function getDeviceId() {
  try {
    const raw = `${hostname()}|${process.platform}|${process.arch}`
    return createHash('sha256').update(raw, 'utf-8').digest('hex').slice(0, 16)
  } catch {
    return 'unknown-device'
  }
}

/** 服务端口令形态：`DM-XXXX-XXXX`（大写、易读字符集，无易混 0/O/1/I/L） */
const ONLINE_PASSCODE_RE = /^DM-[A-Z0-9]{4}-[A-Z0-9]{4}$/

/** 判断是否为「服务端口令」（走后端在线验证，区别于离线 v2 非对称码） */
export function isOnlinePasscode(code) {
  return typeof code === 'string' && ONLINE_PASSCODE_RE.test(code.trim().toUpperCase())
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

    // 在线激活（服务端口令）到期判定：过期即视为未激活（需重新 verify 续期）
    // 兼容两种字段命名：后端/早期版本可能写 expires_at（下划线），本文统一按 expiresAt 语义处理
    const expRaw = state.expiresAt ?? state.expires_at
    if (expRaw) {
      const expMs = Date.parse(expRaw)
      if (!isNaN(expMs) && expMs < Date.now()) return null
    }

    return {
      active: true,
      tier: state.tier,
      activatedAt: state.activatedAt || new Date().toISOString(),
      buyer: state.buyer || '',
      keyId: state.keyId || DEFAULT_KEY_ID,
      expiresAt: state.expiresAt || null,
      source: state.source || 'offline',
      deviceId: state.deviceId || null,
      plan: state.plan || null,
      mode: state.mode || 'commercial',
      maxWorkspaces: state.maxWorkspaces ?? null,
      jti: state.jti || null,
      // 在线态存原始 DM 码，供 getL1L2License 后续 refresh 重打 /api/dsh/verify 做吊销感知
      code: state.code || null,
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
      // 在线激活（服务端口令）写入到期时间与来源，供本地离线续期判定
      expiresAt: state.expiresAt || null,
      source: state.source || 'offline',
      deviceId: state.deviceId || null,
      // §3.1.4 License Token 持久化字段（计费档位 / 模式 / 工作区上限 / 可吊销 jti）
      plan: state.plan || null,
      mode: state.mode || 'commercial',
      maxWorkspaces: state.maxWorkspaces ?? null,
      jti: state.jti || null,
      // 在线态原始 DM 码（getL1L2License refresh 重验需要；离线/v2 态为 null）
      code: state.code || null,
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
 * 在线激活（服务端口令 DM-XXXX-XXXX）。
 * 向后端 POST /api/dsh/verify 校验；成功即写入本地授权态（tier=full + 到期时间）。
 * 后端已实现的闭环（Core/dsh_registry.py:verify_passcode）：绑定设备、起算到期、
 * 吊销、解绑——本函数只负责「校验→落盘」，不重复实现商业控制。
 *
 * @param {string} code - DM-XXXX-XXXX 服务端口令
 * @param {object} [opts]
 * @param {string} [opts.backendUrl] - 后端基址（优先级高于 env DSH_BACKEND_URL），如 http://127.0.0.1:5000
 * @param {string} [opts.deviceId] - 设备指纹（缺省自动 getDeviceId()）
 * @param {string} [opts.buyer] - 购买者标识
 * @returns {Promise<{ success: boolean, tier?: string, buyer?: string, expiresAt?: string, plan?: string, daysLeft?: number, reason?: string, offline?: boolean }>}
 */
export async function activateOnline(code, opts = {}) {
  const onlineCode = String(code || '').trim().toUpperCase()
  if (!isOnlinePasscode(onlineCode)) {
    return { success: false, reason: '不是服务端口令（应为 DM-XXXX-XXXX 形态，离线码请使用 v2:...）' }
  }

  const deviceId = (opts.deviceId && String(opts.deviceId)) || getDeviceId()

  // 在线 re-verify（抽取为 verifyOnline，B 方案 getL1L2License 复用同一契约，避免两处漂移）
  let v
  try {
    v = await verifyOnline(onlineCode, deviceId, { backendUrl: opts.backendUrl })
  } catch (err) {
    return {
      success: false,
      offline: true,
      reason: `联网验证失败（${String(err?.message || err).slice(0, 80)}）；请检查网络后重试，或改用离线激活码 v2:...`,
    }
  }

  if (!v.valid) {
    const reasonMap = {
      not_found: '口令不存在（可能尚未发行或已输错）',
      revoked: '该口令已被吊销（请联系作者）',
      expired: '口令已过期',
      device_mismatch: '该口令已绑定其他设备；如需换机请联系作者解绑',
      bad_request: '请求格式错误（缺少 code / device_id）',
    }
    return { success: false, reason: reasonMap[v.reason] || `验证未通过: ${v.reason}` }
  }

  // 验证通过：在线口令统一解锁完整版（full）。写入到期时间供本地续期判定。
  // 续费语义（决策③：取 max）——新码到期更早时保留原到期日，
  // 否则「年付未到期又买了月付」会把已购时长反向缩短，属必须杜绝的体验事故。
  const prevState = loadActivationState() || {}
  const prevExp = prevState.expiresAt || null
  const newExp = v.expires_at || null
  let mergedExp = newExp
  if (prevExp && newExp) {
    const tp = Date.parse(prevExp)
    const tn = Date.parse(newExp)
    if (!Number.isNaN(tp) && !Number.isNaN(tn) && tp > tn) mergedExp = prevExp
  } else if (prevExp && !newExp) {
    mergedExp = prevExp
  }

  const state = {
    active: true,
    tier: 'full',
    buyer: opts.buyer || 'online',
    keyId: 'online',
    source: 'online',
    expiresAt: mergedExp,
    deviceId,
    // 存原始 DM 码：B 方案在线门控（getL1L2License）后续 refresh 重验的凭据
    code: onlineCode,
  }
  const ok = saveActivationState(state)
  if (!ok) return { success: false, reason: '激活状态写入失败（可能无写入权限）' }

  return {
    success: true,
    tier: 'full',
    buyer: state.buyer,
    expiresAt: state.expiresAt,
    plan: v.plan ?? null,
    daysLeft: v.days_left ?? null,
  }
}

/**
 * 统一激活入口：自动按码形态分流。
 *   - DM-XXXX-XXXX → 在线验证（activateOnline）
 *   - v1/v2:...    → 离线验签（activate）
 * @param {string} code
 * @param {object} [opts] - 透传给 activateOnline / activate
 * @returns {Promise<object>}
 */
export async function activateFlex(code, opts = {}) {
  if (isOnlinePasscode(code)) return activateOnline(code, opts)
  if (isLicenseToken(code)) return activateLicenseToken(code, opts)
  return activate(code, opts.secret)
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

// ============================================================
// B 方案：在线门控引擎（后端权威态 + 本地离线宽限）
// ============================================================

/** 纯函数：给定 capability tier 是否放行某 level（l0 恒放行）。 */
export function tierAllows(tier, level) {
  if (level === 'l0') return true
  if (level === 'l1') return tier === 'l1' || tier === 'l2' || tier === 'full'
  if (level === 'l2') return tier === 'l2' || tier === 'full'
  return false
}

/**
 * 在线 re-verify（B 方案核心）：重打 /api/dsh/verify 取后端权威态。
 * 契约与 activateOnline 内的 fetch 一致（POST {code, device_id} → {valid, reason, expires_at}）。
 * 网络不可达时抛错，由调用方（getL1L2License）按软/硬门控兜底。
 * @param {string} code - 在线 DM 码（原样，内部归一化大写）
 * @param {string} [deviceId] - 设备指纹（缺省 getDeviceId()）
 * @param {object} [opts]
 * @param {string} [opts.backendUrl] - 后端基址（优先于 DSH_BACKEND_URL）
 * @returns {Promise<{ valid: boolean, reason?: string, expires_at?: string|null, plan?: string|null, days_left?: number|null }>}
 */
export async function verifyOnline(code, deviceId, opts = {}) {
  const base = String(opts.backendUrl || process.env.DSH_BACKEND_URL || 'http://127.0.0.1:5000')
    .trim().replace(/\/+$/, '')
  const url = `${base}/api/dsh/verify`
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), 8000) : null
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: String(code || '').trim().toUpperCase(),
        device_id: deviceId || getDeviceId(),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
  let body
  try { body = await res.json() } catch { body = null }
  if (!body || body.valid !== true) {
    return { valid: false, reason: body?.reason || 'verify_failed' }
  }
  return {
    valid: true,
    reason: '',
    expires_at: body.expires_at || null,
    plan: body.plan || null,
    days_left: body.days_left ?? null,
  }
}

/**
 * B 方案在线门控引擎：判定 L1/L2 是否放行，以后端在线态为准（可吊销/到期回落），
 * 本地快照作离线宽限基线。这是把「放行判断」从本地文件上移到「本地 + 后端在线」的落点。
 *
 * 决策顺序：
 *   1. 无本地激活态            → 拒（no_local_license）
 *   2. 本地 tier 低于 level    → 拒（tier_below_x）
 *   3. 在线态（source=online 且存了 code）：
 *        a. 本地到期日已过期    → 拒（expired）
 *        b. 在线 refresh：valid → 刷新到期日放行；revoked/expired/... → 作废本地态并拒
 *        c. 网络不可达         → 软门控（默认）放行离线宽限态(stale)；硬门控(hardOffline)拒
 *   4. 离线 v2/v1 码          → 无法在线吊销，按本地快照放行（honor-system，到期日在 loadActivationState 已校验）
 *
 * @param {'l1'|'l2'} level
 * @param {object} [opts]
 * @param {boolean} [opts.hardOffline=false] - 后端不可达时是否硬拒绝（默认软门控放行离线宽限）
 * @param {string}  [opts.backendUrl]        - 后端基址（优先于 DSH_BACKEND_URL）
 * @returns {Promise<{ authorized: boolean, tier?: string, source?: string, stale?: boolean, reason?: string, expiresAt?: string|null }>}
 */
/**
 * 读原始激活快照（不做「过期→null」过滤）。
 * 用于 getL1L2License 区分「从未激活」(no_local_license) 与「已过期」(expired)——
 * loadActivationState 会把过期态直接归 null，使引擎无法给出 expired 语义。
 * @returns {{active: boolean, tier: string, source?: string, expiresAt?: string|null, code?: string|null, deviceId?: string|null} | null}
 */
function readActivationSnapshot() {
  try {
    const fp = getActivationFilePath()
    if (!existsSync(fp)) return null
    const state = JSON.parse(readFileSync(fp, 'utf-8'))
    if (!state || typeof state !== 'object') return null
    return {
      active: !!state.active,
      tier: state.tier || 'free',
      source: state.source || 'offline',
      expiresAt: state.expiresAt || null,
      code: state.code || null,
      deviceId: state.deviceId || null,
    }
  } catch {
    return null
  }
}

export async function getL1L2License(level, opts = {}) {
  const { hardOffline = false, backendUrl } = opts
  const snap = readActivationSnapshot()
  if (!snap || !snap.active) {
    return { authorized: false, reason: 'no_local_license' }
  }
  if (!tierAllows(snap.tier, level)) {
    return { authorized: false, reason: `tier_below_${level}`, tier: snap.tier }
  }

  // 在线态（DM 码）：可被后端吊销 / 到期回落
  if (snap.source === 'online' && snap.code) {
    if (snap.expiresAt) {
      const expMs = Date.parse(snap.expiresAt)
      if (!isNaN(expMs) && expMs < Date.now()) {
        // 在线态到期：本地快照已不可用，要求重新 verify（续期）
        return { authorized: false, reason: 'expired', tier: snap.tier, expiresAt: snap.expiresAt }
      }
    }
    try {
      const v = await verifyOnline(snap.code, snap.deviceId, { backendUrl })
      if (v.valid) {
        const merged = laterExpiry(snap.expiresAt, v.expires_at)
        if (merged !== snap.expiresAt) saveActivationState({ ...snap, expiresAt: merged, active: true })
        return { authorized: true, tier: snap.tier, source: 'online',
                 expiresAt: merged ?? snap.expiresAt }
      }
      // 后端明确拒绝（revoked / expired / device_mismatch / not_found）→ 作废本地态
      saveActivationState({ ...snap, active: false })
      return { authorized: false, reason: v.reason, tier: snap.tier }
    } catch {
      // 网络不可达：软门控（默认）放行离线宽限态；硬门控拒绝
      if (hardOffline) {
        return { authorized: false, reason: 'offline_rejected', tier: snap.tier }
      }
      return { authorized: true, stale: true, source: 'online',
               reason: 'offline_grace', tier: snap.tier, expiresAt: snap.expiresAt }
    }
  }

  // 离线 v2/v1 码：无法在线吊销，按本地快照放行（到期日由 loadActivationState 语义，非在线态不受 refresh）
  return { authorized: true, tier: snap.tier, source: snap.source || 'offline' }
}

/** 商业授权联系邮箱（未激活引导与 README 共用） */
/**
 * 取两个 ISO 到期时间中更晚的一个（续费取 max 的可单测版本）。
 * 任一侧缺失/不可解析时返回另一侧；都不可用返回 null。
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {string|null}
 */
export function laterExpiry(a, b) {
  const ta = a ? Date.parse(a) : NaN
  const tb = b ? Date.parse(b) : NaN
  if (Number.isNaN(ta) && Number.isNaN(tb)) return null
  if (Number.isNaN(ta)) return b || null
  if (Number.isNaN(tb)) return a || null
  return tb > ta ? b : a
}

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
// §3.1.4 License Token（JWT 式，金数据 Webhook 签发 → 客户端离线验签）
// ============================================================
//
// 与方案 §3.1.4 / §4.1 对齐：金数据支付成功页交付的「口令」即本 Token，
// 由 Webhook 后端调 dshhub.co API 生成（或预置口令池），客户端用内置公钥离线验签。
//
// Token 形态：base64url(header).base64url(payload).base64url(signature)
//   签名：Ed25519（与 v2 激活码同一密钥对；公钥见 BUILTIN_PUBLIC_KEY_PEM）
//         HMAC-SHA256（带 salt，兼容备选）
// 载荷 claims（方案 §3.1.4）：
//   { mode:'commercial', tier:'monthly'|'quarterly'|'semiannual'|'annual',
//     expiresAt:'ISO', maxWorkspaces:1, issuedAt:'ISO', jti:'uuid' }
//
// ⚠ 语义轴澄清：claims.tier = 计费档位（时长），与激活态 capability tier
// （free|l1|l2|full）是两条轴。License Token 一律解锁商业全功能（tier='full'），
// 计费档位存于 state.plan；时长以 claims.expiresAt 为准（从首次激活起算，非购买日）。

/** 计费档位 → 时长天（供 Webhook 后端签发时计算 expiresAt；客户端以 token.expiresAt 为准） */
export const LICENSE_TOKEN_TIERS = {
  monthly:     { label: '月付', days: 30 },
  quarterly:   { label: '季付', days: 90 },
  semiannual: { label: '半年', days: 180 },
  annual:      { label: '年付', days: 365 },
}

const LICENSE_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** 判断是否为 §3.1.4 License Token（JWT 三段式，区别于 v2:... 与 DM-XXXX-XXXX） */
export function isLicenseToken(token) {
  return typeof token === 'string' && LICENSE_TOKEN_RE.test(token.trim())
}

function b64urlEncodeJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url')
}
function b64urlDecodeJson(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf-8'))
}

/**
 * 签发 License Token（服务端用，需私钥/HMAC 密钥）。
 * @param {object} claims - 至少含 tier / expiresAt / jti（缺省自动补）
 * @param {object} [opts]
 * @param {string|import('node:crypto').KeyObject} [opts.privateKey] - Ed25519 私钥（推荐）
 * @param {string} [opts.hmacKey] - HMAC 密钥（兼容备选）
 * @returns {string} JWT 式 token
 */
export function createLicenseToken(claims, opts = {}) {
  const header = { alg: opts.hmacKey ? 'HS256' : 'EdDSA', typ: 'JWT' }
  const payload = {
    mode: claims.mode || 'commercial',
    tier: claims.tier || 'annual',
    issuedAt: claims.issuedAt || new Date().toISOString(),
    expiresAt: claims.expiresAt || null,
    maxWorkspaces: claims.maxWorkspaces ?? 1,
    jti: claims.jti || randomUUID(),
  }
  const signingInput = `${b64urlEncodeJson(header)}.${b64urlEncodeJson(payload)}`
  let sig
  if (opts.hmacKey) {
    sig = createHmac('sha256', opts.hmacKey).update(signingInput).digest('base64url')
  } else {
    const pk = typeof opts.privateKey === 'string' ? createPrivateKey(opts.privateKey) : opts.privateKey
    if (!pk) throw new Error('createLicenseToken 需 privateKey（EdDSA）或 hmacKey')
    sig = sign(null, Buffer.from(signingInput, 'utf-8'), pk).toString('base64url')
  }
  return `${signingInput}.${sig}`
}

/**
 * 解析 License Token（不验签）。
 * @returns {{ header: object, payload: object, signature: string, raw: string } | null}
 */
export function decodeLicenseToken(token) {
  if (typeof token !== 'string') return null
  const parts = token.trim().split('.')
  if (parts.length !== 3) return null
  try {
    return {
      header: b64urlDecodeJson(parts[0]),
      payload: b64urlDecodeJson(parts[1]),
      signature: parts[2],
      raw: token.trim(),
    }
  } catch {
    return null
  }
}

/** 吊销表文件路径（§3.1.4：退款订单 jti 离线维护本地清单） */
export function getRevocationFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-motor-ai', 'revoked.json')
}

/**
 * 判断 jti 是否已吊销（§3.1.4 退款吊销表机制）。
 * 优先级：opts.revokedJtis（Webhook 后端回拉）> env DSH_REVOKED_JTIS > 本地 revoked.json。
 * 本地清单读取失败不阻塞（视作未吊销）。
 * @param {string} jti
 * @param {object} [opts]
 * @param {string[]} [opts.revokedJtis]
 * @returns {boolean}
 */
export function isJtiRevoked(jti, opts = {}) {
  if (!jti) return false
  if (Array.isArray(opts.revokedJtis) && opts.revokedJtis.includes(jti)) return true
  if (process.env.DSH_REVOKED_JTIS) {
    const set = process.env.DSH_REVOKED_JTIS.split(',').map((s) => s.trim()).filter(Boolean)
    if (set.includes(jti)) return true
  }
  try {
    const fp = getRevocationFilePath()
    if (existsSync(fp)) {
      const arr = JSON.parse(readFileSync(fp, 'utf-8'))
      if (Array.isArray(arr) && arr.includes(jti)) return true
    }
  } catch { /* 离线清单读取失败不阻塞 */ }
  return false
}

/**
 * 验签 License Token（§3.1.4 / §4.1）。
 * @param {object} decoded - decodeLicenseToken 输出
 * @param {object} [opts]
 * @param {string} [opts.hmacKey] - HMAC 验签密钥（HS256 时用）
 * @param {string[]} [opts.revokedJtis] - 吊销 jti 集合
 * @returns {{ valid: boolean, mode: 'trial'|'commercial'|'none', tier?: string, expiresAt?: string|null, reason?: string, jti?: string }}
 */
export function verifyLicenseToken(decoded, opts = {}) {
  if (!decoded || !decoded.header || !decoded.payload) {
    return { valid: false, mode: 'none', reason: '非 License Token' }
  }
  const payload = decoded.payload
  const signingInput = `${b64urlEncodeJson(decoded.header)}.${b64urlEncodeJson(payload)}`

  let ok = false
  try {
    if (decoded.header.alg === 'HS256') {
      const key = opts.hmacKey || getHmacKey()
      if (!key) return { valid: false, mode: 'none', reason: 'HMAC 验签缺密钥' }
      const expected = createHmac('sha256', key).update(signingInput).digest('base64url')
      ok = expected === decoded.signature
    } else {
      const key = getVerifyKey()
      if (!key) return { valid: false, mode: 'none', reason: '未内置 Ed25519 公钥（激活服务不可用）' }
      ok = cryptoVerify(null, Buffer.from(signingInput, 'utf-8'), key, Buffer.from(decoded.signature, 'base64url'))
    }
  } catch { ok = false }

  if (!ok) return { valid: false, mode: 'none', reason: '签名不匹配（口令被篡改或签发者不符）' }

  const mode = payload.mode === 'commercial' ? 'commercial' : 'trial'

  if (payload.expiresAt) {
    const expMs = Date.parse(payload.expiresAt)
    if (!Number.isNaN(expMs) && expMs < Date.now()) {
      return { valid: false, mode: 'none', reason: '口令已过期', expiresAt: payload.expiresAt }
    }
  }

  if (isJtiRevoked(payload.jti, opts)) {
    return { valid: false, mode: 'none', reason: '口令已被吊销（退款/违规）', jti: payload.jti }
  }

  return {
    valid: true,
    mode,
    tier: payload.tier || 'annual',
    expiresAt: payload.expiresAt || null,
    maxWorkspaces: payload.maxWorkspaces ?? 1,
    jti: payload.jti || null,
  }
}

/**
 * §4.1 统一验签入口：识别 §3.1.4 License Token（JWT 三段式）并验签。
 * 非 JWT 形态（v2:... 离线码 / DM-XXXX-XXXX 在线码）不在此处理，交由 activateFlex 分流。
 * @param {string} token
 * @param {object} [opts] - 透传 verifyLicenseToken 的 hmacKey / revokedJtis
 * @returns {{ valid: boolean, mode: 'trial'|'commercial'|'none', tier?: string, expiresAt?: string|null, reason?: string }}
 */
export function verifyLicense(token, opts = {}) {
  if (isLicenseToken(token)) {
    const decoded = decodeLicenseToken(token)
    if (!decoded) return { valid: false, mode: 'none', reason: 'License Token 解析失败' }
    return verifyLicenseToken(decoded, opts)
  }
  return {
    valid: false,
    mode: 'none',
    reason: '未知 token 形态（License Token 应为 JWT 三段式；离线码请用 v2:...，在线码 DM-XXXX-XXXX）',
  }
}

/**
 * 激活 License Token：验签 → 持久化商业全功能态。
 * tier（计费档位）存于 state.plan；capability tier 恒为 'full'；时长以 token.expiresAt 为准。
 * @param {string} token
 * @param {object} [opts]
 * @param {string} [opts.buyer]
 * @param {string} [opts.deviceId]
 * @param {string[]} [opts.revokedJtis]
 * @returns {Promise<{ success: boolean, tier?: string, plan?: string, mode?: string, expiresAt?: string|null, jti?: string, reason?: string }>}
 */
export async function activateLicenseToken(token, opts = {}) {
  const decoded = decodeLicenseToken(token)
  if (!decoded) return { success: false, reason: 'License Token 解析失败' }
  const v = verifyLicenseToken(decoded, opts)
  if (!v.valid) return { success: false, reason: v.reason }

  const state = {
    active: true,
    tier: 'full', // 商业全功能（capability 轴）
    plan: v.tier, // 计费档位（monthly/quarterly/semiannual/annual）
    mode: v.mode,
    buyer: opts.buyer || 'license-token',
    keyId: 'license-token',
    source: 'license-token',
    expiresAt: v.expiresAt, // 从首次激活起算（与方案 §3.1.1 一致）
    maxWorkspaces: v.maxWorkspaces,
    jti: v.jti,
    deviceId: opts.deviceId ? String(opts.deviceId) : null,
  }
  const ok = saveActivationState(state)
  if (!ok) return { success: false, reason: '激活状态写入失败（可能无写入权限）' }
  return { success: true, tier: 'full', plan: v.tier, mode: v.mode, expiresAt: v.expiresAt, jti: v.jti }
}

// ============================================================
// 导出
// ============================================================
export default {
  // 编码/解码
  createActivateCode,
  decodeActivateCode,
  verifyActivateCode,
  laterExpiry,
  // 持久化
  loadActivationState,
  saveActivationState,
  getActivationFilePath,
  // 公共 API
  activate,
  activateFlex,
  activateOnline,
  isOnlinePasscode,
  getDeviceId,
  queryActivation,
  isLevelAllowed,
  // B 方案：在线门控引擎（后端权威态 + 本地离线宽限）
  tierAllows,
  verifyOnline,
  getL1L2License,
  // 辅助
  buildActivationGuide,
  getHmacKey,
  getVerifyKey,
  // §3.1.4 License Token（JWT 式）/ §4.1
  LICENSE_TOKEN_TIERS,
  isLicenseToken,
  createLicenseToken,
  decodeLicenseToken,
  verifyLicenseToken,
  verifyLicense,
  activateLicenseToken,
  isJtiRevoked,
  getRevocationFilePath,
}
