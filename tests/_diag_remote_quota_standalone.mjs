/**
 * 零依赖诊断脚本 v2（不 import lib/，无源码的机器上也能跑）。
 * 定位「L0 工具点击后计数不入库」根因，完整复刻插件真实运行环境与判定逻辑。
 *
 * 用法：
 *   node _diag_remote_quota_standalone.mjs [--dry] [后端地址]
 *     --dry        只扫描、不发起任何请求（先看环境再决定）
 *     后端地址     缺省依次取：命令行参数 > DSH_BACKEND_URL > http://127.0.0.1:5000
 *
 * v2 修正（相对 v1 的三个错误方向）：
 *   1. 激活文件路径：v1 扫 `~/.dsh/storages/...` 恒缺失；**正确位置是
 *      `%APPDATA%/dsh-desktop/harness/storages/<插件id>/activation.json`**。
 *   2. 安装副本扫描：v1 只找源码目录；DSH 实际用**代际目录**运行插件：
 *      `<harness>/profiles/.generations/live/<插件>+<版本>+<构建哈希>/node_modules/<插件>`，
 *      `profiles/<x>/node_modules/<插件>` 只是指向它的符号链接，活动构建由 desired.json 声明。
 *   3. 判读分支：v1 把「已激活→短路」列为首要根因，但 **l0 包不读激活态**（无 lib/license.mjs），
 *      该分支只在完整版成立；另新增端点缺失盲点（后端返合法 JSON 但无 allowed 字段时，
 *      插件 quota.mjs 一律按 within-quota 放行——端点 404 也看不出来）。
 *
 * ⚠ 非 --dry 时第 [5] 段会真实调用：free 未激活且后端可达 → 今日计数 +1（这正是验证目标）。
 */
import { createHash } from 'node:crypto'
import { hostname, homedir } from 'node:os'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const backendArg = args.find((a) => !a.startsWith('--'))
const backend = String(
  backendArg || process.env.DSH_BACKEND_URL || 'http://127.0.0.1:5000'
).trim().replace(/\/+$/, '')

const PLUGIN_IDS = ['dsh-motor-ai', 'dsh-motor-ai-l0']

/** 定位 harness 根（v1 的最大盲点：DSH 数据不在 ~/.dsh，在 %APPDATA%/dsh-desktop/harness） */
function harnessRoots() {
  const roots = []
  if (process.env.DSH_HOME) roots.push(process.env.DSH_HOME)
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'dsh-desktop', 'harness'))
  roots.push(join(homedir(), '.dsh')) // 兼容旧版/CLI 形态
  return [...new Set(roots)]
}

// ---------- [1] 设备指纹（复刻 lib/license.mjs:86 getDeviceId） ----------
const raw = `${hostname()}|${process.platform}|${process.arch}`
const deviceId = createHash('sha256').update(raw, 'utf-8').digest('hex').slice(0, 16)
console.log('=== [1] 设备指纹 ===')
console.log('hostname  =', hostname())
console.log('raw       =', raw)
console.log('device_id =', deviceId)

