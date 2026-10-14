/**
 * env-probe / motor_env_check / worker --preflight 测试
 * 运行：node tests/env-probe.test.mjs
 * 原则：不依赖真实 AEDT/Motor-CAD 安装（用临时目录 + env 变量 mock）；
 *       python 模块探测用真实解释器（缺模块 = missing，正是要验的路径）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  PROBE_ITEMS, resolvePythonCandidates, probePython, probePythonModule,
  probeAedt, probeMotorcad, probeL1, probeL2, probeAll,
  buildEnvGuide, formatProbeReport,
} from '../lib/env-probe.mjs'

let passed = 0
let failed = 0
const failures = []
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`✅ ${name}`) }
  else { failed++; failures.push(name); console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

const here = join(fileURLToPath(import.meta.url), '..', '..')
const WORKER = join(here, 'scripts', '_rmxprt_venv_worker.py')

// ---------- 1) 候选链 ----------
console.log('\n== resolvePythonCandidates 候选链 ==')
{
  const old = { ...process.env }
  delete process.env.PYTHON_BIN
  delete process.env.MOTORCAD_PYTHON
  delete process.env.MOTORDESIGN_ROOT
  const c = resolvePythonCandidates({})
  ok(c[0] === 'python' && c[1] === 'python3', '空配置 → PATH 兜底 [python, python3]', c.join(','))
  ok(resolvePythonCandidates({ l1Python: 'X:\\py.exe' })[0] === 'X:\\py.exe', 'l1Python 最高优先')
  process.env.PYTHON_BIN = 'Y:\\py.exe'
  ok(resolvePythonCandidates({ l1Python: 'X:\\py.exe' })[1] === 'Y:\\py.exe', 'PYTHON_BIN 次优先')
  const dedup = resolvePythonCandidates({ l1Python: 'python' })
  ok(dedup.filter((x) => x === 'python').length === 1, '候选去重（python 只出现一次）')
  process.env = old
}

// ---------- 2) buildEnvGuide ----------
console.log('\n== buildEnvGuide 结构化引导 ==')
{
  const missing = [{ key: 'pyaedt', status: 'missing' }, { key: 'aedt', status: 'missing' }]
  const g = buildEnvGuide('l1', missing)
  ok(g.status === 'env_not_ready' && g.error === 'ENV_NOT_READY', 'status/error 标记')
  ok(g.level === 'l1', 'level 透传')
  ok(JSON.stringify(g.missing) === '["pyaedt","aedt"]', 'missing 键列表')
  ok(g.message.includes('pyaedt') && g.message.includes('Ansys AEDT'), 'message 含人类可读缺失项名')
  const steps = g.guide.nextSteps
  ok(steps.length === 7 && steps.every((s, i) => s.startsWith(`${i + 1}.`)),
    'nextSteps 编号连续 1..N（3+3+1）', steps.map((s) => s.slice(0, 10)).join('|'))
  ok(g.guide.envCheckTool === 'motor_env_check', '引导指向一键体检工具')
  const g2 = buildEnvGuide('l2', [{ key: 'pywin32' }, { key: 'motorcad' }])
  ok(g2.message.includes('pywin32') && g2.message.includes('Motor-CAD'), 'l2 缺失项名映射')
}

// ---------- 3) probeAedt / probeMotorcad（临时目录 mock）----------
console.log('\n== probeAedt / probeMotorcad（mock 文件系统）==')
{
  const dir = mkdtempSync(join(tmpdir(), 'envprobe-'))
  const fakeAedt = join(dir, 'AnsysEM', 'v201', 'Win64')
  mkdirSync(fakeAedt, { recursive: true })
  writeFileSync(join(fakeAedt, 'ansysedt.exe'), 'fake')
  const fakeMc = join(dir, 'Motor-CAD', '11_1_5')
  mkdirSync(fakeMc, { recursive: true })
  writeFileSync(join(fakeMc, 'Motor-CAD_11_1_5.exe'), 'fake')

  const old = { ...process.env }
  process.env.ANSYSEM_ROOT = join(dir, 'AnsysEM')
  process.env.MOTORCAD_INSTALL_DIR = join(dir, 'Motor-CAD', '11_1_5')
  const a = probeAedt()
  ok(a.status === 'ok' && a.path.includes('ansysedt.exe'), 'AEDT env 根命中', a.path || '')
  ok(a.source === 'env', 'AEDT 来源标记 env')
  const m = probeMotorcad()
  ok(m.status === 'ok' && m.path.includes('Motor-CAD_11_1_5.exe'), 'Motor-CAD install_dir 命中', m.path || '')

  delete process.env.ANSYSEM_ROOT
  delete process.env.MOTORCAD_INSTALL_DIR
  const a2 = probeAedt()
  ok(a2.status === 'ok' && a2.source === 'scan', 'AEDT 回退全盘扫描命中（临时目录在 C/D 盘时）', a2.source || a2.status)
  process.env = old
  rmSync(dir, { recursive: true, force: true })

  // 明确缺失：指向不存在路径
  process.env.MOTORCAD_PATH = join(tmpdir(), 'definitely-not-exist', 'Motor-CAD.exe')
  const m2 = probeMotorcad()
  ok(m2.status === 'missing' || m2.source === 'scan', 'MOTORCAD_PATH 无效时回退扫描/缺失（不误报 ok）', m2.status)
  delete process.env.MOTORCAD_PATH
}

// ---------- 4) probePython / probePythonModule（真实解释器）----------
console.log('\n== probePython / probePythonModule（真实解释器）==')
{
  const py = await probePython({})
  ok(py.status === 'ok' && py.version, 'PATH python 可用（沙箱 node 环境必有）', py.python || '')
  const mod = await probePythonModule(py.python, 'json', '')
  ok(mod.status === 'ok', '标准库 json import → ok')
  const missing = await probePythonModule(py.python, 'definitely_not_installed_xyz')
  ok(missing.status === 'missing' && missing.detail, '不存在的模块 → missing + detail')
}

// ---------- 5) probeAll 集成 ----------
console.log('\n== probeAll 集成结构 ==')
{
  const all = await probeAll({})
  ok(all.python.status === 'ok', 'probeAll.python ok')
  ok(['l1', 'l2'].every((k) => all[k] && Array.isArray(all[k].items) && Array.isArray(all[k].missing)), 'l1/l2 含 items/missing')
  ok(all.l1.items.some((i) => i.key === 'pyaedt') && all.l1.items.some((i) => i.key === 'aedt'), 'l1 项含 pyaedt+aedt')
  ok(all.l2.items.some((i) => i.key === 'pywin32') && all.l2.items.some((i) => i.key === 'motorcad'), 'l2 项含 pywin32+motorcad')
  const report = formatProbeReport(all)
  ok(report.includes('== 公共环境 ==') && report.includes('修复指引'), '报告文本结构')
  ok(typeof report === 'string' && report.length > 50, '报告非空文本')
}

// ---------- 6) worker --preflight（异步 spawn）----------
console.log('\n== worker --preflight ==')
{
  const r = await new Promise((resolve) => {
    const child = spawn('python', [WORKER, '--preflight'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('error', () => resolve({ code: -1, out: '' }))
    child.on('close', (code) => resolve({ code, out }))
  })
  ok(r.code === 0, 'worker --preflight 退出码 0', String(r.code))
  let parsed = null
  try { parsed = JSON.parse(r.out.trim().split('\n').pop()) } catch { /* ignore */ }
  ok(parsed && typeof parsed.ok === 'boolean', '输出单行 JSON 含 ok 布尔', r.out.slice(0, 120))
  ok(parsed && Array.isArray(parsed.hints), '输出含 hints 数组')
  ok(parsed && ('pyaedt' in parsed) && ('pywin32' in parsed) && ('aedt_exe' in parsed), '输出含 pyaedt/pywin32/aedt_exe 字段')
  // 缺参数防呆（非 preflight 模式）
  const r2 = await new Promise((resolve) => {
    const child = spawn('python', [WORKER], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(err))
  })
  ok(r2.includes('--params') && r2.includes('--preflight'), '缺参数时报错文案同时提示两种模式', r2.slice(-80))
}

// ---------- 汇总 ----------
console.log(`\n===== env-probe: ${passed} passed, ${failed} failed =====`)
if (failed) { console.log('失败项:', failures.join(' | ')); process.exit(1) }
