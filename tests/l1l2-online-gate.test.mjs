/**
 * B 方案在线门控引擎测试（getL1L2License）。
 * 桩 globalThis.fetch 模拟后端 /api/dsh/verify，覆盖 7 场景：
 *   1. 无本地态          → 拒（no_local_license）
 *   2. 在线 valid 刷新   → 放行 + 取 max 到期日
 *   3. 在线 revoked      → 拒 + 作废本地态
 *   4. 在线不可达+软门控  → 放行离线宽限（stale）
 *   5. 在线不可达+硬门控  → 拒（offline_rejected）
 *   6. 在线态本地已过期   → 拒（expired，不发起网络）
 *   7. 离线 v2 码态      → 按本地快照放行（honor-system）
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import assert from 'node:assert'

const __dirname = dirname(fileURLToPath(import.meta.url))
const lic = await import(pathToFileURL(join(__dirname, '..', 'lib', 'license.mjs')).href)

// 隔离激活落盘，避免污染真实 $DSH_HOME
process.env.DSH_HOME = join(tmpdir(), `dsh-gate-test-${Date.now()}`)

const now = Date.now()
const future = new Date(now + 365 * 86400 * 1000).toISOString()
const past = new Date(now - 86400 * 1000).toISOString()
const future2 = new Date(now + 730 * 86400 * 1000).toISOString()

// ---- fetch 桩：可控行为 + 记录调用 ----
let fetchImpl = async () => ({ ok: true, json: async () => ({}) })
let fetchCalls = 0
globalThis.fetch = async (...args) => { fetchCalls++; return fetchImpl(...args) }

function setOk(valid, extra = {}) {
  fetchImpl = async () => ({ ok: true, json: async () => ({ valid, ...extra }) })
}
function setThrow() {
  fetchImpl = async () => { throw new Error('ECONNREFUSED') }
}

let pass = 0
let fail = 0
async function check(name, fn) {
  try { await fn(); pass++; console.log('  PASS', name) }
  catch (e) { fail++; console.error('  FAIL', name, '::', e.message) }
}

// 1. 无本地态
await check('1. 无本地态 → no_local_license', async () => {
  const r = await lic.getL1L2License('l1')
  assert.strictEqual(r.authorized, false)
  assert.strictEqual(r.reason, 'no_local_license')
})

// 2. 在线 valid 刷新（取 max 到期日）
await check('2. 在线 valid → 放行 + 取 max 到期日', async () => {
  lic.saveActivationState({ active: true, tier: 'full', source: 'online',
    code: 'DM-AAAA-BBBB', deviceId: 'dev1', expiresAt: future })
  fetchCalls = 0
  setOk(true, { expires_at: future2 }) // 后端给更晚到期日
  const r = await lic.getL1L2License('l1')
  assert.strictEqual(r.authorized, true)
  assert.strictEqual(r.source, 'online')
  assert.strictEqual(r.stale, undefined)
  assert.strictEqual(r.expiresAt, future2, '应取 max 更晚到期日')
  assert.strictEqual(fetchCalls, 1)
})

// 3. 在线 revoked → 拒 + 作废本地态
await check('3. 在线 revoked → 拒 + 作废本地态', async () => {
  lic.saveActivationState({ active: true, tier: 'full', source: 'online',
    code: 'DM-CCCC-DDDD', deviceId: 'dev1', expiresAt: future })
  setOk(false, { reason: 'revoked' })
  const r = await lic.getL1L2License('l2')
  assert.strictEqual(r.authorized, false)
  assert.strictEqual(r.reason, 'revoked')
  // 本地态被作废
  const st = lic.loadActivationState()
  assert.strictEqual(st, null, '本地态应被作废（load 返回 null）')
})

// 4. 在线不可达 + 软门控 → 放行离线宽限
await check('4. 不可达 + 软门控 → stale 放行', async () => {
  lic.saveActivationState({ active: true, tier: 'full', source: 'online',
    code: 'DM-EEEE-FFFF', deviceId: 'dev1', expiresAt: future })
  setThrow()
  const r = await lic.getL1L2License('l1')
  assert.strictEqual(r.authorized, true)
  assert.strictEqual(r.stale, true)
  assert.strictEqual(r.reason, 'offline_grace')
})

// 5. 在线不可达 + 硬门控 → 拒
await check('5. 不可达 + 硬门控 → offline_rejected', async () => {
  lic.saveActivationState({ active: true, tier: 'full', source: 'online',
    code: 'DM-GGGG-HHHH', deviceId: 'dev1', expiresAt: future })
  setThrow()
  const r = await lic.getL1L2License('l1', { hardOffline: true })
  assert.strictEqual(r.authorized, false)
  assert.strictEqual(r.reason, 'offline_rejected')
})

// 6. 在线态本地已过期 → 拒（不发起网络）
await check('6. 在线态已过期 → expired（不发起网络）', async () => {
  lic.saveActivationState({ active: true, tier: 'full', source: 'online',
    code: 'DM-IIII-JJJJ', deviceId: 'dev1', expiresAt: past })
  fetchCalls = 0
  setOk(true)
  const r = await lic.getL1L2License('l1')
  assert.strictEqual(r.authorized, false)
  assert.strictEqual(r.reason, 'expired')
  assert.strictEqual(fetchCalls, 0, '本地到期日命中即拒，不发网络')
})

// 7. 离线 v2 码态 → 按本地快照放行（honor-system，不发网络）
await check('7. 离线 v2 态 → 快照放行', async () => {
  lic.saveActivationState({ active: true, tier: 'l2', source: 'offline',
    keyId: 'default', expiresAt: null, code: null })
  fetchCalls = 0
  setOk(true)
  const r = await lic.getL1L2License('l2')
  assert.strictEqual(r.authorized, true)
  assert.strictEqual(r.source, 'offline')
  assert.strictEqual(r.stale, undefined)
  assert.strictEqual(fetchCalls, 0, '离线态不触发在线 refresh')
})

console.log(`\nl1l2-online-gate: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
