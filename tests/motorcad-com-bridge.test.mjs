/**
 * L2 Motor-CAD COM 直驱（方案 Y）回归测试 —— motorcad-com-bridge.test.mjs
 *
 * 覆盖：
 *  1. bridge 脚本存在且 Python 语法可编译；
 *  2. 设计参数 → Motor-CAD 变量名映射（含挂起变量黑名单）；
 *  3. Python 解释器解析优先级；
 *  4. bridge 协议：ping 环境自检 / verify 快速失败（不启动 90s COM）；
 *  5. MotorCADSession：环境不就绪时抛可识别 reason（供方案 Z 兜底判定）。
 *
 * 不实测真求解（电磁分析约 190-200s，且需 Motor-CAD 授权），仅验证协议与降级判定。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const PY = process.env.MOTORCAD_TEST_PYTHON || 'C:/Users/15389/.workbuddy/binaries/python/versions/3.13.12/python.exe'
const MC_VENV = 'D:/MotorDesign/venv/Scripts/python.exe'
const MC_DIR = 'D:/Motor-CAD/11_1_5'

let pass = 0
let fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name) }
}

const mod = await import('../tools/l2/motorcad-verify.mjs')
const { MOTORCAD_BRIDGE_PATH, MOTORCAD_PARAM_CANDIDATES,
        expandDesignParams, resolveMotorcadPython, MotorCADSession } = mod

// 1. bridge 脚本
console.log('[1] bridge 脚本存在且可编译')
ok('scripts/motorcad_bridge.py 存在', existsSync(MOTORCAD_BRIDGE_PATH))
let compiled = true
try {
  execFileSync(PY, ['-m', 'py_compile', MOTORCAD_BRIDGE_PATH], { stdio: 'pipe' })
} catch (e) {
  // 沙箱偶发 EBUSY（同步 spawn 受限），退化为「脚本非空且可 JSON 协议通信」判定，
  // 真正的编译校验由 [4] 的 bridge 实际运行覆盖。
  if (e.code !== 'EBUSY') compiled = false
}
ok('py_compile 通过（EBUSY 时由 [4] 实跑覆盖）', compiled)

// 2. 参数映射
console.log('[2] 设计参数 → Motor-CAD 变量名映射')
const expanded = expandDesignParams({
  stator_od: 394, stator_bore: 250, core_length: 290, slots: 36, poles: 4,
  speed_rpm: 1500, Stator_Lam_Dia: 394,
})
ok('stator_od 展开为候选变量名', expanded['Stator_Lam_Dia'] === 394 && expanded['Stator_Lamination_Dia'] === 394)
ok('stator_bore/core_length/slots/poles 均有映射',
  expanded['Stator_Bore'] === 250 && expanded['Stator_Lam_Length'] === 290 &&
  expanded['Slot_Number'] === 36 && expanded['Pole_Number'] === 4)
ok('大写变量名原样透传', expanded['Stator_Lam_Dia'] === 394)
const allNames = Object.keys(expanded).join(',')
ok('不含会挂起的 OperatingSpeed', !allNames.includes('OperatingSpeed'))
ok('不含会挂起的 MaxTemperature', !allNames.includes('MaxTemperature'))
ok('候选表名不含黑名单变量', !JSON.stringify(MOTORCAD_PARAM_CANDIDATES).includes('OperatingSpeed'))

// 3. Python 解析优先级
console.log('[3] Python 解释器解析优先级')
const list = resolveMotorcadPython({ motorcadPython: 'C:/custom/py.exe', motorDesignRoot: 'D:/MotorDesign' })
ok('config.motorcadPython 优先', list[0] === 'C:/custom/py.exe')
ok('MOTORDESIGN_ROOT 派生 venv 路径', list.some((p) => p.includes('MotorDesign') && p.includes('python.exe')))
ok('末尾回落到 python/python3', list.includes('python') || list.includes('python3'))

// 4. bridge 协议（用真 bridge，不启动 COM）
function runBridge(py, payload, env = {}) {
  // 异步 spawn：同步 execFileSync 在受限沙箱下会 EBUSY
  return new Promise((resolve, reject) => {
    const child = spawn(py, [MOTORCAD_BRIDGE_PATH], {
      env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.on('error', reject)
    child.on('close', () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop()
      try { resolve(JSON.parse(line)) } catch (e) { reject(new Error(`bad json: ${line?.slice(0, 120)}`)) }
    })
    child.stdin.write(JSON.stringify(payload), 'utf8')
    child.stdin.end()
  })
}

console.log('[4] bridge 协议')
{
  const body = await runBridge(PY, { action: 'ping' })
  ok('ping 返回 ok=true', body.ok === true)
  ok('ping 含 pywin32/exe_exists/ready 字段',
    'pywin32' in body && 'exe_exists' in body && 'ready' in body)
}
if (existsSync(MC_VENV) && existsSync(MC_DIR)) {
  const body = await runBridge(MC_VENV, { action: 'ping' }, { MOTORCAD_INSTALL_DIR: MC_DIR })
  ok('MotorDesign venv: pywin32 可用', body.pywin32 === true)
  ok('MotorDesign venv: 找到 Motor-CAD exe', body.exe_exists === true)
  ok('MotorDesign venv: ready=true', body.ready === true)

  const bad = await runBridge(MC_VENV, { action: 'verify', mot_file: 'D:/definitely-not-exist.mot' },
    { MOTORCAD_INSTALL_DIR: MC_DIR })
  ok('mot 不存在 → 快速失败 mot_not_found（不等 90s COM）', bad.ok === false && bad.reason === 'mot_not_found')
} else {
  console.log('  ⚠️ 未找到 MotorDesign venv 或 Motor-CAD 安装目录，跳过环境自检用例')
}

// 5. Session：环境不就绪 → 可识别 reason（供方案 Z 兜底判定）
console.log('[5] MotorCADSession 环境不就绪时给出可识别 reason')
{
  const s = new MotorCADSession({ mode: 'com', motorcadPython: PY, motorDesignRoot: '' })
  let err = null
  try { await s.connect() } catch (e) { err = e }
  ok('connect 抛出错误（本机 managed python 无 pywin32）', !!err)
  ok('错误带 reason 字段（env_not_ready 等）', !!(err && err.reason))
  console.log(`     reason=${err?.reason}`)
}
{
  const s = new MotorCADSession({ mode: 'com', motorcadPython: 'C:/no/such/python.exe' })
  let err = null
  try { await s.connect() } catch (e) { err = e }
  // 若 PATH 上有可启动的 python 但缺 pywin32/Motor-CAD → env_not_ready；
  // 若所有解释器都启动不了 → python_unavailable。两者都可被方案 Z 识别。
  ok('解释器异常时给出可识别 reason',
    ['python_unavailable', 'env_not_ready'].includes(err?.reason))
  console.log(`     reason=${err?.reason}`)
}
{
  // 方案 X 预留：backend 模式未配置地址时必须明确报错，不静默降级
  const s = new MotorCADSession({ mode: 'backend', backendUrl: '' })
  let err = null
  try { await s.solve() } catch (e) { err = e }
  ok('backend 模式未配置 → backend_not_configured', err?.reason === 'backend_not_configured')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
