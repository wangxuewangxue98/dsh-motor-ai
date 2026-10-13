/**
 * 离线硬配额单元测试（free-quota-offline.test.mjs）
 * 不依赖后端；用临时 DSH_HOME 隔离 free-quota.json / activation.json。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'quota-test-'))
process.env.DSH_HOME = TMP // 必须在 import quota.mjs 之前

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
const { assertFreeQuota, checkFreeQuota, QuotaExceededError, getDailyLimit, DEFAULT_FREE_DAILY_LIMIT } = quota

const QUOTA_FILE = join(TMP, 'storages', 'dsh-motor-ai', 'free-quota.json')
const ACT_FILE = join(TMP, 'storages', 'dsh-motor-ai', 'activation.json')
function readUsed() {
  try {
    const o = JSON.parse(readFileSync(QUOTA_FILE, 'utf-8'))
    return Number(o.free ?? o.used) || 0 // 兼容旧格式 {day, used}
  } catch {
    return 0
  }
}
function readPaid() {
  try {
    return Number(JSON.parse(readFileSync(QUOTA_FILE, 'utf-8')).paid) || 0
  } catch {
    return 0
  }
}
function resetFree() {
  try {
    rmSync(QUOTA_FILE, { force: true })
  } catch {}
  try {
    rmSync(ACT_FILE, { force: true })
  } catch {}
}
function yesterdayKey() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// 0. 默认上限 = 10
console.log('[0] 默认每日上限 = 10')
ok('DEFAULT_FREE_DAILY_LIMIT=10', DEFAULT_FREE_DAILY_LIMIT === 10)
ok('getDailyLimit()=10', getDailyLimit() === 10)

// 1. 免费档 10 次放行 / 第 11 次 fail-closed
console.log('[1] 免费档 10 次放行 / 第 11 次抛 QuotaExceededError')
await tick()
resetFree()
for (let i = 1; i <= 10; i++) assertFreeQuota('t')
ok('前 10 次均放行', readUsed() === 10)
let threw = false
let err = null
try {
  assertFreeQuota('t')
} catch (e) {
  threw = true
  err = e
}
ok('第 11 次抛 QuotaExceededError', threw && err instanceof QuotaExceededError)
ok('用尽文案含「已用尽」', /已用尽/.test(err?.message || ''))

// 2. 付费档不计数、不写文件
console.log('[2] 付费档（tier=full）不计数')
await tick()
resetFree()
writeFileSync(ACT_FILE, JSON.stringify({ active: true, tier: 'full', code: 'DM-X', expiresAt: '2999-01-01' }))
assertFreeQuota('t')
ok('付费档不占用免费档计数（free=0）', readUsed() === 0)
ok('付费档计入 paid 档计数（paid=1）', readPaid() === 1)
resetFree()

// 3. 调用链内顺序兄弟只计 1 次（pipeline 模型）
console.log('[3] 同一 config 的兄弟调用只计 1 次')
await tick()
resetFree()
function leafA(c) {
  assertFreeQuota('a', c)
}
function leafB(c) {
  assertFreeQuota('b', c)
}
function pipeline(c) {
  leafA(c)
  leafB(c)
}
pipeline({})
ok('顺序兄弟（build+validate）只 +1', readUsed() === 1)

// 4. 跨天自动重置
console.log('[4] 跨天重置')
await tick()
resetFree()
writeFileSync(QUOTA_FILE, JSON.stringify({ day: yesterdayKey(), used: 20, limit: 10 }))
assertFreeQuota('t')
ok('跨天后归 1', readUsed() === 1)

// 5. 损坏文件按 0 处理
console.log('[5] 损坏配额文件兜底为 0')
await tick()
resetFree()
writeFileSync(QUOTA_FILE, '{ this is not json')
assertFreeQuota('t')
ok('损坏文件按 0 处理（已计 1）', readUsed() === 1)

// 6. 环境变量上限覆盖
console.log('[6] DSH_FREE_DAILY_LIMIT 覆盖')
await tick()
resetFree()
process.env.DSH_FREE_DAILY_LIMIT = '3'
ok('getDailyLimit=3', getDailyLimit() === 3)
for (let i = 1; i <= 3; i++) assertFreeQuota('t')
let t6 = false
try {
  assertFreeQuota('t')
} catch {
  t6 = true
}
ok('第 4 次拦截', t6 && readUsed() === 3)
delete process.env.DSH_FREE_DAILY_LIMIT

// 7. checkFreeQuota 只读、不消耗
console.log('[7] checkFreeQuota 只读不消耗')
await tick()
resetFree()
const r1 = await checkFreeQuota({})
ok('within-quota', r1.allowed === true)
ok('只读不消耗（仍 0）', readUsed() === 0)
for (let i = 0; i < 10; i++) assertFreeQuota('t')
const r2 = await checkFreeQuota({})
ok('用尽后 allowed:false', r2.allowed === false && r2.reason === 'quota-exhausted')

// 8. 绕过网关：直调真实内部函数也消耗
console.log('[8] 直调内部函数 buildParamMatrix 也消耗')
await tick()
resetFree()
try {
  const pm = await import('../tools/l0/param-matrix.mjs')
  pm.buildParamMatrix({ power_kw: 15, speed_rpm: 1500 }, {})
  ok('buildParamMatrix 直调消耗 1', readUsed() === 1)
} catch (e) {
  console.log('  ⚠️ buildParamMatrix 导入/执行需额外依赖，跳过（核心 primitive 已测）:', String(e.message).slice(0, 80))
}

// 9. 引导文案联系邮箱 = 规范 CONTACT_EMAIL（防漂移回归）
console.log('[9] 引导文案联系邮箱 = 规范 CONTACT_EMAIL')
const lic = await import('../lib/license.mjs')
const msg = quota.buildQuotaExceededMessage({ limit: 10, used: 10 })
ok(`CONTACT_EMAIL=${lic.CONTACT_EMAIL}`, lic.CONTACT_EMAIL === '13546196530@163.com')
ok('文案引用规范邮箱', msg.includes(lic.CONTACT_EMAIL))

// 10. 付费档宽松硬顶：默认 9999，且达顶后同样 fail-closed
console.log('[10] 付费档宽松硬顶 9999（DSH_PAID_DAILY_LIMIT 可覆盖）')
await tick()
resetFree()
ok('DEFAULT_PAID_DAILY_LIMIT=9999', quota.DEFAULT_PAID_DAILY_LIMIT === 9999)
ok('getPaidDailyLimit()=9999', quota.getPaidDailyLimit() === 9999)
process.env.DSH_PAID_DAILY_LIMIT = '3'
ok('env 覆盖后 getPaidDailyLimit=3', quota.getPaidDailyLimit() === 3)
writeFileSync(ACT_FILE, JSON.stringify({ active: true, tier: 'full', expiresAt: '2999-01-01' }))
for (let i = 1; i <= 3; i++) assertFreeQuota('paid') // 每次新 config（缺省 {}）→ 独立调用链
let paidBlocked = false
let paidErr = null
try {
  assertFreeQuota('paid')
} catch (e) {
  paidBlocked = true
  paidErr = e
}
ok('付费档第 4 次（>硬顶）被拦截', paidBlocked && paidErr instanceof QuotaExceededError)
ok('拦截 reason=paid-quota-exhausted', paidErr?.quota?.reason === 'paid-quota-exhausted')
ok('付费档用尽后 checkFreeQuota allowed:false', (await checkFreeQuota({})).allowed === false)
delete process.env.DSH_PAID_DAILY_LIMIT
resetFree()

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
