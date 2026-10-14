/**
 * rc.13 P0-门1 可复现实测探针（full 独立发版线，对齐 l0 v0.5.1 quota_probe）
 * ============================================================================
 * 背景：rc.12 及以前，L0 四个纯函数入口的 assertFreeQuota 不传 config，
 *   motor_l0_pipeline 一次调用扣 3 次（execute enforceQuota 1 次 + pipeline
 *   纯函数无 config 1 次 + buildParamMatrix 1 次）；且纯函数不尊重
 *   freeQuotaEnabled:false，离线批量工具（experience-hub / case-feedback）
 *   每次批量采样都扣用户额度。
 * rc.13 修法（与 l0 v0.5.1 逐字对齐）：
 *   - 四个纯函数入口 assertFreeQuota('<tool>', config) + config 归一化；
 *   - execute 不再 await enforceQuota（await 边界放跑一次性消费标记致双重扣次），
 *     改为捕获 QuotaExceededError 回引导文案；
 *   - assertFreeQuota 尊重 freeQuotaEnabled:false；
 *   - feedback 两个离线批量工具显式 bypass。
 *
 * 断言分组：
 *   A 同一调用链只扣 1 次（一次性消费标记）
 *   B 跨调用链独立计数
 *   C freeQuotaEnabled:false bypass（纯函数入口同样尊重）
 *   D pipeline 一次调用整链只扣 1 次（修复前 = 3 次/次）
 *   E 直调纯函数也计数（防脱闸，fail-closed）
 *   F 用尽抛 QuotaExceededError + 引导文案含联系邮箱与 activate 引导
 *   G 静态：四工具 import/接线 + feedback bypass（防回归）
 *
 * 用法：node scripts/quota_probe_rc13.mjs（沙箱 DSH_HOME，零网络，不碰真实配额）
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// ---- 沙箱隔离：必须在 import quota/license 之前设置 DSH_HOME ----
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-full-quota-probe-'))
process.env.DSH_HOME = sandbox
// 探针零网络依赖：任何 fetch 尝试直接失败（本地为准，不应发请求）
globalThis.fetch = async () => { throw new Error('probe: offline-by-design') }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const _imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href)
const quota = await _imp('lib/quota.mjs')
const { runL0Pipeline } = await _imp('tools/l0/pipeline.mjs')
const { buildParamMatrix } = await _imp('tools/l0/param-matrix.mjs')
const { runL0Estimate } = await _imp('tools/l0/l0-estimate.mjs')
const { runDesignValidate } = await _imp('tools/l0/design-validate.mjs')

const QUOTA_FILE = join(sandbox, 'storages', 'dsh-motor-ai', 'free-quota.json')

function localDayKey() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
function freeCount() {
  try {
    const o = JSON.parse(readFileSync(QUOTA_FILE, 'utf8'))
    return o && o.day === localDayKey() ? (o.free ?? 0) : 0
  } catch {
    return 0
  }
}

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}`) }
}

// 探针入参（小批量，快；write_handoff:false 不落盘）
const SPEC = { power_kw: 15, speed_rpm: 1460, count: 4, top_n: 2, write_handoff: false }

console.log('[A] 同一调用链只扣 1 次（一次性消费标记）')
{
  const before = freeCount()
  const chain = {}
  quota.assertFreeQuota('probe-a1', chain)
  quota.assertFreeQuota('probe-a2', chain) // 同一 config → 不重复扣
  quota.assertFreeQuota('probe-a3', chain)
  ok(freeCount() === before + 1, `同链 3 次调用只扣 1 次（free ${before}→${freeCount()}）`)
}

console.log('[B] 跨调用链独立计数')
{
  const before = freeCount()
  quota.assertFreeQuota('probe-b1', {})
  quota.assertFreeQuota('probe-b2', {})
  ok(freeCount() === before + 2, `两个独立链各扣 1 次（free ${before}→${freeCount()}）`)
}

console.log('[C] freeQuotaEnabled:false bypass（纯函数入口同样尊重）')
{
  const before = freeCount()
  quota.assertFreeQuota('probe-c1', { freeQuotaEnabled: false })
  ok(freeCount() === before, `bypass 不计数（free ${before}→${freeCount()}）`)
  // 离线批量工具同款 bypass 也不计数
  const b2 = freeCount()
  const built = buildParamMatrix({ power_kw: 15, speed_rpm: 1460, count: 2 }, { freeQuotaEnabled: false })
  ok(built?.matrix?.length > 0 && freeCount() === b2, 'buildParamMatrix bypass 可用且不计数')
}

console.log('[D] pipeline 一次调用整链只扣 1 次（修复前 = 3 次/次）')
{
  const before = freeCount()
  const cfg = { handoffDir: join(sandbox, 'handoff') }
  const res = runL0Pipeline(SPEC, cfg)
  const after = freeCount()
  ok(after === before + 1, `pipeline 四层连调只扣 1 次（free ${before}→${after}，修复前应为 +3）`)
  ok(res?.summary?.count_ok === true, 'pipeline 计数自检 count_ok=true（功能未受损）')
}

console.log('[E] 直调纯函数也计数（防脱闸，fail-closed）')
{
  const before = freeCount()
  const built = buildParamMatrix({ power_kw: 15, speed_rpm: 1460, count: 2 }, {})
  const mid = freeCount()
  const val = runDesignValidate({ params_list: built.matrix }, {})
  const est = runL0Estimate({ params_list: built.matrix, top_n: 1 }, {})
  ok(mid === before + 1, `直调 buildParamMatrix 扣 1 次（free ${before}→${mid}）`)
  ok(freeCount() === before + 3, `三个纯函数各自独立链共扣 3 次（free ${before}→${freeCount()}）`)
  ok(Array.isArray(val?.summary ? [1] : []) && est?.results !== undefined, '纯函数功能正常')
}

console.log('[F] 用尽抛 QuotaExceededError + 引导文案')
{
  rmSync(QUOTA_FILE, { force: true }) // 复位当日计数，避免前面用例累积误触顶
  process.env.DSH_FREE_DAILY_LIMIT = '2'
  const c1 = {}, c2 = {}, c3 = {}
  quota.assertFreeQuota('probe-f1', c1)
  quota.assertFreeQuota('probe-f2', c2)
  let threw = null
  try { quota.assertFreeQuota('probe-f3', c3) } catch (e) { threw = e }
  ok(threw instanceof quota.QuotaExceededError, '第 3 次抛 QuotaExceededError（fail-closed）')
  const msg = quota.buildQuotaExceededMessage({ limit: 2, used: 2, tier: 'free' })
  ok(typeof msg === 'string' && msg.includes('13546196530@163.com'), '引导文案含联系邮箱')
  ok(msg.includes('activate') || msg.includes('激活'), '引导文案含激活口令指引')
  delete process.env.DSH_FREE_DAILY_LIMIT
}

console.log('[G] 静态回归：四工具接线 + feedback bypass')
{
  const tools = ['pipeline.mjs', 'param-matrix.mjs', 'design-validate.mjs', 'l0-estimate.mjs']
  let wiring = true
  for (const f of tools) {
    const s = readFileSync(join(ROOT, 'tools', 'l0', f), 'utf8')
    if (!/import\s*\{[^}]*assertFreeQuota[^}]*QuotaExceededError[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/quota\.mjs'/.test(s)) {
      wiring = false; console.log(`    - ${f}: import 形态不符`)
    }
    if (/await\s+enforceQuota\(config\)/.test(s)) { wiring = false; console.log(`    - ${f}: 仍 await enforceQuota`) }
    if (!/err\s+instanceof\s+QuotaExceededError/.test(s)) { wiring = false; console.log(`    - ${f}: 未捕获 QuotaExceededError`) }
    if (!/assertFreeQuota\([^)]*,\s*config\)/.test(s)) { wiring = false; console.log(`    - ${f}: 纯函数未传 config`) }
  }
  ok(wiring, '四工具：import/纯函数传 config/捕获/禁旧写法 全部符合')
  const cf = readFileSync(join(ROOT, 'tools', 'feedback', 'case-feedback.mjs'), 'utf8')
  const eh = readFileSync(join(ROOT, 'tools', 'feedback', 'experience-hub.mjs'), 'utf8')
  ok(/buildParamMatrix\([^)]*freeQuotaEnabled:\s*false/.test(cf), 'case-feedback 离线聚合 bypass')
  ok(/buildParamMatrix\([^)]*freeQuotaEnabled:\s*false/.test(eh) && /runL0Estimate\([^)]*freeQuotaEnabled:\s*false/.test(eh),
    'experience-hub 双调用点 bypass')
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n=== 探针结果: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
