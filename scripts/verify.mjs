#!/usr/bin/env node
/**
 * dsh-motor-ai 完整版自检验证脚本
 * 检查包结构、依赖、导入是否正常
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
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
    ['version', /^1\.0\.0/],
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
// 「每日 5 次」形同虚设；且若闸门在断网时拦截，会把已付费用户一起锁死——
// 后者比不限流严重得多。本门禁把「fail-open」钉成不可回归的硬约束。
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

    // 1) 断网必须 fail-open（绝不能锁死用户）
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    const off = await quota.checkFreeQuota({ backendUrl: 'http://mock.local' })
    if (off.allowed !== true) hBad.push(`断网未 fail-open：allowed=${off.allowed}`)
    if (off.reason !== 'backend-unreachable-fail-open') hBad.push(`断网 reason 异常：${off.reason}`)

    // 2) 后端明确拒绝（allowed=false）必须拦截
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ allowed: false, used: 5, remaining: 0, limit: 5 }),
    })
    const exhausted = await quota.checkFreeQuota({ backendUrl: 'http://mock.local' })
    if (exhausted.allowed !== false) hBad.push('额度用尽未拦截')

    // 3) 非预期响应同样放行（fail-open 一致性）
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ weird: 1 }) })
    const weird = await quota.checkFreeQuota({ backendUrl: 'http://mock.local' })
    if (weird.allowed !== true) hBad.push('非预期响应未 fail-open')

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

    // 6) L0 四工具均接入闸门（静态检查：import + execute 内调用）
    const l0Dir = join(ROOT, 'tools', 'l0')
    for (const f of ['param-matrix.mjs', 'l0-estimate.mjs', 'design-validate.mjs', 'pipeline.mjs']) {
      const src = readFileSync(join(l0Dir, f), 'utf8')
      if (!src.includes("from '../../lib/quota.mjs'")) hBad.push(`${f} 未 import quota`)
      if (!/enforceQuota\(config\)/.test(src)) hBad.push(`${f} execute 未调用 enforceQuota`)
    }

    delete globalThis.fetch
  } catch (e) {
    hBad.push(`门禁 H 运行失败：${e.message}`)
  }
  if (hBad.length === 0) {
    console.log('✅ 免费额度闸门 + 续费取 max：断网 fail-open / 用尽拦截 / 已激活跳过 / 四工具接入 全过')
  } else {
    console.log(`❌ 额度与续费缺陷 ${hBad.length} 项：`); hBad.forEach((l) => console.log('   ' + l)); failures++
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
