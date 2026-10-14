/**
 * L1/L2 运行环境统一探测（env-probe）
 * ============================================================
 * 用户授权使用 L1/L2 时，在真正启动 AEDT / Motor-CAD（耗时 60-120s）之前，
 * 先对本机环境做一次「体检」：
 *
 *   python     —— 解释器可用性（候选链与 tools/l2/motorcad-verify.mjs 一致）
 *   pywin32    —— L2 COM 直驱必需（pythoncom / win32com.client）
 *   pyaedt     —— L1 RMxprt 必需（pyaedt 0.6.x）
 *   aedt       —— L1 必需（Ansys AEDT 安装，扫描 ANSYSEM_ROOT / ProgramFiles）
 *   motorcad   —— L2 必需（Motor-CAD 安装，扫描 MOTORCAD_PATH / ProgramFiles）
 *
 * 探测结果每项含：status(ok|missing) / detail / fix（人话修复指引）。
 * 任一必需项缺失 → 上层用 buildEnvGuide() 返回结构化引导，**不白耗一次
 * 必然失败的 AEDT/COM 启动**。
 *
 * 设计约束：
 *   1. 全程只读探测，不安装、不改环境变量、不启动任何重型进程。
 *   2. spawn 一律异步（沙箱环境同步 spawn 会 EBUSY）。
 *   3. 不内置任何本机绝对路径字面量（部署环境配置由使用者提供，
 *      与 tools/l1/rmxprt-solve.mjs 的 resolveWorkerPath 同哲学）。
 *   4. aedt/motorcad 探测为 advisory：pyaedt 与 COM 自身还能从注册表
 *      定位安装，此处扫描不到不等于必然失败，指引文案如实说明。
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 探测项元数据：levels 声明该环境支撑哪些层级 */
export const PROBE_ITEMS = {
  python:   { label: 'Python 解释器', levels: ['l1', 'l2'], required: true },
  pywin32:  { label: 'pywin32 (COM 组件)', levels: ['l2'], required: true },
  pyaedt:   { label: 'pyaedt (RMxprt 驱动)', levels: ['l1'], required: true },
  aedt:     { label: 'Ansys AEDT', levels: ['l1'], required: true },
  motorcad: { label: 'Motor-CAD', levels: ['l2'], required: true },
}

const PROBE_TIMEOUT_MS = 20000

/** 异步 spawn 探测：返回 { code, stdout, stderr }，spawn 本身失败返回 code=-1 */
function runProbe(bin, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message || err) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: String(err?.message || err) })
    })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * Python 解释器候选链（与 tools/l2/motorcad-verify.mjs resolveMotorcadPython 对齐）。
 * @param {object} config 插件配置
 * @returns {string[]}
 */
export function resolvePythonCandidates(config = {}) {
  const candidates = []
  if (config.l1Python) candidates.push(config.l1Python)
  if (config.motorcadPython) candidates.push(config.motorcadPython)
  if (process.env.PYTHON_BIN) candidates.push(process.env.PYTHON_BIN)
  if (process.env.MOTORCAD_PYTHON) candidates.push(process.env.MOTORCAD_PYTHON)
  const root = config.motorDesignRoot || process.env.MOTORDESIGN_ROOT
  if (root) {
    candidates.push(join(root, 'Scripts', 'python310_win32', 'python.exe'))
    candidates.push(join(root, 'venv', 'Scripts', 'python.exe'))
    candidates.push(join(root, '.venv', 'Scripts', 'python.exe'))
  }
  candidates.push('python', 'python3')
  // 去重保序
  return [...new Set(candidates)]
}

/** 探测单个 Python 解释器：返回 { python, version } 或 null */
async function probeOnePython(py) {
  const r = await runProbe(py, ['-c', 'import sys; print(sys.version.split()[0])'], 15000)
  if (r.code === 0 && r.stdout.trim()) {
    return { python: py, version: r.stdout.trim() }
  }
  return null
}

/** python 探测：候选链中第一个可用的解释器 */
export async function probePython(config = {}) {
  const candidates = resolvePythonCandidates(config)
  const tried = []
  for (const py of candidates) {
    const hit = await probeOnePython(py)
    if (hit) {
      return { key: 'python', status: 'ok', python: hit.python, version: hit.version, tried }
    }
    tried.push(py)
  }
  return { key: 'python', status: 'missing', python: null, version: null, tried }
}

/**
 * 通用 Python 模块探测：`python -c "import <mod>"` + 可选版本表达式。
 * @param {string} python 已确认可用的解释器
 * @param {string} mods 模块名（空格分隔，全部 import）
 * @param {string} [versionExpr] 取版本表达式，如 "pyaedt.__version__"
 */
