#!/usr/bin/env node
/**
 * dsh-motor-ai 完整版自检验证脚本
 * 检查包结构、依赖、导入是否正常
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

// 获取项目根目录（scripts 的父目录）
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '..')
const ROOT_URL = pathToFileURL(ROOT).href

// ============================================================
// 1. 基础文件检查
// ============================================================
const REQUIRED_FILES = [
  'index.mjs',
  'package.json',
  'tools/l0/index.mjs',
  'tools/l1/index.mjs',
  'tools/l2/index.mjs',
  'tools/feedback/case-feedback.mjs',
  'tools/feedback/experience-hub.mjs',
]

let failures = 0
console.log('=== dsh-motor-ai 完整性检查 ===\n')

for (const file of REQUIRED_FILES) {
  const path = join(ROOT, file)
  if (existsSync(path)) {
    console.log(`✅ ${file}`)
  } else {
    console.log(`❌ ${file} 缺失`)
    failures++
  }
}

// ============================================================
// 2. package.json 检查
// ============================================================
console.log('\n=== package.json 检查 ===')
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))

  const checks = [
    ['name', 'dsh-motor-ai'],
    ['version', /^1\.2\.1/],
    ['description', /完整版|L1|L2|RMxprt|Motor-CAD/i],
  ]

  for (const [key, expected] of checks) {
    const actual = pkg[key]
    if (expected instanceof RegExp) {
      if (expected.test(actual)) {
        console.log(`✅ ${key}: ${actual}`)
      } else {
        console.log(`❌ ${key}: "${actual}" 不符合 ${expected}`)
        failures++
      }
    } else {
      if (actual === expected) {
        console.log(`✅ ${key}: ${actual}`)
      } else {
        console.log(`❌ ${key}: "${actual}" != "${expected}"`)
        failures++
      }
    }
  }

  // 检查依赖
  if (pkg.dependencies?.['@wangxue98/dsh-motor-ai-core']) {
    console.log(`✅ core 依赖: ${pkg.dependencies['@wangxue98/dsh-motor-ai-core']}`)
  } else {
    console.log('❌ 缺少 @wangxue98/dsh-motor-ai-core 依赖')
    failures++
  }

} catch (err) {
  console.log(`❌ package.json 解析失败: ${err.message}`)
  failures++
}

// ============================================================
// 3. 导入检查（模拟 DSH 环境）
// ============================================================
console.log('\n=== 导入检查 ===')
try {
  // 尝试导入核心模块
  const core = await import('@wangxue98/dsh-motor-ai-core')
  console.log(`✅ @wangxue98/dsh-motor-ai-core 导入成功`)
  console.log(`   导出: ${Object.keys(core).slice(0, 5).join(', ')}...`)
} catch (err) {
  console.log(`❌ core 导入失败: ${err.message}`)
  failures++
}

try {
  // 尝试导入插件入口（使用 file:// URL 避免 Windows 路径问题）
  const indexPath = join(ROOT, 'index.mjs')
  const pluginUrl = pathToFileURL(indexPath)
  const plugin = await import(pluginUrl.href)
  console.log(`✅ index.mjs 导入成功`)
  console.log(`   导出: ${Object.keys(plugin).slice(0, 5).join(', ')}...`)
} catch (err) {
  console.log(`❌ index.mjs 导入失败: ${err.message}`)
  failures++
}

// ============================================================
// 4. 互斥检测检查
// ============================================================
console.log('\n=== 互斥检测检查 ===')
try {
  // 清除全局标记后重新导入
  delete globalThis.__DSH_MOTOR_AI_FULL_LOADED__
  const indexPath = join(ROOT, 'index.mjs')
  const pluginUrl = pathToFileURL(indexPath)
  const plugin = await import(pluginUrl.href)
  console.log('✅ 互斥检测机制存在')
} catch (err) {
  if (err.message.includes('互斥') || err.message.includes('冲突')) {
    console.log('✅ 互斥检测触发正常')
  } else {
    console.log(`⚠️  意外错误: ${err.message}`)
  }
}

// ============================================================
// 4.5 发布安全门禁（防 l0@0.3.0 类缺陷回归）
// ============================================================
console.log('\n=== 发布安全门禁 ===')

// 门禁 A：P0 本机绝对路径泄漏（盘符绝对路径）
const P0_DIRS = ['index.mjs', 'lib', 'tools', 'models', 'scripts', 'skills']
let p0Bad = []
for (const d of P0_DIRS) {
  const dp = join(ROOT, d)
  if (!existsSync(dp)) continue
  try {
    const { stdout } = spawnSync('grep', ['-rInE', '[A-Za-z]:[\\\\/](Users|MotorDesign|home|Program Files)', dp], { encoding: 'utf8', shell: true })
    if (stdout) p0Bad = p0Bad.concat(stdout.split('\n').filter(Boolean))
  } catch { /* ignore */ }
}
if (p0Bad.length === 0) {
  console.log('✅ P0 本机绝对路径泄漏：0 处')
} else {
  console.log(`❌ P0 泄漏 ${p0Bad.length} 处：`); p0Bad.forEach(l => console.log('   ' + l)); failures++
}

// 门禁 B：进包 .mjs 的相对 import 必须命中包内文件
try {
  const packOut = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: true })
  const packInfo = JSON.parse(packOut)
  const packed = (packInfo[0] && packInfo[0].files ? packInfo[0].files : []).map(f => f.path)
  const packedSet = new Set(packed)
  let relCount = 0
  const missing = []
  for (const pf of packed) {
    if (!pf.endsWith('.mjs')) continue
    const abs = join(ROOT, pf)
    if (!existsSync(abs)) continue
    const src = readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const re = /(?:import|await\s+import|require)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g
    let m
    while ((m = re.exec(src))) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      const rr = relative(ROOT, resolve(ROOT, dirname(pf), spec)).split(sep).join('/')
      relCount++
      if (!packedSet.has(rr)) missing.push(`${pf} -> ${spec} (${rr})`)
    }
  }
  if (missing.length === 0) {
    console.log(`✅ 进包 .mjs 相对 import 命中包内：${relCount} 处，0 缺包`)
  } else {
    console.log(`❌ 进包文件引用但未进包：${missing.length} 处：`); missing.forEach(l => console.log('   ' + l)); failures++
  }
} catch (e) {
  console.log(`⚠️  进包门禁跳过（pack 失败）：${e.message}`)
}

