/**
 * 完整版（已激活）每日限额行为回归测试 —— activated-tier-unlimited.test.mjs
 *
 * 业务问题：完整版插件「注册/激活后」，每日 10 次限额是否开放（解除）？
 * 结论（由本测试钉死，防回归）：
 *   - 已激活且未过期（tier !== 'free'）→ assertFreeQuota 直接放行，不限次、不计数、不写 free-quota.json；
 *   - 激活态到期（expiresAt 已过）→ loadActivationState 归 null，回落免费档，重新受 10 次/天硬限；
 *   - tier === 'free' 的激活文件 → 等同未激活，仍受 10 次/天硬限；
 *   - expiresAt / expires_at 两种字段命名均须被识别（防「下划线写文件 → 永不过期」漏洞）。
 *
 * 不依赖后端，用临时 DSH_HOME 隔离 activation.json / free-quota.json。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'activated-tier-'))
process.env.DSH_HOME = TMP // 必须在 import 之前
process.env.DSH_FREE_DAILY_LIMIT = '10'

const tick = () => new Promise((r) => setImmediate(r))
let pass = 0
let fail = 0
function ok(name, cond) {
  if (cond) {
    pass++
    console.log('  ✅', name)
  } else {
    fail++
    console.log('  ❌', name)
  }
}

const quota = await import('../lib/quota.mjs')
const { assertFreeQuota, checkFreeQuota, QuotaExceededError, DEFAULT_FREE_DAILY_LIMIT, DEFAULT_PAID_DAILY_LIMIT } = quota

const STORE = join(TMP, 'storages', 'dsh-motor-ai')
const QUOTA_FILE = join(STORE, 'free-quota.json')
const ACT_FILE = join(STORE, 'activation.json')

function reset() {
  rmSync(QUOTA_FILE, { force: true })
  rmSync(ACT_FILE, { force: true })
}
function writeActivation(obj) {
  mkdirSync(STORE, { recursive: true })
  writeFileSync(ACT_FILE, JSON.stringify(obj))
}
/** 读配额文件：{day, free, paid}（兼容旧格式 {day, used}） */
function readCounts() {
  try {
    const o = JSON.parse(readFileSync(QUOTA_FILE, 'utf-8'))
    return { free: Number(o.free ?? o.used) || 0, paid: Number(o.paid) || 0 }
  } catch {
    return { free: 0, paid: 0 }
  }
}
function isoDelta(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

console.log(`基线：每日上限 = ${DEFAULT_FREE_DAILY_LIMIT}`)

// 1. 已激活（未过期）→ 不限次：连调 30 次（3× 上限）全放行，且完全不计数
console.log('[1] 完整版激活后（tier=full，未过期）不受每日限额约束')
await tick()
reset()
writeActivation({ active: true, tier: 'full', code: 'DM-BNBN-XT3N', expiresAt: isoDelta(+7) })
let blockedAt = 0
for (let i = 1; i <= 30; i++) {
  try {
    assertFreeQuota('full-tier', {}) // 每次新 config → 每次都是独立调用链
  } catch (e) {
    blockedAt = i
    break
  }
}
ok('连调 30 次（3× 免费档上限）全部放行', blockedAt === 0)
{
  const c = readCounts()
  ok('激活态不占用免费档计数（free=0）', c.free === 0)
  ok('激活态计入授权档计数（paid=30）', c.paid === 30)
  ok('30 次远未触顶 9999 硬顶', 30 < DEFAULT_PAID_DAILY_LIMIT)
}
const vFull = await checkFreeQuota({})
ok('checkFreeQuota 返回 reason=activated', vFull.allowed === true && vFull.reason === 'activated')
ok('checkFreeQuota 回显授权档计数与上限', vFull.tier === 'paid' && vFull.limit === DEFAULT_PAID_DAILY_LIMIT)

// 2. 激活态到期 → 回落免费档，重新受 10 次/天硬限
console.log('[2] 激活到期（expiresAt 已过）→ 回落免费档，第 11 次 fail-closed')
await tick()
reset()
writeActivation({ active: true, tier: 'full', code: 'DM-EXPIRED', expiresAt: isoDelta(-1) })
let blockedAt2 = 0
let err2 = null
for (let i = 1; i <= 11; i++) {
  try {
    assertFreeQuota('expired', {})
  } catch (e) {
    blockedAt2 = i
    err2 = e
    break
  }
}
ok('第 11 次被拦截（前 10 次放行）', blockedAt2 === 11)
ok('抛的是 QuotaExceededError', err2 instanceof QuotaExceededError)
ok('到期后开始写 free-quota.json', existsSync(QUOTA_FILE))

// 3. tier=free 的激活文件 → 等同未激活，仍受硬限
console.log('[3] tier=free 的激活态仍受每日限额约束')
await tick()
reset()
writeActivation({ active: true, tier: 'free', code: 'DM-FREE' })
let blockedAt3 = 0
for (let i = 1; i <= 11; i++) {
  try {
    assertFreeQuota('free-tier', {})
  } catch {
    blockedAt3 = i
    break
  }
}
ok('tier=free 第 11 次被拦截', blockedAt3 === 11)

// 4. 字段命名兼容：expires_at（下划线）同样触发到期判定
console.log('[4] expires_at（下划线）同样被识别为到期字段')
await tick()
reset()
writeActivation({ active: true, tier: 'full', expires_at: isoDelta(-1) })
let blockedAt4 = 0
for (let i = 1; i <= 11; i++) {
  try {
    assertFreeQuota('underscore', {})
  } catch {
    blockedAt4 = i
    break
  }
}
ok('下划线 expires_at 过期也能回落免费档（第 11 次拦截）', blockedAt4 === 11)

// 5. 未激活基线：确认免费档就是 10 次（对照组）
console.log('[5] 对照组：未激活免费档 = 10 次/天')
await tick()
reset()
let blockedAt5 = 0
for (let i = 1; i <= 11; i++) {
  try {
    assertFreeQuota('free', {})
  } catch {
    blockedAt5 = i
    break
  }
}
ok('未激活第 11 次被拦截', blockedAt5 === 11)

rmSync(TMP, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