export async function probePythonModule(python, mods, versionExpr = '') {
  const code = versionExpr
    ? `import ${mods}; print(${versionExpr})`
    : `import ${mods}; print('ok')`
  const r = await runProbe(python, ['-c', code], 20000)
  if (r.code === 0 && r.stdout.trim()) {
    return { status: 'ok', version: r.stdout.trim() }
  }
  const lastLine = (r.stderr || '').trim().split('\n').slice(-1)[0] || ''
  return { status: 'missing', version: null, detail: lastLine.slice(0, 200) }
}

/** ANSYSEM_ROOT 类环境变量名（大小写变体都试） */
function envAny(...names) {
  for (const n of names) {
    const v = process.env[n]
    if (v && existsSync(v)) return v
  }
  return ''
}

/** 在目录下找 ansysedt.exe（最多扫两层子目录，防性能爆炸） */
function findAedtUnder(base, depth = 2) {
  if (!base || !existsSync(base)) return null
  // 直接命中
  const direct = join(base, 'ansysedt.exe')
  if (existsSync(direct)) return direct
  if (depth <= 0) return null
  let entries = []
  try { entries = readdirSync(base, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const hit = findAedtUnder(join(base, e.name), depth - 1)
    if (hit) return hit
  }
  return null
}

/** 常见盘符列表（工业软件常装 D/E 盘；existsSync 快速失败，枚举成本可忽略） */
function commonDrives() {
  return ['C', 'D', 'E', 'F']
}

/** 生成各盘常见安装根候选：X:\Program Files\<name> / X:\Program Files (x86)\<name> / X:\<name> */
function commonInstallRoots(name) {
  const roots = []
  for (const d of commonDrives()) {
    roots.push(`${d}:\\Program Files\\${name}`)
    roots.push(`${d}:\\Program Files (x86)\\${name}`)
    roots.push(`${d}:\\${name}`)
  }
  return roots
}

/**
 * AEDT 安装探测（advisory：pyaedt 自身还能从注册表定位）。
 * 扫描：ANSYSEM_ROOT / AESL_ROOT / AEDT_ROOT > 各盘 Program Files\AnsysEM 两层。
 */
export function probeAedt() {
  const root = envAny('ANSYSEM_ROOT', 'ANSYS_EM_ROOT', 'AEDT_ROOT')
  if (root) {
    const exe = findAedtUnder(root, 3)
    if (exe) return { key: 'aedt', status: 'ok', path: exe, source: 'env' }
  }
  for (const base of commonInstallRoots('AnsysEM')) {
    const exe = findAedtUnder(base, 2)
    if (exe) return { key: 'aedt', status: 'ok', path: exe, source: 'scan' }
  }
  for (const base of commonInstallRoots('Ansys Inc')) {
    const exe = findAedtUnder(base, 2)
    if (exe) return { key: 'aedt', status: 'ok', path: exe, source: 'scan' }
  }
  return { key: 'aedt', status: 'missing', path: null, source: null }
}

/**
 * Motor-CAD 安装探测（与 scripts/motorcad_bridge.py _find_exe 同候选）：
 * MOTORCAD_PATH / MOTORCAD_EXE_PATH / MOTORCAD_INSTALL_DIR > 各盘扫描
 * （盘根 Motor-CAD + Program Files\Motor-CAD，含 11_1_5 版本子目录）。
 */
export function probeMotorcad() {
  const exeEnv = process.env.MOTORCAD_PATH || process.env.MOTORCAD_EXE_PATH || ''
  if (exeEnv && existsSync(exeEnv)) {
    return { key: 'motorcad', status: 'ok', path: exeEnv, source: 'env' }
  }
  const instDir = process.env.MOTORCAD_INSTALL_DIR || ''
  if (instDir) {
    for (const nm of ['Motor-CAD_11_1_5.exe', 'Motor-CAD.exe']) {
      const p = join(instDir, nm)
      if (existsSync(p)) return { key: 'motorcad', status: 'ok', path: p, source: 'env' }
    }
  }
  for (const base of commonInstallRoots('Motor-CAD')) {
    const direct = join(base, 'Motor-CAD.exe')
    if (existsSync(direct)) return { key: 'motorcad', status: 'ok', path: direct, source: 'scan' }
    if (existsSync(base)) {
      let subs = []
      try { subs = readdirSync(base) } catch { /* 忽略 */ }
      for (const sub of subs.sort().reverse()) {
        for (const nm of ['Motor-CAD_11_1_5.exe', 'Motor-CAD.exe']) {
          const p = join(base, sub, nm)
          if (existsSync(p)) return { key: 'motorcad', status: 'ok', path: p, source: 'scan' }
        }
      }
    }
  }
  return { key: 'motorcad', status: 'missing', path: null, source: null }
}

/** 各探测项的人话修复指引 */
const FIX_HINTS = {
  python: {
    hint: '未找到可用的 Python 解释器（已按配置/环境变量/PATH 顺序探测全部失败）',
    steps: [
      '1. 安装 Python 3.10.x（RMxprt worker 与 pyaedt 0.6.x 的验证版本）：https://www.python.org/downloads/',
      '2. 安装时勾选 "Add Python to PATH"',
      '3. 重启 DSH Desktop 后重试；或在 DSH 配置中设置 l1Python / motorcadPython 指向解释器完整路径',
    ],
  },
  pywin32: {
    hint: 'Python 缺少 pywin32（L2 COM 直驱必需）',
    steps: [
      '1. 用探测到的解释器执行：pip install pywin32',
      '2. 安装后执行一次：python Scripts/pywin32_postinstall.py -install（注册 COM 支持）',
      '3. 若使用独立 venv，在 DSH 配置中设置 motorcadPython 指向该 venv 的 python.exe',
    ],
  },
  pyaedt: {
    hint: 'Python 缺少 pyaedt（L1 RMxprt 驱动）',
    steps: [
      '1. 用探测到的解释器执行：pip install "pyaedt==0.6.*"',
      '2. pyaedt 需要 Python 3.8-3.10；请勿使用 3.11+',
      '3. 若使用独立 venv，在 DSH 配置中设置 l1Python 指向该 venv 的 python.exe',
    ],
  },
  aedt: {
    hint: '未在常见位置找到 Ansys AEDT 安装',
    steps: [
      '1. 安装 Ansys AEDT 2020.x（RMxprt 内置版本）：https://www.ansys.com/products/electronics',
      '2. 或设置环境变量 ANSYSEM_ROOT 指向 AEDT 安装根目录（含 ansysedt.exe 的目录）',
      '3. 若 AEDT 装在非常规位置，pyaedt 仍可能从注册表定位——可先试跑一次 L1',
    ],
  },
  motorcad: {
    hint: '未在常见位置找到 Motor-CAD 安装',
    steps: [
      '1. 安装 Motor-CAD 11.1.5：https://www.motor-design.com/',
      '2. 或设置环境变量 MOTORCAD_PATH 指向 Motor-CAD.exe 完整路径（目录亦可，用 MOTORCAD_INSTALL_DIR）',
      '3. 安装后首次使用需在 Motor-CAD 内开启单客户端模式（Tools > Options 菜单 id=94 对应项）',
    ],
  },
}

/**
 * 环境未就绪的结构化引导（对齐 lib/license.mjs buildActivationGuide 风格）。
 * @param {'l1'|'l2'} level
 * @param {Array<object>} missingItems probeAll 结果中 status==='missing' 的项
 * @returns {object}
 */
export function buildEnvGuide(level, missingItems) {
  const layerName = level === 'l1' ? 'L1 (RMxprt)' : 'L2 (Motor-CAD)'
  const names = missingItems.map((m) => PROBE_ITEMS[m.key]?.label || m.key).join('、')
  const nextSteps = []
  for (const m of missingItems) {
    const fix = FIX_HINTS[m.key]
    if (fix) nextSteps.push(...fix.steps)
  }
  nextSteps.push('环境就绪后重新调用本工具；或调用 motor_env_check 随时一键体检')
  // 重编号：多缺失项拼接后原编号会重复（1./2./3. × N），统一为连续序号
  const numbered = nextSteps.map((s, i) => `${i + 1}. ${s.replace(/^\d+\.\s*/, '')}`)
  return {
    status: 'env_not_ready',
    error: 'ENV_NOT_READY',
    level,
    message: `${layerName} 运行环境不完整：缺少 ${names}。已跳过启动 AEDT/Motor-CAD（避免无谓等待），请按指引补齐后重试。`,
    missing: missingItems.map((m) => m.key),
    probe: missingItems,
    action: {
      hint: '按下方 guide.nextSteps 补齐环境；缺什么补什么，已就绪的项无需重装',
      contact: '13546196530@163.com',
    },
    guide: {
      hint: `缺少：${names}`,
      nextSteps: numbered,
      envCheckTool: 'motor_env_check',
    },
  }
}

/**
 * L1 环境探测：python → pyaedt → aedt（advisory）。
 * @param {object} config
 * @returns {Promise<{ level:'l1', ready:boolean, items:Array<object>, missing:Array<object> }>}
 */
export async function probeL1(config = {}) {
  const items = []
  const py = await probePython(config)
  items.push(py)
  if (py.status === 'ok') {
    const pa = await probePythonModule(py.python, 'pyaedt', 'pyaedt.__version__')
    items.push({ key: 'pyaedt', status: pa.status, version: pa.version, python: py.python, detail: pa.detail })
  } else {
    items.push({ key: 'pyaedt', status: 'missing', version: null, detail: '无可用 Python，跳过' })
  }
  items.push(probeAedt())
  const missing = items.filter((i) => i.status === 'missing')
  return { level: 'l1', ready: missing.length === 0, items, missing }
}

/**
 * L2 环境探测：python → pywin32 → motorcad（advisory）。
 * @param {object} config
 */
export async function probeL2(config = {}) {
  const items = []
  const py = await probePython(config)
  items.push(py)
  if (py.status === 'ok') {
    const pw = await probePythonModule(py.python, 'pythoncom, win32com.client')
    items.push({ key: 'pywin32', status: pw.status, python: py.python, detail: pw.detail })
  } else {
    items.push({ key: 'pywin32', status: 'missing', detail: '无可用 Python，跳过' })
  }
  items.push(probeMotorcad())
  const missing = items.filter((i) => i.status === 'missing')
  return { level: 'l2', ready: missing.length === 0, items, missing }
}

/**
 * 全量探测（L1 + L2 合并，python 只探一次）。
 * @param {object} config
 * @returns {Promise<{ l1:object, l2:object, python:object }>}
 */
export async function probeAll(config = {}) {
  const py = await probePython(config)

  const l1Items = [
    py,
    py.status === 'ok'
      ? { key: 'pyaedt', ...(await probePythonModule(py.python, 'pyaedt', 'pyaedt.__version__')), python: py.python }
      : { key: 'pyaedt', status: 'missing', version: null, detail: '无可用 Python' },
    probeAedt(),
  ]
  const l2Items = [
    py,
    py.status === 'ok'
      ? { key: 'pywin32', ...(await probePythonModule(py.python, 'pythoncom, win32com.client')), python: py.python }
      : { key: 'pywin32', status: 'missing', detail: '无可用 Python' },
    probeMotorcad(),
  ]
  const mk = (level, items) => {
    const missing = items.filter((i) => i.status === 'missing')
    return { level, ready: missing.length === 0, items, missing }
  }
  return { python: py, l1: mk('l1', l1Items), l2: mk('l2', l2Items) }
}

/**
 * 生成人话体检报告文本（motor_env_check 工具输出用）。
 * @param {{ python:object, l1:object, l2:object }} all probeAll 结果
 * @returns {string}
 */
export function formatProbeReport(all) {
  const lines = []
  const fmt = (item) => {
    const meta = PROBE_ITEMS[item.key] || { label: item.key }
    const icon = item.status === 'ok' ? '✅' : '❌'
    let detail = ''
    if (item.key === 'python' && item.status === 'ok') detail = `${item.python} (${item.version})`
    else if (item.version) detail = item.version
    else if (item.path) detail = item.path
    else if (item.detail) detail = item.detail
    return `  ${icon} ${meta.label}${detail ? '：' + detail : ''}`
  }
  lines.push('== 公共环境 ==')
  lines.push(fmt(all.python))
  lines.push('')
  lines.push(`== L1 (RMxprt) ${all.l1.ready ? '✅ 就绪' : '❌ 未就绪'} ==`)
  all.l1.items.filter((i) => i.key !== 'python').forEach((i) => lines.push(fmt(i)))
  lines.push('')
  lines.push(`== L2 (Motor-CAD) ${all.l2.ready ? '✅ 就绪' : '❌ 未就绪'} ==`)
  all.l2.items.filter((i) => i.key !== 'python').forEach((i) => lines.push(fmt(i)))
  const missing = [...all.l1.missing, ...all.l2.missing].filter(
    (m, i, arr) => arr.findIndex((x) => x.key === m.key) === i
  )
  if (missing.length) {
    lines.push('')
    lines.push('== 修复指引 ==')
    for (const m of missing) {
      const fix = FIX_HINTS[m.key]
      if (fix) {
        lines.push(`▸ ${fix.hint}`)
        fix.steps.forEach((s) => lines.push(`  ${s}`))
      }
    }
  } else {
    lines.push('')
    lines.push('🎉 L1/L2 环境全部就绪，可直接调用精细解算工具。')
  }
  return lines.join('\n')
}

export default {
  PROBE_ITEMS, resolvePythonCandidates, probePython, probePythonModule,
  probeAedt, probeMotorcad, probeL1, probeL2, probeAll, buildEnvGuide,
  formatProbeReport,
}