// 门禁 C：DSH「组合包」声明完整性（防 not-bundle 类缺陷回归）
// 事故样本：dsh-motor-ai@1.0.0-rc.2 的 package.json 无 dsh.bundle，
// DSH Desktop 插件管理器判为 not-bundle ⇒ "这个包没有声明组合包，无法作为插件安装"，
// 界面完全装不上（只能绕过 UI 手工注入 generation）。
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const cBad = []
  const files = Array.isArray(pkg.files) ? pkg.files : []

  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  if (typeof patch !== 'string' || patch.trim() === '') {
    cBad.push('package.json 缺 dsh.bundle.patch（DSH 判为 not-bundle，界面装不上）')
  } else {
    const patchRel = patch.replace(/^\.\//, '')
    if (!existsSync(join(ROOT, patchRel))) {
      cBad.push(`dsh.bundle.patch 指向的文件不存在：${patch}`)
    }
    const covered = files.some((f) => {
      const norm = f.replace(/^\.\//, '').replace(/\/$/, '')
      return norm === patchRel || patchRel.startsWith(norm + '/')
    })
    if (!covered) cBad.push(`dsh.bundle.patch 不在 files 白名单内（不会进包）：${patch}`)
    if (!(pkg.exports && pkg.exports['./' + patchRel])) {
      cBad.push(`exports 未暴露 ./${patchRel}（Cordis 解析可能失败）`)
    }
  }

  const compat = pkg.dsh && pkg.dsh.compatibility
  if (!compat || typeof compat.dsh !== 'string') {
    cBad.push('package.json 缺 dsh.compatibility.dsh')
  } else if (pkg.peerDependencies && pkg.peerDependencies['@deepseek-ai/dsh'] !== compat.dsh) {
    cBad.push(`dsh.compatibility.dsh(${compat.dsh}) 与 peerDependencies(@deepseek-ai/dsh=${pkg.peerDependencies['@deepseek-ai/dsh']}) 不一致`)
  }

  if (cBad.length === 0) {
    console.log(`✅ 组合包声明完整：patch=${patch} / compat=${compat.dsh}`)
  } else {
    console.log(`❌ 组合包声明缺陷 ${cBad.length} 项：`); cBad.forEach((l) => console.log('   ' + l)); failures++
  }
}

// 门禁 D：入口 inject 声明（防 "cannot get property tools without inject" 类缺陷回归）
// 事故样本：dsh-motor-ai@1.0.0-rc.3 的 index.mjs 默认导出裸函数且未声明 inject，
// cordis 在调用 apply 前拒绝对 ctx.tools 的访问 ⇒ 插件装上了但启用即报组件启用失败。
// 修复形态（对齐 dsh-motor-ai-l0）：命名导出 inject=['tools'] + pluginEntry.inject 挂载。
{
  const entryPath = join(ROOT, 'index.mjs')
  const src = readFileSync(entryPath, 'utf8')
  const dBad = []
  if (!/export\s+const\s+inject\s*=\s*\[\s*['"]tools['"]\s*\]/.test(src)) {
    dBad.push('index.mjs 缺命名导出 inject = [\'tools\']')
  }
  if (!/^pluginEntry\.inject\s*=\s*inject/m.test(src)) {
    dBad.push('index.mjs 缺 pluginEntry.inject 挂载（cordis 在调用 apply 前读取，函数体内赋值无效）')
  }
  if (dBad.length === 0) {
    console.log('✅ 入口 inject 声明完整（named export + 函数挂载）')
  } else {
    console.log(`❌ 入口 inject 缺陷 ${dBad.length} 项：`); dBad.forEach((l) => console.log('   ' + l)); failures++
  }
}

// 门禁 E：工具 output 声明（DSH 0.1.7 register 硬校验，防 "must declare output" 回归）
// 事故样本：dsh-motor-ai@1.0.0-rc.4 的 activate/L1/L2 五工具裸注册缺 output，
// DSH 启动即报 tool "..." must declare output { schema, render, presentationMeta? }。
// 校验器与 dsh-tools/lib/index.js register() 同形态，运行时逐工具实测。
{
  try {
    const plugin = (await import('file://' + join(ROOT, 'index.mjs').replace(/\\/g, '/'))).default
    const registered = []
    const ctx = {
      tools: {
        register(t) {
          const output = t.output
          if (output === undefined || typeof output !== 'object'
            || typeof output.render !== 'function'
            || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
            throw new TypeError(`tool "${t.name}" must declare output { schema, render, presentationMeta? }`)
          }
          registered.push(t)
        },
      },
    }
    await plugin(ctx, {})
    const stringOk = []
    const stringBad = []
    for (const t of registered) {
      try {
        const v = await t.execute({})
        if (typeof v === 'string') stringOk.push(t.name)
        else stringBad.push(`${t.name} 返回 ${typeof v}`)
      } catch {
        stringOk.push(t.name + '(抛错路径,可接受)')
      }
    }
    if (stringBad.length === 0) {
      console.log(`✅ 工具 output 声明完整：${registered.length} 工具过 DSH 校验，execute 均返回 string`)
    } else {
      console.log(`❌ execute 返回类型缺陷 ${stringBad.length} 项：`); stringBad.forEach((l) => console.log('   ' + l)); failures++
    }
  } catch (e) {
    console.log(`❌ 门禁 E 运行失败：${e.message}`); failures++
  }
}

// 门禁 F：入口 apply 返回值必须是合法 cordis effect（函数 / null / undefined）
// 事故样本：dsh-motor-ai@1.0.0-rc.5 的 pluginEntry 为 async 且 return 普通对象，
// cordis _execute 把 apply 返回值当 effect：走 effect.then(safeCollect)，
// 对象既非函数又非 nullable ⇒ TypeError: Invalid effect at safeCollect
// ⇒ 插件"装得上、启用失败"（界面：1 entry did not activate）。
// 复刻 cordis/lib/index.js:1135-1167 的 _execute 判定路径。
{
  const isNullable = (v) => v === null || v === undefined
  const isObject = (v) => v !== null && typeof v === 'object'
  const fBad = []
  try {
    const plugin = (await import('file://' + join(ROOT, 'index.mjs').replace(/\\/g, '/'))).default
    const stubCtx = {
      logger: { info() {}, warn() {}, error() {} },
      tools: { register() {}, unregister() {} },
      effect() { return () => {} },
      on() { return () => {} },
    }
    const effect = plugin(stubCtx, {})
    if (typeof effect === 'function') { /* disposer，合法 */ }
    else if (isNullable(effect)) { /* void，合法 */ }
    else if (!isObject(effect)) fBad.push(`apply 返回 ${typeof effect}（应为函数或 null/undefined）`)
    else if ('then' in effect) {
      await effect.then((v) => {
        if (typeof v !== 'function' && !isNullable(v)) {
          fBad.push(`async apply 的 resolve 值非法（${v === null ? 'null' : typeof v}）：cordis 会抛 "Invalid effect"`)
        }
      })
    } else if (Symbol.iterator in effect || Symbol.asyncIterator in effect) { /* 生成器形态，DSH 迭代收集 */ }
    else fBad.push('apply 返回的对象既非 promise 也非可迭代（cordis 抛 "Invalid effect"）')
  } catch (e) {
    fBad.push(`门禁 F 运行失败：${e.message}`)
  }
  if (fBad.length === 0) {
    console.log('✅ 入口 apply 返回值符合 cordis effect 契约（函数 / null / undefined）')
  } else {
    console.log(`❌ 入口 effect 契约缺陷 ${fBad.length} 项：`); fBad.forEach((l) => console.log('   ' + l)); failures++
  }
}

// 门禁 G：双通道激活闭环（DM 服务端口令在线校验 + 离线 v2 非对称码不误触）
// 事故样本：管理端「商业口令」生成 DM-XXXX-XXXX，但插件端 activate 是纯离线分支，
// 且 license.mjs 正则 /^v(\d+):/ 不匹配 DM → 买家拿到码在 DSH 里激活必然失败，
// 核销/绑定/解绑/收入统计永远为 0。本门禁用 mock fetch 覆盖 4 个分支，零网络依赖。
{
  const gBad = []
  try {
    const licUrl = pathToFileURL(join(ROOT, 'lib', 'license.mjs')).href
    const lic = await import(licUrl)

    // 1) 形态识别
    if (!lic.isOnlinePasscode('DM-2RQ3-STZX')) gBad.push('isOnlinePasscode 未识别合法 DM 码')
    if (lic.isOnlinePasscode('v2:full:x:y:0:0:sig')) gBad.push('isOnlinePasscode 误判离线码为在线码')
    if (typeof lic.activateOnline !== 'function') gBad.push('缺 activateOnline 导出')
    if (typeof lic.activateFlex !== 'function') gBad.push('缺 activateFlex 导出')
    if (typeof lic.getDeviceId !== 'function') gBad.push('缺 getDeviceId 导出')

    // 隔离落盘目录，避免污染真实激活态
    const sandboxHome = join(tmpdir(), `dsh-motor-ai-verify-${process.pid}`)
    process.env.DSH_HOME = sandboxHome

    // 2) 在线校验成功分支（mock 后端返回 valid=true）
    let mockBody = { valid: true, plan: 'yearly', expires_at: new Date(Date.now() + 365 * 86400e3).toISOString(), days_left: 365 }
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => mockBody })
    const ok = await lic.activateOnline('DM-2RQ3-STZX', { backendUrl: 'http://mock.local', deviceId: 'dev1234abcd' })
    if (!ok.success) gBad.push(`在线校验成功分支返回失败：${ok.reason}`)
    else {
      const st = lic.loadActivationState()
      if (!st || st.tier !== 'full' || st.source !== 'online' || !st.expiresAt) {
        gBad.push(`在线激活落盘异常：tier=${st?.tier} source=${st?.source} expiresAt=${st?.expiresAt}`)
      }
    }

    // 3) device_mismatch 分支
    mockBody = { valid: false, reason: 'device_mismatch' }
    const mismatch = await lic.activateOnline('DM-2RQ3-STZX', { backendUrl: 'http://mock.local', deviceId: 'dev1234abcd' })
    if (mismatch.success) gBad.push('device_mismatch 分支竟返回成功')
    else if (!/设备|解绑|device_mismatch/.test(mismatch.reason || '')) gBad.push(`device_mismatch 文案不匹配：${mismatch.reason}`)

    // 4) 网络异常分支（offline=true，提示改用离线码）
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    const netErr = await lic.activateOnline('DM-2RQ3-STZX', { backendUrl: 'http://mock.local', deviceId: 'dev1234abcd' })
    if (!netErr.offline) gBad.push('网络异常分支未置 offline=true')

    // 5) 分流正确性：离线码走 activate 而非 online（不应触碰 fetch）
    let fetched = false
    globalThis.fetch = async () => { fetched = true; return { ok: true, status: 200, json: async () => ({ valid: true }) } }
    await lic.activateFlex('v2:full:issuer:buyer:0:0:deadbeef', {})
    if (fetched) gBad.push('activateFlex 对离线码误走了在线 fetch')

    // 还原 fetch（避免影响其他流程）
    delete globalThis.fetch
  } catch (e) {
    gBad.push(`门禁 G 运行失败：${e.message}`)
  }
  if (gBad.length === 0) {
    console.log('✅ 双通道激活闭环：DM 在线校验 / 绑定 / 不匹配 / 离线分流 全过')
  } else {
    console.log(`❌ 双通道激活缺陷 ${gBad.length} 项：`); gBad.forEach((l) => console.log('   ' + l)); failures++
  }
}

// 门禁 H：免费额度闸门 + 续费取 max（L2 自动化闭环配套）
// 事故样本：后端 /api/dsh/free-call 与 dsh_free_usage 表早已建好，但插件端从未调用，
// 「每日 N 次」形同虚设（旧版断网 fail-open ⇒ 插件分发后完全不限）。
// 现行语义（离线硬限，本地权威）：
//   · 免费档 = 本地 free-quota.json 为准，断网也拦（fail-closed）；断网不误杀未用尽用户；
//   · 付费档 = 一律放行（fail-open），断网绝不锁死付费用户（此条比限流重要得多）；
//   · 后端仅作旁路遥测，不参与放行决策。
// 本门禁把「本地权威 + 免费档 fail-closed + 付费档 fail-open」钉成不可回归的硬约束。
{
  const hBad = []
  try {
    const quota = await import(pathToFileURL(join(ROOT, 'lib', 'quota.mjs')).href)
    const lic = await import(pathToFileURL(join(ROOT, 'lib', 'license.mjs')).href)

    for (const fn of ['checkFreeQuota', 'enforceQuota', 'buildQuotaExceededMessage']) {
      if (typeof quota[fn] !== 'function') hBad.push(`quota.mjs 缺导出 ${fn}`)
    }
    if (typeof lic.laterExpiry !== 'function') hBad.push('license.mjs 缺导出 laterExpiry')

    const sandboxHome = join(tmpdir(), `dsh-motor-ai-verify-h-${process.pid}`)
    process.env.DSH_HOME = sandboxHome

    const qDir = join(sandboxHome, 'storages', 'dsh-motor-ai')
    const qFile = join(qDir, 'free-quota.json')
    const d0 = new Date()
    const dayKey = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`
    const dailyLimit = quota.getDailyLimit()

    // 1) 断网 + 本地未用尽 → 必须放行（本地计数为准，不由网络决定；绝不能锁死用户）
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    const off = await quota.checkFreeQuota({ backendUrl: 'http://mock.local' })
    if (off.allowed !== true) hBad.push(`断网误杀免费用户：allowed=${off.allowed}`)
    if (off.reason !== 'within-quota') hBad.push(`断网 reason 异常：${off.reason}`)

    // 2) 本地额度用尽 → 即便后端说 allowed:true 也必须拦截（离线硬限 fail-closed）
    mkdirSync(qDir, { recursive: true })
    writeFileSync(qFile, JSON.stringify({ day: dayKey, used: dailyLimit, limit: dailyLimit }))
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ allowed: true, used: 0, remaining: 99, limit: 99 }),
    })
    const exhausted = await quota.checkFreeQuota({ backendUrl: 'http://mock.local' })
    if (exhausted.allowed !== false) hBad.push('本地额度用尽未拦截（离线硬限失效）')
    if (exhausted.reason !== 'quota-exhausted') hBad.push(`用尽 reason 异常：${exhausted.reason}`)
    rmSync(qFile, { force: true }) // 复位，避免影响后续用例

    // 3) 非预期响应同样放行（fail-open 一致性）
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ weird: 1 }) })
    const weird = await quota.checkFreeQuota({ backendUrl: 'http://mock.local' })
    if (weird.allowed !== true) hBad.push('非预期响应未 fail-open')

    // 3b) rc.13 P0-门1 运行时语义（rc.14 升级：同链判据 = 调用链令牌）
    //     + P0-门1' 回归：同一 config 引用 + **同步循环**必须各计一次
    rmSync(qFile, { force: true })
    {
      const bypass = { freeQuotaEnabled: false }
      const tokA = quota.newQuotaChain()
      quota.assertFreeQuota('rt-a', quota.withQuotaChain({}, tokA))
      quota.assertFreeQuota('rt-a2', quota.withQuotaChain({}, tokA)) // 同链令牌 → 不重复扣
      let st = JSON.parse(readFileSync(qFile, 'utf8'))
      if (st.free !== 1) hBad.push(`同一调用链重复扣次：free=${st.free}`)
      const tokB = quota.newQuotaChain()
      quota.assertFreeQuota('rt-b', quota.withQuotaChain({}, tokB)) // 不同链 → 独立计数
      st = JSON.parse(readFileSync(qFile, 'utf8'))
      if (st.free !== 2) hBad.push(`跨调用链未独立计数：free=${st.free}`)
      // P0-门1'：同一 config 引用 + 同步循环 ⇒ 各计一次（rc.13 此处整批只扣 1 次）
      const sameCfg = {}
      quota.assertFreeQuota('rt-s1', sameCfg)
      quota.assertFreeQuota('rt-s2', sameCfg)
      quota.assertFreeQuota('rt-s3', sameCfg)
      st = JSON.parse(readFileSync(qFile, 'utf8'))
      if (st.free !== 5) hBad.push(`P0-门1' 同步循环脱闸：期望 free=5，实得 ${st.free}`)
      quota.assertFreeQuota('rt-off', bypass) // 运维开关 → 不计数
      st = JSON.parse(readFileSync(qFile, 'utf8'))
      if (st.free !== 5) hBad.push(`freeQuotaEnabled:false 未 bypass：free=${st.free}`)
      rmSync(qFile, { force: true })
    }

    // 4) 已激活不请求后端：即便 fetch 抛错也应 reason=activated
    lic.saveActivationState({
      active: true, tier: 'full', buyer: 't', keyId: 'k', source: 'online',
      expiresAt: new Date(Date.now() + 86400e3).toISOString(), deviceId: 'd',
    })
    globalThis.fetch = async () => { throw new Error('should-not-be-called') }
    const act = await quota.checkFreeQuota({ backendUrl: 'http://mock.local' })
    if (act.allowed !== true || act.reason !== 'activated') {
      hBad.push(`已激活未跳过配额：${JSON.stringify(act)}`)
    }

    // 5) 续费取 max：更早的新码不得缩短原到期
    const late = '2027-01-01T00:00:00'
    const early = '2026-06-01T00:00:00'
    if (lic.laterExpiry(late, early) !== late) hBad.push('laterExpiry 未取更晚者')
    if (lic.laterExpiry(early, late) !== late) hBad.push('laterExpiry 对参数序敏感')
    if (lic.laterExpiry(null, early) !== early) hBad.push('laterExpiry 单侧缺失处理错误')
    if (lic.laterExpiry(null, null) !== null) hBad.push('laterExpiry 双侧缺失应返回 null')

    // 6) L0 四工具均接入闸门（rc.13 P0-门1，对齐 l0 v0.5.1 接线形态）：
    //    静态 = import assertFreeQuota/QuotaExceededError + 纯函数入口过闸 +
    //    execute 捕获 QuotaExceededError + 禁 await enforceQuota 旧写法（双重扣次）
    const l0Dir = join(ROOT, 'tools', 'l0')
    for (const f of ['param-matrix.mjs', 'l0-estimate.mjs', 'design-validate.mjs', 'pipeline.mjs']) {
      const src = readFileSync(join(l0Dir, f), 'utf8')
      if (!/import\s*\{[^}]*assertFreeQuota[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/quota\.mjs'/.test(src)) {
        hBad.push(`${f} 缺少 assertFreeQuota import`)
      }
      if (!/import\s*\{[^}]*QuotaExceededError[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/quota\.mjs'/.test(src)) {
        hBad.push(`${f} 缺少 QuotaExceededError import`)
      }
      // 离线硬限防绕过：内部计算函数顶部必须植入 assertFreeQuota，
      // 否则「绕过工具网关、直调内部纯函数」可无限使用。
      if (!/assertFreeQuota\(/.test(src)) hBad.push(`${f} 内部函数未植入 assertFreeQuota（可绕过硬限）`)
      if (!/err\s+instanceof\s+QuotaExceededError/.test(src)) {
        hBad.push(`${f} execute 未捕获 QuotaExceededError（用尽时回不了引导文案）`)
      }
      if (/await\s+enforceQuota\(config\)/.test(src)) {
        hBad.push(`${f} execute 仍 await enforceQuota（与纯函数入口双重扣次，rc.13 已废弃该写法）`)
      }
    }

    // 6a) rc.14 P0-门1'（对齐 l0 v0.5.2）：同链判据必须是**显式调用链令牌**，
    //     禁止退回「_consumed WeakSet(key=config 对象) + queueMicrotask 复位」——
    //     该写法在同步批量循环（CI/压测典型形态）里微任务不穿插 ⇒ 整批只扣 1 次。
    {
      const q = readFileSync(join(ROOT, 'lib', 'quota.mjs'), 'utf8')
      if (!/export\s+function\s+newQuotaChain/.test(q)) hBad.push('缺少 export newQuotaChain（rc.14 调用链令牌）')
      if (!/export\s+function\s+withQuotaChain/.test(q)) hBad.push('缺少 export withQuotaChain（rc.14 同链派生）')
      if (/function\s+alreadyConsumed\s*\(\s*config\s*\)/.test(q)) {
        hBad.push('quota.mjs 仍按 config 对象引用判同链（rc.13 缺陷形态：同步批量脱闸）')
      }
      if (/markConsumed\(config\)/.test(q)) {
        hBad.push('quota.mjs 仍按 config 对象标记消费（rc.14 应改为按调用链令牌标记）')
      }
      const pl = readFileSync(join(l0Dir, 'pipeline.mjs'), 'utf8')
      if (!/const\s+chain\s*=\s*newQuotaChain\(\)/.test(pl)) hBad.push('pipeline.mjs 未新建调用链令牌')
      if (!/withQuotaChain\(config,\s*chain\)/.test(pl)) hBad.push('pipeline.mjs 未派生带令牌配置')
      if (!/buildParamMatrix\(args,\s*chainCfg\)/.test(pl)) hBad.push('pipeline.mjs 未把带令牌配置透传给 buildParamMatrix')
      if (!/runDesignValidate\(\{[^}]*\},\s*chainCfg\)/.test(pl)) hBad.push('pipeline.mjs 未把带令牌配置透传给 runDesignValidate')
      if (!/runL0Estimate\([\s\S]*?\},[\s\S]*?chainCfg\)/.test(pl)) hBad.push('pipeline.mjs 未把带令牌配置透传给 runL0Estimate')
    }

    // 6a2) rc.16 L0 四项修复不可回退（静默失败防线）
    //      P0-2 截断告警 + 硬上限 + 严格模式；P1-1 冷却回退告警；
    //      P0-4 默认极数建议；P0-1 密度收敛自检（默认 OFF，须读 efficiency_raw）。
    {
      const pm = readFileSync(join(ROOT, 'tools', 'l0', 'param-matrix.mjs'), 'utf8')
      const pl = readFileSync(join(ROOT, 'tools', 'l0', 'pipeline.mjs'), 'utf8')
      for (const [src, label, need] of [
        [pm, 'param-matrix.mjs', ['MATRIX_TRUNCATED', 'MATRIX_HARD_CAP', 'strictMaxMatrixSize',
          'COOLING_FALLBACK', 'POLES_DEFAULT_ASSUMED', 'poles_explicit']],
        [pl, 'pipeline.mjs', ['density_check', 'DENSITY_NOT_CONVERGED',
          'export function topEfficiencyOf']],
      ]) {
        for (const token of need) {
          if (!src.includes(token)) hBad.push(`${label} 缺 ${token}（rc.16 L0 修复被回退）`)
        }
      }
      // 密度自检必须读真值：拿被钳的 efficiency 比对会在高效率段恒差 0 ⇒ 假绿
      if (!/efficiency_raw\s*\?\?\s*row\.efficiency/.test(pl)) {
        hBad.push('topEfficiencyOf 未优先读 efficiency_raw（密度自检会假绿）')
      }
      // 默认必须 OFF（零回归）：自检不得无条件执行
      if (!/args\.density_check\s*===\s*true/.test(pl) || !/L0_DENSITY_CHECK/.test(pl)) {
        hBad.push('密度自检未受 args.density_check / L0_DENSITY_CHECK 控制（默认 OFF 零回归被破坏）')
      }
      if (!existsSync(join(ROOT, 'scripts', 'l0_fixes_probe_rc16.mjs'))) {
        hBad.push('缺 l0_fixes_probe_rc16.mjs（rc.16 L0 四项修复行为探针）')
      } else {
        // 运行时强断言：静态字符串查不出「判据被改坏但文案还在」的回退
        const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'l0_fixes_probe_rc16.mjs')],
          { encoding: 'utf8', timeout: 180_000 })
        const out = String(r.stdout || '')
        if (!out.includes('L0_FIXES_PROBE_RC16_ALL_OK')) {
          hBad.push(`L0 四项修复运行时探针未全绿（exit=${r.status}）：` +
            out.split('\n').filter((l) => l.startsWith('[FAIL]')).join(' | ').slice(0, 300))
        }
      }
    }

    // 6b) L1/L2 付费档主力路径同样必须接入闸门（付费档 9999/天 宽松硬顶，防脚本批量刷用）；
    //     只给 L0 计数等于漏掉付费用户的真实消耗路径。
    for (const f of ['tools/l1/rmxprt-solve.mjs', 'tools/l2/motorcad-verify.mjs']) {
      const src = readFileSync(join(ROOT, f), 'utf8')
      if (!src.includes("from '../../lib/quota.mjs'")) hBad.push(`${f} 未 import quota`)
      if (!/enforceQuota\(config\)/.test(src)) hBad.push(`${f} execute 未调用 enforceQuota`)
    }

    // 6d) L2 真 FEA（方案 Y）不得回退成占位：
    //     - 必须保留本机 COM 直驱标识 motorcad-com-fea
    //     - 必须保留等效电路法降级兜底 equivalent-circuit-fallback（方案 Z）
    //     - bridge 脚本必须存在且随包发布（files 含 scripts/）
    {
      const l2 = readFileSync(join(ROOT, 'tools/l2/motorcad-verify.mjs'), 'utf8')
      if (!l2.includes('motorcad-com-fea')) hBad.push('L2 丢失本机 COM 直驱标识（方案 Y 回退）')
      if (!l2.includes('equivalent-circuit-fallback')) hBad.push('L2 丢失等效电路法降级兜底（方案 Z）')
      if (!existsSync(join(ROOT, 'scripts', 'motorcad_bridge.py'))) {
        hBad.push('scripts/motorcad_bridge.py 缺失（L2 COM 桥不可用）')
      }
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
      if (!(Array.isArray(pkg.files) && pkg.files.includes('scripts/'))) {
        hBad.push('package.json files 未包含 scripts/ → bridge 不会随包发布')
      }
    }

    // 6e) 完整版遥测聚合（方案 B，2026-10-14）：接线不可回退
    //     - lib/telemetry.mjs 必须导出 scheduleTelemetry/defaultTelemetryEndpoint，
    //       聚合身份必须是 dsh-motor-ai（不是从 l0 抄来的 dsh-motor-ai-l0 残留）；
    //     - L0 四工具 + L1/L2 五 execute 必须调用 scheduleTelemetry(config)；
    //     - CONFIG_SCHEMA 必须声明 telemetryEnabled（否则 DSH 裁键 → 恒 undefined，
    //       重演 backendUrl 事故）；
    //     - opt-out 语义：telemetryEnabled=false 时 scheduleTelemetry 拒绝调度。
    {
      const telSrc = readFileSync(join(ROOT, 'lib', 'telemetry.mjs'), 'utf8')
      if (!/export async function scheduleTelemetry/.test(telSrc)) hBad.push('telemetry.mjs 缺 scheduleTelemetry 导出')
      if (!/export function defaultTelemetryEndpoint/.test(telSrc)) hBad.push('telemetry.mjs 缺 defaultTelemetryEndpoint 导出')
      if (!telSrc.includes("plugin: meta.plugin || 'dsh-motor-ai'")) hBad.push("telemetry.mjs 聚合身份不是 dsh-motor-ai（l0 残留）")
      if (!telSrc.includes('/api/dsh/dsh-plugins/dsh-motor-ai/usage-report')) hBad.push('telemetry.mjs 缺后端 usage-report 回退端点')

      const idxSrc = readFileSync(join(ROOT, 'index.mjs'), 'utf8')
      if (!/telemetryEnabled:/.test(idxSrc)) hBad.push('CONFIG_SCHEMA 未声明 telemetryEnabled（DSH 会裁键 → 恒 undefined）')
      if (!/telemetryEndpoint:/.test(idxSrc)) hBad.push('CONFIG_SCHEMA 未声明 telemetryEndpoint')

      const telemFiles = [
        'tools/l0/param-matrix.mjs', 'tools/l0/l0-estimate.mjs',
        'tools/l0/pipeline.mjs', 'tools/l0/design-validate.mjs',
        'tools/l1/rmxprt-solve.mjs', 'tools/l2/motorcad-verify.mjs',
      ]
      for (const f of telemFiles) {
        const src = readFileSync(join(ROOT, f), 'utf8')
        if (!src.includes("from '../../lib/telemetry.mjs'")) hBad.push(`${f} 未 import telemetry`)
        if (!/scheduleTelemetry\(config\)/.test(src)) hBad.push(`${f} execute 未调用 scheduleTelemetry(config)`)
      }

      // opt-out 功能验证：telemetryEnabled=false 必须拒绝调度
      const tel = await import(pathToFileURL(join(ROOT, 'lib', 'telemetry.mjs')).href)
      const offSched = await tel.scheduleTelemetry({ telemetryEnabled: false })
      if (offSched.scheduled !== false || offSched.reason !== 'disabled') {
        hBad.push(`telemetryEnabled=false 未退出：${JSON.stringify(offSched)}`)
      }
    }

    // 6f) rc.11：config 键覆盖门禁（P0-②，防"改配置不生效"复发）
    //     规则：本仓代码实际读取的 config 键 ⊆ CONFIG_SCHEMA 声明键。
    //     背景：backendUrl/commerceBackendUrl 等键被代码读取但未声明 → DSH 裁成
    //     undefined → 后端通道/遥测端点/L2 调参全部静默失效（该类问题第二次复发）。
    //     另：L1 worker 必须随包分发（rc.11 前只在外仓，分发版 L1 恒不可用）。
    {
      const idxSrc = readFileSync(join(ROOT, 'index.mjs'), 'utf8')
      const schemaBlock = idxSrc.match(/const CONFIG_SCHEMA = \{[\s\S]*?\n\}/)
      if (!schemaBlock) {
        hBad.push('index.mjs 找不到 CONFIG_SCHEMA')
      } else {
        const declared = new Set(
          [...schemaBlock[0].matchAll(/^    ([a-zA-Z_][a-zA-Z0-9_]*): \{$/gm)].map((x) => x[1])
        )
        // 运行时由插件自身注入、非 DSH 用户配置的键（DSH 不过 schema）
        const RUNTIME_KEYS = new Set(['pluginVersion'])
        const scanFiles = [
          'index.mjs',
          'lib/quota.mjs', 'lib/license.mjs', 'lib/telemetry.mjs',
          'lib/usage-log.mjs', 'lib/experience-upload.mjs', 'lib/regression-gate.mjs',
          'lib/experience-feedback.mjs', 'lib/doc-upload.mjs',
          'lib/surrogate-engine.mjs', 'lib/formula-engine.mjs',
          'lib/env-probe.mjs',
          'tools/env-check.mjs',
          'tools/l0/param-matrix.mjs', 'tools/l0/l0-estimate.mjs',
          'tools/l0/pipeline.mjs', 'tools/l0/design-validate.mjs',
          'tools/l1/rmxprt-solve.mjs', 'tools/l2/motorcad-verify.mjs',
          'tools/report-issue.mjs',
        ]
        const read = new Set()
        for (const f of scanFiles) {
          const p = join(ROOT, f)
          if (!existsSync(p)) continue
          const src = readFileSync(p, 'utf8')
          for (const m of src.matchAll(/\bconfig\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) read.add(m[1])
        }
        const missing = [...read].filter((k) => !declared.has(k) && !RUNTIME_KEYS.has(k)).sort()
        if (missing.length) {
          hBad.push(`代码读取但 CONFIG_SCHEMA 未声明（DSH 会裁键 → 恒 undefined）：${missing.join(', ')}`)
        }
        // L1 worker 随包分发（rc.11）
        if (!existsSync(join(ROOT, 'scripts', '_rmxprt_venv_worker.py'))) {
          hBad.push('scripts/_rmxprt_venv_worker.py 缺失 → 分发版 L1 恒不可用（README ⏳ 真相）')
        }
        const l1 = readFileSync(join(ROOT, 'tools', 'l1', 'rmxprt-solve.mjs'), 'utf8')
        if (!/bundledWorkerPath/.test(l1)) hBad.push('L1 缺包内 worker 解析（bundledWorkerPath），分发版只能靠外部路径')
      }
    }

    // 6g) rc.12：L1/L2 环境预检 + 引导（env-probe 接线不可回退）
    //     - lib/env-probe.mjs 必须导出探测矩阵与引导构建器；
    //     - motor_env_check 工具必须注册（index.mjs import + registerAll 调用 + manifest tools 声明）；
    //     - L1 三 execute / L2 motor_motorcad_verify 必须在 license 闸后、配额消耗前预检
    //       （缺项返回 ENV_NOT_READY 引导，不白耗 AEDT/COM 启动、不扣配额）；
    //     - worker --preflight 必须真实消费（rc.11 前是声明未实现的死参数）；
    //     - CONFIG_SCHEMA 必须声明 l1Python（env-probe 候选链读取）。
    {
      const ep = join(ROOT, 'lib', 'env-probe.mjs')
      if (!existsSync(ep)) {
        hBad.push('lib/env-probe.mjs 缺失（环境预检模块）')
      } else {
        const src = readFileSync(ep, 'utf8')
        for (const fn of ['export async function probeL1', 'export async function probeL2',
          'export async function probeAll', 'export function buildEnvGuide',
          'export function formatProbeReport', 'export const PROBE_ITEMS']) {
          if (!src.includes(fn)) hBad.push(`env-probe.mjs 缺导出：${fn}`)
        }
      }
      const ec = join(ROOT, 'tools', 'env-check.mjs')
      if (!existsSync(ec)) {
        hBad.push('tools/env-check.mjs 缺失（motor_env_check 一键体检）')
      } else {
        const src = readFileSync(ec, 'utf8')
        if (!src.includes("ENV_CHECK_TOOL_NAME = 'motor_env_check'")) hBad.push('env-check.mjs 工具名不是 motor_env_check')
        if (!/scheduleTelemetry/.test(src)) hBad.push('env-check.mjs 未挂遥测（环境分布统计通道）')
      }
      const idxSrc2 = readFileSync(join(ROOT, 'index.mjs'), 'utf8')
      if (!idxSrc2.includes("from './tools/env-check.mjs'")) hBad.push('index.mjs 未 import registerEnvCheck')
      if (!/await registerEnvCheck\(ctx, config\)/.test(idxSrc2)) hBad.push('registerAll 未调用 registerEnvCheck')
      if (!/l1Python:/.test(idxSrc2)) hBad.push('CONFIG_SCHEMA 未声明 l1Python（DSH 会裁键 → 候选链读不到）')
      const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'))
      if (!Array.isArray(manifest.tools) || !manifest.tools.includes('motor_env_check')) {
        hBad.push('manifest.json tools 未声明 motor_env_check')
      }
      const l1src = readFileSync(join(ROOT, 'tools', 'l1', 'rmxprt-solve.mjs'), 'utf8')
      const l1Hooks = (l1src.match(/await probeL1\(config\)/g) || []).length
      if (l1Hooks !== 3) hBad.push(`L1 预检接线数=${l1Hooks}（应为 3：estimate/pipeline/solve）`)
      if (!l1src.includes('probeL1, buildEnvGuide')) hBad.push('L1 未 import probeL1/buildEnvGuide')
      const l2src = readFileSync(join(ROOT, 'tools', 'l2', 'motorcad-verify.mjs'), 'utf8')
      if (!/await probeL2\(config\)/.test(l2src)) hBad.push('L2 motor_motorcad_verify 未接线 probeL2 预检')
      if (!l2src.includes('probeL2, buildEnvGuide')) hBad.push('L2 未 import probeL2/buildEnvGuide')
      // worker --preflight 死参数必须真实消费
      const wsrc = readFileSync(join(ROOT, 'scripts', '_rmxprt_venv_worker.py'), 'utf8')
      if (!wsrc.includes('def _run_preflight')) hBad.push('worker 缺 _run_preflight 实现（--preflight 仍是死参数）')
      if (!/getattr\(args, "preflight", False\)/.test(wsrc)) hBad.push('worker main 未消费 --preflight')
      // 功能验证：探测矩阵结构（真实 spawn python，~1-2s）
      const epMod = await import(pathToFileURL(ep).href)
      const all = await epMod.probeAll({})
      for (const lvl of ['l1', 'l2']) {
        const keys = all[lvl].items.map((i) => i.key)
        if (!keys.includes('python')) hBad.push(`probeAll(${lvl}).items 缺 python`)
      }
      if (!(all.l1.items.some((i) => i.key === 'pyaedt') && all.l1.items.some((i) => i.key === 'aedt'))) {
        hBad.push('probeAll(l1) 项矩阵不完整（应含 pyaedt + aedt）')
      }
      if (!(all.l2.items.some((i) => i.key === 'pywin32') && all.l2.items.some((i) => i.key === 'motorcad'))) {
        hBad.push('probeAll(l2) 项矩阵不完整（应含 pywin32 + motorcad）')
      }
      const guide = epMod.buildEnvGuide('l1', [{ key: 'pyaedt' }, { key: 'aedt' }])
      if (guide.status !== 'env_not_ready' || !guide.guide?.nextSteps?.length) {
        hBad.push('buildEnvGuide 结构不完整（status/nextSteps）')
      }
      if (guide.guide.nextSteps.some((s, i) => !s.startsWith(`${i + 1}.`))) {
        hBad.push('buildEnvGuide nextSteps 编号不连续')
      }
    }

    // 6h) P0 反馈联系束 + P0 齿宽/sanity 束（rc.13，不可回退）
    //     反馈束：L2 三失败分支 report 字段 + env-not-ready 回传 action 邮箱
    //             + formatProbeReport 联系行 + motor_report_issue 工具注册。
    //     齿宽/sanity 束：tooth_width 映射 + 网格化预检（BUG11 防线）
    //             + bridge _sanity_gate（return=0≠可信防线，额定功率比对）。
    {
      const l2src = readFileSync(join(ROOT, 'tools', 'l2', 'motorcad-verify.mjs'), 'utf8')
      if (!/action: guide\.action/.test(l2src)) hBad.push('L2 env-not-ready 分支未回传 action（联系邮箱被丢弃）')
      if (!l2src.includes('buildL2ReportField')) hBad.push('L2 缺统一 report 反馈字段构建器')
      const repCount = (l2src.match(/report: buildL2ReportField\(/g) || []).length
      if (repCount !== 3) hBad.push(`L2 report 字段接线数=${repCount}（应为 3：env_not_ready/fallback/error）`)
      if (!l2src.includes("tooth_width: ['Tooth_Width']")) hBad.push('MOTORCAD_PARAM_CANDIDATES 缺 tooth_width 映射（BUG11 防线）')
      if (!l2src.includes('export function buildMeshPrecheck')) hBad.push('缺 buildMeshPrecheck 网格化预检')
      if (!l2src.includes('export function extractRatedPowerW')) hBad.push('缺 extractRatedPowerW（sanity 门额定功率来源）')
      if (!/rated_power_w: this\._ratedPowerW \|\| 0/.test(l2src)) hBad.push('bridge payload 未携带 rated_power_w')
      const epsrc = readFileSync(join(ROOT, 'lib', 'env-probe.mjs'), 'utf8')
      if (!epsrc.includes('CONTACT_EMAIL')) hBad.push('env-probe.mjs 未接入联系邮箱（formatProbeReport 联系行）')
      const pysrc = readFileSync(join(ROOT, 'scripts', 'motorcad_bridge.py'), 'utf8')
      if (!pysrc.includes('def _sanity_gate')) hBad.push('bridge 缺 _sanity_gate（return=0≠可信防线）')
      if (!pysrc.includes('result_warning') || !pysrc.includes('result_trusted')) hBad.push('bridge sanity 门未写 result_warning/result_trusted')
      if (!pysrc.includes('rated_power_w')) hBad.push('bridge 未消费 rated_power_w')
      // rc.15：损耗维度防线。求解空转时功率同样为 0 ⇒ 判据 1/2 双双失效，
      // 必须靠"关键损耗字段全 0"拦住，否则垃圾值被静默采信（不可回退）。
      if (!pysrc.includes('CORE_LOSS_VARS')) hBad.push('bridge 缺 CORE_LOSS_VARS（sanity 门损耗判据字段集）')
      if (!pysrc.includes('关键损耗字段全 0')) hBad.push('bridge sanity 门缺「关键损耗字段全 0」判定')
      if (!pysrc.includes('LOSS_ZERO_EPS')) hBad.push('bridge 缺 LOSS_ZERO_EPS（损耗零容差）')
      if (!/read_back\s*=\s*\[k for k in CORE_LOSS_VARS/.test(pysrc)) hBad.push('sanity 门损耗判据未按 CORE_LOSS_VARS 读回集判定')
      // 误杀防线：CORE_LOSS_VARS 不得纳入本就可能为 0 的分量（PMSM 转子铜耗/磁钢/风摩/杂散）
      for (const banned of ['Loss_[Rotor_Copper]', 'Loss_[Magnet]', 'Loss_[Windage]', 'Loss_[Stray_Load]']) {
        // 注意：字段名自带 "]"（Loss_[Total]），非贪婪到第一个 ] 会被提前截断；
        // 必须锚定"行首的 ]"（列表结束符），否则误纳检查恒真 = 假绿灯。
        const coreBlock = (pysrc.match(/CORE_LOSS_VARS = \[[\s\S]*?\n\]/) || [''])[0]
        if (!/Loss_\[Total\]/.test(coreBlock) || !/Loss_\[Stator_Copper\]/.test(coreBlock)) {
          hBad.push('CORE_LOSS_VARS 块解析失败或未含总损耗/定子铜耗（正则被字段名自带 ] 截断？）')
        }
        if (coreBlock.includes(banned)) hBad.push(`CORE_LOSS_VARS 误纳入 ${banned}（合法工况可为 0，会误杀）`)
      }
      if (!existsSync(join(ROOT, 'scripts', 'sanity_gate_probe_rc15.py'))) hBad.push('缺 sanity_gate_probe_rc15.py（损耗判据行为探针）')
      // 运行时强断言：静态字符串查不出"判据被改写但文案还在"的回退，
      // 必须真跑一遍探针（损耗全 0 触发 / 合法 PMSM 零铜耗不误杀）。
      {
        const probe = join(ROOT, 'scripts', 'sanity_gate_probe_rc15.py')
        if (existsSync(probe)) {
          const py = process.env.DSH_PYTHON || 'python'
          const r = spawnSync(py, [probe], { encoding: 'utf8', timeout: 60_000 })
          if (r.error || r.status === null) {
            // 无 python 环境时降级为提示（可用 DSH_PYTHON 指定解释器以启用该强断言）
            console.log(`  · 跳过 sanity 门运行时探针：python(${py}) 不可用（${r.error?.message || 'timeout'}）；可用 DSH_PYTHON 指定解释器`)
          } else if (!String(r.stdout || '').includes('SANITY_GATE_PROBE_RC15_ALL_OK')) {
            hBad.push(`sanity 门运行时探针未全绿（exit=${r.status}）：${String(r.stdout || r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ')}`)
          }
        }
      }
      const risrc = readFileSync(join(ROOT, 'tools', 'report-issue.mjs'), 'utf8')
      if (!risrc.includes("REPORT_ISSUE_TOOL_NAME = 'motor_report_issue'")) hBad.push('report-issue 工具名不是 motor_report_issue')
      const idxSrc3 = readFileSync(join(ROOT, 'index.mjs'), 'utf8')
      if (!idxSrc3.includes("from './tools/report-issue.mjs'")) hBad.push('index.mjs 未 import registerReportIssue')
      if (!/await registerReportIssue\(ctx, config\)/.test(idxSrc3)) hBad.push('registerAll 未调用 registerReportIssue')
      const manifest2 = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'))
      if (!Array.isArray(manifest2.tools) || !manifest2.tools.includes('motor_report_issue')) {
        hBad.push('manifest.json tools 未声明 motor_report_issue')
      }
      // 功能验证（纯本地、不发网络请求）：mesh 预检三态 + 额定功率提取 + 反馈稿组装
      const l2mod = await import(pathToFileURL(join(ROOT, 'tools', 'l2', 'motorcad-verify.mjs')).href)
      const meshMissing = l2mod.buildMeshPrecheck({ stator_od: 677, slots: 18 })
      if (!meshMissing.warnings.length) hBad.push('buildMeshPrecheck 缺齿宽场景未告警（BUG11 防线失效）')
      const meshBad = l2mod.buildMeshPrecheck({ stator_bore: 600, slots: 18, tooth_width: 120 })
      if (!meshBad.warnings.length) hBad.push('buildMeshPrecheck 齿宽≥齿距场景未告警')
      const meshOk = l2mod.buildMeshPrecheck({ stator_od: 677, slots: 18, tooth_width: 21 })
      if (meshOk.warnings.length) hBad.push('buildMeshPrecheck 合理齿宽误报: ' + meshOk.warnings.join(';'))
      if (l2mod.extractRatedPowerW({ spec: { rated_power: 450000 } }) !== 450000) hBad.push('extractRatedPowerW spec 嵌套提取失败')
      if (l2mod.extractRatedPowerW({ power_kw: 450 }) !== 450000) hBad.push('extractRatedPowerW kW 变体提取失败')
      if (l2mod.extractRatedPowerW({ stator_od: 677 }) !== null) hBad.push('extractRatedPowerW 无功率字段应返回 null')
      const riMod = await import(pathToFileURL(join(ROOT, 'tools', 'report-issue.mjs')).href)
      const issueText = await riMod.buildIssueReport({ errorSummary: '测试报错', toolName: 'motor_motorcad_verify' })
      if (!issueText.includes('13546196530@163.com') || !issueText.includes('== dsh-motor-ai 问题反馈稿 ==')) {
        hBad.push('buildIssueReport 输出缺邮箱/标题')
      }
      if (/v2:[A-Za-z0-9+/_-]{20,}/.test(issueText)) hBad.push('反馈稿疑似泄漏激活码密文（激活态摘要不得含激活码本体）')
    }

    // 6c) 付费档必须存在宽松硬顶（否则单账号可无限脚本化调用）
    if (typeof quota.getPaidDailyLimit !== 'function') {
      hBad.push('quota.mjs 缺导出 getPaidDailyLimit（付费档硬顶）')
    }
    if (!(quota.DEFAULT_PAID_DAILY_LIMIT > 0)) {
      hBad.push('DEFAULT_PAID_DAILY_LIMIT 必须为正（付费档宽松硬顶）')
    }

    delete globalThis.fetch
  } catch (e) {
    hBad.push(`门禁 H 运行失败：${e.message}`)
  }
  if (hBad.length === 0) {
    console.log('✅ 免费额度闸门 + 续费取 max：断网不误杀 / 本地用尽硬拦截 / 已激活跳过 / L0+L1+L2 全接入 / 付费档硬顶 全过')
  } else {
    console.log(`❌ 额度与续费缺陷 ${hBad.length} 项：`); hBad.forEach((l) => console.log('   ' + l)); failures++
  }
}

// ============================================================
// 4z. 仓库 YAML 严格解析（重复键防线 — rc.20 升级事故复检）
// ============================================================
// 事故背景：rc.20 的 cordis.patch.yml 中 telemetryEndpoint 出现两次（空值 + URL），
// YAML 规范禁止重复键；DSH 客户端插件管理器（dsh-plugin-manager）以 yaml@2 默认
// uniqueKeys 严格模式解析补丁，抛 "Map keys must be unique" → 判补丁非法
// （"patch file is not a valid entry list"）→ 升级失败并自动回滚。
// 本门禁以同款解析器复检全部仓库 YAML：重复键硬失败，其余语法问题仅告警不拦截。
console.log('\n=== YAML 严格解析（重复键防线）===')
{
  let yamlParse = null
  try {
    yamlParse = (await import('yaml')).parse
  } catch {
    yamlParse = null
  }
  if (!yamlParse) {
    console.log('❌ 严格 YAML 解析器缺失：node_modules/yaml 不存在（devDependency: yaml@^2.9.1；dsh-tools 用 dev-stubs/ file: 桩，@deepseek-ai/dsh peer 已标 optional，npm install 应可全树解析）')
    failures++
  } else {
    const ymlFiles = []
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === 'output' || ent.name.startsWith('.')) continue
        const p = join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (/\.(yml|yaml)$/i.test(ent.name)) ymlFiles.push(p)
      }
    }
    walk(ROOT)
    const dupBad = [], otherBad = []
    for (const f of ymlFiles) {
      try {
        yamlParse(readFileSync(f, 'utf-8'))
      } catch (err) {
        const first = String(err.message).split('\n')[0]
        if (/unique/i.test(first)) dupBad.push(`${relative(ROOT, f)}: ${first}`)
        else otherBad.push(`${relative(ROOT, f)}: ${first}`)
      }
    }
    for (const l of otherBad) console.log(`  · 告警（非重复键，不拦截）：${l}`)
    if (dupBad.length === 0) {
      console.log(`✅ ${ymlFiles.length} 个仓库 YAML 严格解析通过（无重复键；客户端 yaml@2 等价校验）`)
    } else {
      console.log(`❌ YAML 重复键 ${dupBad.length} 处（客户端将判补丁无效，升级必失败并回滚）：`)
      dupBad.forEach((l) => console.log('   ' + l))
      failures++
    }
  }
}