// ---------- [2] 安装副本扫描（代际目录 + 符号链接 + desired.json） ----------
console.log('\n=== [2] 安装副本扫描（DSH 代际模型） ===')
const foundBuilds = []
for (const root of harnessRoots()) {
  const live = join(root, 'profiles', '.generations', 'live')
  if (!existsSync(live)) continue
  let entries = []
  try { entries = readdirSync(live) } catch { continue }
  for (const e of entries) {
    if (!PLUGIN_IDS.some((p) => e.startsWith(p + '+'))) continue
    const nm = join(live, e, 'node_modules')
    const pkg = PLUGIN_IDS.map((p) => join(nm, p)).find((p) => existsSync(join(p, 'package.json')))
    if (!pkg) continue
    let ver = '?'
    try { ver = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf-8')).version || '?' } catch { /* ignore */ }
    const mtime = statSync(pkg).mtime.toISOString()
    console.log(`  [代际] ${e}`)
    console.log(`         version=${ver}  quota.mjs=${existsSync(join(pkg, 'lib', 'quota.mjs')) ? '有' : '无'}  license.mjs=${existsSync(join(pkg, 'lib', 'license.mjs')) ? '有(完整版)' : '无(纯 l0)'}`)
    foundBuilds.push({ dir: pkg, gen: e, version: ver, mtime })
  }
  // 符号链接形态
  for (const prof of ['web', 'desktop-safe-mode']) {
    for (const p of PLUGIN_IDS) {
      const link = join(root, 'profiles', prof, 'node_modules', p)
      if (existsSync(link)) console.log(`  [链接] profiles/${prof}/node_modules/${p}`)
    }
  }
  const desired = join(root, 'profiles', 'web', 'desired.json')
  if (existsSync(desired)) {
    try {
      const d = JSON.parse(readFileSync(desired, 'utf-8'))
      const hit = JSON.stringify(d).match(new RegExp(`(${PLUGIN_IDS.join('|')})[^"]*`))?.[0]
      console.log(`  [desired.json] ${hit || '(无 motor 插件声明)'}`)
    } catch { console.log('  [desired.json] 解析失败') }
  }
}
if (foundBuilds.length === 0) console.log('  → 未找到任何安装副本（插件未装 / 已卸载 / harness 路径不同）')

// ---------- [3] 本地激活态（harness storages 优先，~/.dsh 兼容） ----------
console.log('\n=== [3] 本地激活态 ===')
let act = null
let actWhere = ''
for (const root of harnessRoots()) {
  for (const p of PLUGIN_IDS) {
    const fp = join(root, 'storages', p, 'activation.json')
    if (!existsSync(fp)) continue
    console.log(`  [存在] ${fp}`)
    try {
      const s = JSON.parse(readFileSync(fp, 'utf-8'))
      if (!act) { act = s; actWhere = fp }
    } catch (e) { console.log('    解析失败:', e.message) }
  }
}
if (!act) {
  console.log('  → 未找到 activation.json（插件视角：free 未激活，应计数）')
} else {
  const expMs = act.expiresAt ? Date.parse(act.expiresAt) : NaN
  const expired = !Number.isNaN(expMs) && expMs < Date.now()
  console.log(`  内容 = ${JSON.stringify(act)}`)
  console.log(`  来源 = ${actWhere}`)
  if (expired) {
    console.log('  → expiresAt 已过期 → loadActivationState 归 null，插件视角等同 free 未激活')
    act = null
  } else if (act.active === true && act.tier && act.tier !== 'free') {
    console.log(`  → 已激活且 tier=${act.tier}（非 free）：**完整版插件会在此短路，不发请求、不计数**`)
    console.log('     （纯 l0 包无 lib/license.mjs，不读激活态，此分支不成立）')
  }
}

// ---------- [4] usage.jsonl（插件本地调用流水，与服务端计数对账用） ----------
console.log('\n=== [4] usage.jsonl（插件本地调用流水） ===')
let usageFound = false
for (const root of harnessRoots()) {
  for (const p of PLUGIN_IDS) {
    const fp = join(root, 'storages', p, 'usage.jsonl')
    if (!existsSync(fp)) continue
    usageFound = true
    const lines = readFileSync(fp, 'utf-8').trim().split('\n').filter(Boolean)
    const last = lines[lines.length - 1] || ''
    let lastTs = '?'
    let lastTool = '?'
    try { const j = JSON.parse(last); lastTs = j.ts; lastTool = j.tool } catch { /* ignore */ }
    console.log(`  [${p}] ${lines.length} 行，最后一条 ${lastTs} ${lastTool}`)
    console.log(`     判据：此文件有记录而服务端 dsh_free_usage 无记录 ⇒ 必然是 D（不可达）或 E（端点缺失）`)
  }
}
if (!usageFound) console.log('  → 未找到 usage.jsonl（本机从未通过插件跑过 L0 工具，或 storages 路径不同）')

// ---------- [5] 后端连通性 + checkFreeQuota 真实调用 ----------
console.log('\n=== [5] 后端连通性与配额判定 ===')
console.log('backend =', backend)
if (dry) {
  console.log('--dry：跳过请求。去掉 --dry 后本段会真实调用（free 未激活且可达时计数 +1）。')
} else {
  // 先轻量探可达性（不计数）：任何 HTTP 响应都算可达
  let reachable = 'unknown'
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), 4000)
    const r = await fetch(`${backend}/api/status`, { signal: c.signal })
    clearTimeout(t)
    reachable = `可达（HTTP ${r.status}）`
  } catch (e) {
    reachable = `不可达（${String(e?.message || e).slice(0, 80)}）`
  }
  console.log('连通性 =', reachable)

  let verdict
  if (act && act.active === true && act.tier && act.tier !== 'free') {
    verdict = { allowed: true, reason: 'activated', note: '插件不发请求，服务端必然无计数' }
  } else {
    try {
      const c = new AbortController()
      const t = setTimeout(() => c.abort(), 4000)
      const res = await fetch(`${backend}/api/dsh/free-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin_id: 'dsh-motor-ai-l0', device_id: deviceId }),
        signal: c.signal,
      })
      clearTimeout(t)
      const text = await res.text()
      let body = null
      try { body = JSON.parse(text) } catch { /* ignore */ }
      if (!body || typeof body !== 'object') {
        verdict = { allowed: true, reason: 'bad-response-fail-open', httpStatus: res.status, bodyHead: text.slice(0, 120) }
      } else if (body.allowed === false) {
        verdict = { allowed: false, reason: 'quota-exhausted', used: body.used, limit: body.limit, day: body.day }
      } else if (typeof body.allowed !== 'boolean') {
        // 插件盲点：合法 JSON 但无 allowed 字段（如 404 {"error":"not found"}）→ 插件按 within-quota 放行
        verdict = { allowed: true, reason: 'endpoint-missing-or-error', httpStatus: res.status, body }
      } else {
        verdict = { allowed: true, reason: 'within-quota', used: body.used, remaining: body.remaining, limit: body.limit, day: body.day }
      }
    } catch (e) {
      verdict = { allowed: true, reason: 'backend-unreachable-fail-open', error: String(e?.message || e).slice(0, 150) }
    }
  }
  console.log('verdict =', JSON.stringify(verdict))

  console.log('\n--- 根因判读 ---')
  const map = {
    'activated': 'A. 已激活短路（仅完整版成立）：插件不发请求、服务端无计数——设计行为，非 bug',
    'within-quota': `B. 正常计数：used=${verdict.used}/${verdict.limit} → 服务端 dsh_free_usage 应出现 device_id=${deviceId}`,
    'quota-exhausted': `C. 已用尽：${verdict.used}/${verdict.limit}，插件此时应返回「今日免费额度已用尽」拦截`,
    'endpoint-missing-or-error': `E. 端点缺失/错误盲点：HTTP ${verdict.httpStatus} 返回合法 JSON 但无 allowed 字段 ⇒ 插件一律当 within-quota 放行（端点 404 也看不出来）`,
    'bad-response-fail-open': `D'. 响应不可解析 fail-open：HTTP ${verdict.httpStatus}，body=${verdict.bodyHead}`,
    'backend-unreachable-fail-open': 'D. 后端不可达 fail-open：请求没到后端 ⇒ 静默放行、不计数、不报错（用户不可感知）',
  }
  console.log(map[verdict.reason] || verdict.reason)
}