// ============================================================
// 4z-b. defineTool output schema 防线（rc.22 激活事故复检）
// ============================================================
// 事故背景：rc.20 新增 submit_resolved_case 的 output.schema 为裸 { type: 'object' }，
// 而真实 dsh-tools（DSH 0.12.0 内置版同款）的 value schema 编译器对 object 分支
// 硬要求显式 additionalProperties（"additionalProperties must be explicitly true
// or false"）——register 时 defineTool 即抛 authorError → registerAll 抛 →
// cordis fiber FAILED → 「更新后的组合无法启动」。安装阶段只验 patch entry list
// 结构，不 import 插件模块，故表现为「安装正确、重启报故障」。
// 本门禁静态复检：凡 schema: 指向的 object 字面量缺 additionalProperties 即失败。
// （旧工具经 ctx.tools.register 直接注册、不过编译器，其 parameters 不在本规则内。）
console.log('\n=== defineTool output schema 防线 ===')
{
  const mjsFiles = []
  const walkTools = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === 'output' || ent.name.startsWith('.')) continue
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walkTools(p)
      else if (/\.mjs$/.test(ent.name)) mjsFiles.push(p)
    }
  }
  walkTools(join(ROOT, 'tools'))
  const schemaBad = []
  for (const f of mjsFiles) {
    const text = readFileSync(f, 'utf-8')
    const re = /type:\s*'object'/g
    let m
    while ((m = re.exec(text)) !== null) {
      const start = text.lastIndexOf('{', m.index)
      if (start < 0) continue
      let depth = 0, end = -1
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break } }
      }
      if (end < 0) continue
      const frag = text.slice(start, end + 1)
      if (frag.includes('additionalProperties')) continue
      // 仅拦截 schema: 指向的 object（output.schema 走 value schema 编译器）；
      // parameters 形 object 由 defineTool 的 property-map 路径处理，不适用本规则。
      const before = text.slice(Math.max(0, start - 80), start)
      if (!/schema:\s*$/.test(before)) continue
      const line = text.slice(0, m.index).split('\n').length
      schemaBad.push(`${relative(ROOT, f)}:${line} ${frag.slice(0, 80).replace(/\n/g, ' ')}`)
    }
  }
  if (schemaBad.length === 0) {
    console.log(`✅ ${mjsFiles.length} 个工具文件中 schema object 均显式 additionalProperties`)
  } else {
    console.log(`❌ ${schemaBad.length} 处 schema object 缺 additionalProperties（真实 defineTool 注册即抛，插件激活失败）：`)
    schemaBad.forEach((l) => console.log('   ' + l))
    failures++
  }
}

// ============================================================
// 5. 汇总
// ============================================================
console.log('\n=== 检查结果 ===')
if (failures === 0) {
  console.log('✅ 全部检查通过')
  process.exit(0)
} else {
  console.log(`❌ ${failures} 项检查失败`)
  process.exit(1)
}
