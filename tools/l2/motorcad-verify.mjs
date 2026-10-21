/**
 * L2 Motor-CAD 验证工具
 * ============================================================
 * 通过 COM 接口调用 Motor-CAD v11.1.5 执行精细验证。
 * 
 * 实现计划:
 *   - motor_l2_validate: 几何一致性校验
 *   - motor_motorcad_verify: COM 精细验证（电磁+热）
 * 
 * 前置条件:
 *   - Motor-CAD v11.1.5 已安装
 *   - ActiveX 设置为"单客户端设置"（非"免注册"）
 *   - COM STA 线程模型（所有调用在同一线程）
 */

import { resolveMotorType } from '@wangxue98/dsh-motor-ai-core'
import { existsSync } from 'node:fs'
import { join as joinPath, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { getL1L2License, buildActivationGuide, CONTACT_EMAIL } from '../../lib/license.mjs'
import { enforceQuota } from '../../lib/quota.mjs'
import { probeL2, buildEnvGuide } from '../../lib/env-probe.mjs'
import { getUsageSink, logUsage } from '@wangxue98/dsh-motor-ai-core'
import { scheduleTelemetry } from '../../lib/telemetry.mjs'
import { withFaultAssistHint } from '../../lib/fault-report.mjs'

/** bridge 脚本路径（随包分发：scripts/motorcad_bridge.py） */
const _here = dirname(fileURLToPath(import.meta.url))
export const MOTORCAD_BRIDGE_PATH = joinPath(_here, '..', '..', 'scripts', 'motorcad_bridge.py')

/**
 * 设计参数 → Motor-CAD 变量名候选表。
 * 不同 .mot 模块（BPM-Therm / Emag）变量名不一致，故给多个候选，
 * bridge 侧逐个 SetVariable，失败的自动跳过（applied_params 会记录哪些成功）。
 * ⚠️ 禁止放入 OperatingSpeed / MaxTemperature —— 已确认会导致 COM 挂起。
 */
export const MOTORCAD_PARAM_CANDIDATES = {
  stator_od: ['Stator_Lam_Dia', 'Stator_Lamination_Dia'],
  stator_bore: ['Stator_Bore'],
  core_length: ['Stator_Lam_Length', 'Motor_Length'],
  slots: ['Slot_Number', 'Slots'],
  poles: ['Pole_Number', 'Poles'],
  turns_per_coil: ['Turns_per_Coil'],
  speed_rpm: ['Speed', 'Shaft_Speed'],
  voltage: ['Supply_Voltage', 'DCBusVoltage'],
  peak_current: ['PeakCurrent'],
  dc_bus_voltage: ['DCBusVoltage'],
  // 齿宽（网格化关键，历史 BUG11：450kW 实机 677mm/18 槽时齿宽与模板默认值
  // 不自洽 → DoMagneticCalculation 报 "Failed to mesh"。必须允许显式透传）
  tooth_width: ['Tooth_Width'],
}

/**
 * 网格化自洽预检（历史 BUG11 防线）。
 * 注意：齿宽物理上无法由外径/槽数唯一推导（齿距 π·Dsi/Qs 只是上界，
 * 具体齿宽取决于槽形设计）——因此这里**不做伪造推导**，只做两类可靠判定：
 *   1. 缺 tooth_width 且给了外径/内径+槽数 → 警告（齿宽保持模板默认值，
 *      可能不自洽导致 Failed to mesh，建议显式提供）；
 *   2. 给了 tooth_width 且能算齿距 → 几何不可能性校验（齿宽 ≥ 齿距必失败）。
 * @param {object} design 设计对象（含 slots/stator_od/stator_bore/tooth_width 或 Motor-CAD 原名）
 * @returns {{ warnings: string[], checked: object }}
 */
export function buildMeshPrecheck(design = {}) {
  const d = design || {}
  const pick = (...keys) => {
    for (const k of keys) {
      const v = Number(d[k])
      if (Number.isFinite(v) && v > 0) return v
    }
    return null
  }
  const slots = pick('slots', 'Qs', 'Slot_Number', 'Slots')
  const od = pick('stator_od', 'Stator_Lam_Dia', 'Stator_Lamination_Dia')
  const bore = pick('stator_bore', 'Stator_Bore')
  const tooth = pick('tooth_width', 'Tooth_Width')
  const warnings = []
  if (tooth == null && (od != null || bore != null) && slots != null) {
    warnings.push(
      '缺 tooth_width（Tooth_Width）：齿宽将保持 .mot 模板默认值，可能与外径/槽数不自洽，' +
      '导致 DoMagneticCalculation 报 "Failed to mesh"（历史 BUG11）。建议显式提供 tooth_width。'
    )
  }
  if (tooth != null && bore != null && slots != null) {
    const pitch = (Math.PI * bore) / slots
    if (tooth >= pitch) {
      warnings.push(
        `tooth_width=${tooth} ≥ 齿距 π×Dsi/Qs=${pitch.toFixed(1)}mm（Dsi=${bore}, Qs=${slots}）：` +
        '几何不可能，网格化必失败，请核对齿宽与槽数。'
      )
    }
  }
  return { warnings, checked: { tooth_width: tooth, stator_bore: bore, stator_od: od, slots } }
}

/** 额定功率提取（W）：L0/L2 设计对象的常用字段名穷举（含 spec 嵌套与 kW 变体） */
export function extractRatedPowerW(design = {}) {
  const srcs = [design, design?.spec, design?.rated].filter(Boolean)
  for (const s of srcs) {
    for (const k of ['rated_power', 'rated_power_w', 'power', 'power_w', 'P_N', 'pn', 'Pn']) {
      const v = Number(s?.[k])
      if (Number.isFinite(v) && v > 0) return v
    }
  }
  for (const s of srcs) {
    for (const k of ['rated_power_kw', 'power_kw']) {
      const v = Number(s?.[k])
      if (Number.isFinite(v) && v > 0) return v * 1000
    }
  }
  return null
}

/**
 * L2 外径上限自适应（B 增强）：旧版写死 500mm 误杀 400/450kW 大机座。
 * 显式传入 limits.statorOdLimit 优先；否则按额定功率经验曲线给宽松上限
 * （留 ~30% 余量，至少 600mm）；功率未知时给 1000mm 兜底，避免误杀任意大机座。
 * @param {number|null} powerW 额定功率（W）；可来自 extractRatedPowerW
 * @returns {number}
 */
export function adaptiveStatorOdLimit(powerW) {
  if (!Number.isFinite(powerW) || powerW <= 0) return 1000
  const kw = powerW / 1000
  return Math.max(600, Math.round(kw * 1.5 + 200))
}

/**
 * L2 几何一致性校验（纯函数，可单测；motor_l2_validate 内部调用）。
 * A 增强：兼容 L0 顶层字段名 与 Motor-CAD 原名 双口径，消除 400kW「铁芯长度必须 > 0」；
 * B 增强：外径上限随额定功率自适应（limits.statorOdLimit 优先）。
 * @param {object} geo 几何参数（支持 stator_od/core_length/stator_bore 或 Stator_Lam_Dia/Stator_Lam_Length/Stator_Bore 双口径）
 * @param {object} [limits] 约束上限（limits.statorOdLimit 可显式覆盖）
 * @returns {{ issues: string[], warnings: string[] }}
 */
export function validateL2Geometry(geo = {}, limits = {}) {
  const issues = []
  const warnings = []
  const pickGeo = (...keys) => {
    for (const k of keys) {
      const v = Number(geo?.[k])
      if (Number.isFinite(v) && v > 0) return v
    }
    return null
  }
  const statorLamDia = pickGeo('stator_od', 'Stator_Lam_Dia', 'Stator_Lamination_Dia')
  const statorBore = pickGeo('stator_bore', 'Stator_Bore')
  const statorLamLength = pickGeo('core_length', 'Stator_Lam_Length', 'Motor_Length')

  // 检查定子内径 < 外径
  if (statorBore != null && statorLamDia != null && statorBore >= statorLamDia) {
    issues.push('定子内径 ≥ 定子外径，几何冲突')
  }
  // 检查铁芯长度 > 0
  if (statorLamLength == null || statorLamLength <= 0) {
    issues.push('铁芯长度必须 > 0')
  }
  // 检查外径上限（B 增强：随额定功率自适应；limits.statorOdLimit 优先）
  const odLimit = limits.statorOdLimit ?? adaptiveStatorOdLimit(extractRatedPowerW({ ...geo }))
  if (statorLamDia != null && statorLamDia > odLimit) {
    warnings.push(`定子外径 ${statorLamDia}mm 超过上限 ${odLimit}mm`)
  }
  return { issues, warnings }
}

/**
 * L2 失败分支统一"反馈动作"字段：任何失败都告诉用户"找谁 + 带什么信息"。
 * 背景：分发机器常处于失联状态（后端不可达），邮件是唯一回传通道；
 * 之前仅"未激活/配额用尽"两条路径带邮箱，L2 运行期失败全路径零覆盖。
 * @param {object} [err] 捕获到的错误（可空）
 * @returns {{ contact: string, how: string[] }}
 */
export function buildL2ReportField(err = null) {
  const tail = err ? [`出错原因（reason）：${err.reason || 'unknown'}`] : []
  return {
    contact: CONTACT_EMAIL,
    how: [
      '1. 附上本返回中失败字段全文（error / com_error / com_reason / missing / guide）',
      '2. 运行 motor_env_check，附上体检报告文本',
      '3. 用上述邮箱联系作者，标题注明「dsh-motor-ai L2 反馈」',
      ...tail,
    ],
  }
}

/** 把设计对象展开成 {MotorCAD变量名: 值}（含全部候选名） */
export function expandDesignParams(design = {}) {
  const out = {}
  for (const [key, candidates] of Object.entries(MOTORCAD_PARAM_CANDIDATES)) {
    const v = design?.[key]
    if (v === undefined || v === null) continue
    for (const name of candidates) out[name] = v
  }
  // design 里若已直接给 Motor-CAD 变量名（如 Stator_Bore），原样透传
  for (const [k, v] of Object.entries(design)) {
    if (/^[A-Z]/.test(k) && typeof v !== 'object') out[k] = v
  }
  return out
}

/** 解析可用的 Python 解释器（含 pywin32 的那个） */
export function resolveMotorcadPython(config = {}) {
  const candidates = []
  if (config.motorcadPython) candidates.push(config.motorcadPython)
  if (process.env.MOTORCAD_PYTHON) candidates.push(process.env.MOTORCAD_PYTHON)
  const root = config.motorDesignRoot || process.env.MOTORDESIGN_ROOT
  if (root) {
    candidates.push(joinPath(root, 'venv', 'Scripts', 'python.exe'))
    candidates.push(joinPath(root, '.venv', 'Scripts', 'python.exe'))
  }
  candidates.push('python', 'python3')
  return candidates
}

/** 运行 bridge：返回解析后的 JSON；stderr 仅作诊断日志 */
function runBridge(python, payload, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    if (!existsSync(MOTORCAD_BRIDGE_PATH)) {
      reject(Object.assign(new Error(`bridge 脚本缺失: ${MOTORCAD_BRIDGE_PATH}`),
        { reason: 'bridge_missing' }))
      return
    }
    const child = spawn(python, [MOTORCAD_BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { child.kill('SIGKILL') } catch { /* noop */ }
      reject(Object.assign(new Error(`Motor-CAD 求解超时（${timeoutMs}ms）`),
        { reason: 'timeout' }))
    }, timeoutMs)

    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => {
      if (done) return
      done = true; clearTimeout(timer)
      reject(Object.assign(new Error(`无法启动 Python(${python}): ${e.message}`),
        { reason: 'python_unavailable' }))
    })
    child.on('close', (code) => {
      if (done) return
      done = true; clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop()
      if (!line) {
        const e = new Error(`bridge 无输出（exit=${code}）${err ? ' | ' + err.slice(-300) : ''}`)
        reject(Object.assign(e, { reason: 'no_output', stderr: err }))
        return
      }
      try {
        resolve({ body: JSON.parse(line), exitCode: code, stderr: err })
      } catch {
        reject(Object.assign(new Error(`bridge 输出非 JSON: ${line.slice(0, 200)}`),
          { reason: 'bad_json', stderr: err }))
      }
    })
    try {
      child.stdin.write(JSON.stringify(payload), 'utf8')
      child.stdin.end()
    } catch (e) {
      done = true; clearTimeout(timer)
      reject(Object.assign(new Error(`写入 bridge 失败: ${e.message}`), { reason: 'stdin_failed' }))
    }
  })
}

/**
 * Motor-CAD 会话（方案 Y：本机 COM 直驱为主）
 *
 * 三模式（config.motorcadMode）：
 *  - 'com'（默认）：spawn python + pywin32 直驱本机 Motor-CAD COM；
 *  - 'backend'：方案 X 预留接口 —— POST {backend}/api/motorcad/solve（后端未实现时明确报错，不静默降级）；
 *  - 'auto'：先 com，失败再 backend。
 *
 * 五方法保持旧契约（connect/loadMotFile/setVariable/solve/getResults/disconnect），
 * 但内部合并为「一次 bridge 进程跑完全流程」——避免每次命令都重新走
 * 90 秒 COM 启动等待。
 */
export class MotorCADSession {
  constructor(opts = {}) {
    this._opts = opts
    this._mode = opts.mode || 'com'
    this._connected = false
    this._motFile = null
    this._vars = {}
    this._result = null
    this._python = null
    this._timeoutMs = Number(opts.timeoutMs || 600000)
    this._ratedPowerW = Number(opts.ratedPowerW || 0) || null
  }

  /** 环境自检（ping）：确认 python+pywin32+Motor-CAD 齐全 */
  async connect() {
    if (this._mode === 'backend') { this._connected = true; return true }
    const candidates = resolveMotorcadPython(this._opts)
    let lastErr = null
    const reasons = []
    for (const py of candidates) {
      try {
        const { body } = await runBridge(py, {
          action: 'ping',
          exe_path: this._opts.motorcadPath || process.env.MOTORCAD_PATH || '',
          install_dir: this._opts.motorcadInstallDir || process.env.MOTORCAD_INSTALL_DIR || '',
          progid: this._opts.progid || 'MotorCAD.AppAutomation',
        }, Math.min(this._timeoutMs, 30000))
        if (body && body.ok && body.ready) {
          this._python = py
          this._ping = body
          this._connected = true
          return true
        }
        lastErr = Object.assign(
          new Error(`环境未就绪（python=${py}, pywin32=${body?.pywin32}, exe=${body?.exe_exists}）`),
          { reason: 'env_not_ready', ping: body }
        )
      } catch (e) {
        lastErr = e
      }
      reasons.push(lastErr?.reason || 'unknown')
    }
    // 全部候选都「无法启动解释器」→ 归因为 python_unavailable（而非环境未就绪），
    // 便于上层/用户区分「没装 Python」与「装了但缺 pywin32 或 Motor-CAD」。
    if (reasons.length && reasons.every((r) => r === 'python_unavailable' || r === 'bridge_missing')) {
      throw Object.assign(
        new Error(`无可用的 Python 解释器（已试：${candidates.join(', ')}）`),
        { reason: 'python_unavailable' }
      )
    }
    throw lastErr || Object.assign(new Error('无可用 Python 解释器'), { reason: 'python_unavailable' })
  }

  async disconnect() {
    this._connected = false
    this._result = null
  }

  async loadMotFile(path) {
    if (path && !existsSync(path)) throw Object.assign(new Error(`.mot 文件不存在: ${path}`), { reason: 'mot_not_found' })
    this._motFile = path || null
    return true
  }

  async setVariable(name, value) {
    this._vars[name] = value
    return true
  }

  /** 真正执行：一次 bridge 进程完成 load→set→solve→get */
  async solve() {
    if (this._mode === 'backend') {
      // 方案 X 预留：后端代理（当前后端未实现该端点，明确报错而非静默降级）
      const base = String(this._opts.backendUrl || process.env.DSH_BACKEND_URL || '').replace(/\/+$/, '')
      if (!base) throw Object.assign(new Error('backend 模式需配置 backendUrl/DSH_BACKEND_URL'),
        { reason: 'backend_not_configured' })
      const res = await fetch(`${base}/api/motorcad/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mot_file: this._motFile, params: this._vars }),
      })
      if (!res.ok) throw Object.assign(new Error(`后端 FEA 端点 ${res.status}（方案 X 尚未实现）`),
        { reason: 'backend_not_implemented' })
      this._result = await res.json()
      return this._result
    }
    if (!this._connected) await this.connect()
    const { body } = await runBridge(this._python, {
      action: 'verify',
      mot_file: this._motFile || '',
      params: this._vars,
      run_emag: this._opts.runEmag !== false,
      run_thermal: this._opts.runThermal !== false,
      save_to: this._opts.saveTo || '',
      progid: this._opts.progid || 'MotorCAD.AppAutomation',
      rated_power_w: this._ratedPowerW || 0,
    }, this._timeoutMs)
    if (!body || body.ok !== true) {
      const e = new Error(body?.error || 'Motor-CAD 求解失败')
      throw Object.assign(e, { reason: body?.reason || 'solve_failed', detail: body })
    }
    this._result = body
    return body
  }

  async getResults() {
    if (!this._result) await this.solve()
    return this._result
  }
}

/** L2 工具名列表 */
export const L2_TOOL_NAMES = [
  'motor_l2_validate',
  'motor_motorcad_verify',
]

/** L2 门控钩子（B 方案在线门控）：后端在线态权威 + 本地离线宽限。
 *  返回 { authorized, stale?, reason?, tier? }；authorized=false 时即 L2 引导体（status:requires_activation）。 */
async function checkL2License(meta = {}) {
  const st = await getL1L2License('l2', {
    hardOffline: meta.hardOffline,
    backendUrl: meta.backendUrl,
  })
  if (!st.authorized) {
    const g = buildActivationGuide('l2')
    g.stale = !!st.stale
    g.reason = st.reason
    g.tier = st.tier
    return g
  }
  return st
}

/**
 * L2 几何校验工具注册器
 */
export async function registerL2Validate(ctx, config = {}) {
  ctx.tools.register({
    name: 'motor_l2_validate',
    description: `L2 几何一致性校验。
验证设计方案几何参数的自洽性，确保符合 Motor-CAD 输入约束。

检查项:
  - 定子外径 ≤ 上限
  - 冲片长度合理性
  - 槽满率范围
  - 轭部磁密范围
  - 气隙磁密范围

参数:
  - geo: 几何参数对象

返回:
  - valid: 是否有效
  - issues: 问题列表
  - warnings: 警告列表

故障协助：若校验失败，返回体含 fault_assist 字段（建议调用 motor_fault_assist 上传脱敏故障情况，获取在线经验智能支持）。`,
    parameters: {
      type: 'object',
      properties: {
        geo: { type: 'object', description: '几何参数' },
        limits: { type: 'object', description: '约束上限' },
      },
      required: ['geo'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(params) {
      const __t0 = Date.now()
      const __run = async () => {
      const actCheck = await checkL2License({})
      if (actCheck && !actCheck.authorized) return actCheck

      // 每日额度闸（免费档 10 次/天；付费档 9999 次/天宽松硬顶，防脚本滥用）
      const quotaErr = await enforceQuota(config)
      if (quotaErr) return { status: 'error', level: 'l2', error: quotaErr.error, quota: quotaErr.quota }

      const { geo, limits = {} } = params
      // A/B 增强：纯函数校验（双口径字段归一化 + OD 上限自适应），见 validateL2Geometry
      const { issues, warnings } = validateL2Geometry(geo, limits)
      return {
        status: issues.length === 0 ? 'valid' : 'invalid',
        tool: 'motor_l2_validate',
        level: 'l2',
        issues,
        warnings,
        geo,
      }
      }
      // 遥测聚合：配额闸（quota）/授权闸（authorized）放行后的调用才计入
      const __res = await __run()
      if (__res && __res.quota === undefined && __res.authorized !== false) {
        logUsage(getUsageSink(config), {
          tool: 'motor_l2_validate', ok: __res.status !== 'error',
          elapsed_ms: Date.now() - __t0,
          warning: Array.isArray(__res.warnings) ? __res.warnings.length : undefined,
          error: __res.status === 'error' ? String(__res.error ?? 'unknown') : undefined,
        })
        scheduleTelemetry(config)
      }
      return JSON.stringify(withFaultAssistHint(__res, { config }), null, 2)
    },
  })
  
  console.log('[dsh-motor-ai L2] 注册 motor_l2_validate')
}

/**
 * L2 Motor-CAD 验证工具注册器
 */
export async function registerMotorCADVerify(ctx, config = {}) {
  ctx.tools.register({
    name: 'motor_motorcad_verify',
    description: `L2 Motor-CAD 精细验证。
通过 COM 接口调用 Motor-CAD v11.1.5 执行电磁+热联合验证。

前置条件:
  - Motor-CAD v11.1.5 已安装
  - ActiveX 设置为"单客户端设置"
  - 需要 .mot 模板文件

参数:
  - design: 完整设计方案
  - template: .mot 模板路径

返回:
  - electromagnetic: 电磁性能
  - thermal: 温升结果
  - geometry: 几何校验
  - solveTime: 求解时间

故障协助：若调用失败（含降级兜底），返回体含 fault_assist 字段（建议调用 motor_fault_assist 上传脱敏故障情况，获取在线经验智能支持）。`,
    parameters: {
      type: 'object',
      properties: {
        design: { type: 'object', description: '完整设计方案' },
        template: { type: 'string', description: '.mot 模板路径' },
      },
      required: ['design'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(params) {
      const __t0 = Date.now()
      const __run = async () => {
      const actCheck = await checkL2License({})
      if (actCheck && !actCheck.authorized) return actCheck

      // 环境预检（license 放行后、配额消耗前）：python/pywin32/Motor-CAD 缺项
      // 直接返回引导，不白耗 90s COM 启动、不扣当日配额（motor_env_check 可随时复检）
      const env = await probeL2(config)
      if (!env.ready) {
        const guide = buildEnvGuide('l2', env.missing)
        return {
          status: 'env_not_ready',
          error: 'ENV_NOT_READY',
          tool: 'motor_motorcad_verify',
          level: 'l2',
          message: guide.message,
          missing: guide.missing,
          probe: guide.probe,
          action: guide.action,
          guide: guide.guide,
          report: buildL2ReportField(),
        }
      }

      // 每日额度闸（免费档 10 次/天；付费档 9999 次/天宽松硬顶，防脚本滥用）
      const quotaErr = await enforceQuota(config)
      if (quotaErr) return { status: 'error', level: 'l2', error: quotaErr.error, quota: quotaErr.quota }

      const { design, template } = params

      // 网格化自洽预检（历史 BUG11 防线）：缺齿宽/齿宽≥齿距都提前警告
      const mesh = buildMeshPrecheck(design)
      const ratedPowerW = extractRatedPowerW(design)

      // ---- 方案 Y：本机 COM 直驱 ----
      const mode = config.motorcadMode || 'com'
      const session = new MotorCADSession({
        mode,
        motorcadPath: process.env.MOTORCAD_PATH || '',
        motorcadInstallDir: process.env.MOTORCAD_INSTALL_DIR || '',
        motorcadPython: config.motorcadPython || '',
        motorDesignRoot: config.motorDesignRoot || process.env.MOTORDESIGN_ROOT || '',
        backendUrl: config.commerceBackendUrl || config.backendUrl || '',
        progid: config.motorcadProgid || 'MotorCAD.AppAutomation',
        timeoutMs: Number(config.motorcadTimeoutMs || 600000),
        runEmag: config.runEmag !== false,
        runThermal: config.runThermal !== false,
        ratedPowerW,
      })

      try {
        await session.connect()
        // 模板优先级：显式 template > 配置默认 > 不指定（用 Motor-CAD 当前模型）
        const motFile = template || config.motFile || process.env.MOTORCAD_DEFAULT_MOT || ''
        if (motFile) await session.loadMotFile(motFile)
        for (const [k, v] of Object.entries(expandDesignParams(design))) {
          await session.setVariable(k, v)
        }
        const res = await session.solve()
        await session.disconnect()

        return {
          status: 'success',
          tool: 'motor_motorcad_verify',
          level: 'l2',
          method: 'motorcad-com-fea', // 真 FEA（Motor-CAD 2D 求解）
          design,
          model: res.model || {},
          electromagnetic: res.emag || {},
          thermal: res.thermal || {},
          applied_params: res.applied_params || {},
          mesh_precheck: mesh,
          rated_power_w: ratedPowerW,
          result_trusted: res.result_trusted ?? null,
          result_warning: res.result_warning || [],
          solveTime: res.solve_time ?? null,
          thermal_return: res.thermal_return ?? null,
          emag_return: res.emag_return ?? null,
          saved_to: res.saved_to || null,
          notes: [
            '本结果为 Motor-CAD COM 2D FEA 真实求解（非等效电路估算）',
            '变量名以白名单读取，未读取的变量不代表不存在（防 COM 挂起）',
            'return=0 ≠ 结果可信：result_trusted=false 时请以 result_warning 为准，勿直接采信功率/效率数值',
          ],
        }
      } catch (err) {
        await session.disconnect().catch(() => {})

        // ---- 方案 Z：等效电路法降级兜底 ----
        // 不伪造 FEA 数值：明确标注 method 与置信度，要求量产前复核。
        if (config.fallbackToEquivalent !== false) {
          let l0 = null
          try {
            const { runL0Estimate } = await import('../l0/l0-estimate.mjs')
            l0 = runL0Estimate(design?.spec || design, config)
          } catch {
            l0 = null // L0 也不可用则只返回说明
          }
          return {
            status: 'fallback',
            tool: 'motor_motorcad_verify',
            level: 'l2',
            method: 'equivalent-circuit-fallback',
            design,
            mesh_precheck: mesh,
            com_error: err.message,
            com_reason: err.reason || 'unknown',
            l0_estimate: l0,
            message: 'Motor-CAD COM 直驱不可用，已降级为等效电路法估算（非 FEA）',
            confidence: 'low',
            warning: '本结果非 Motor-CAD 2D FEA 求解，仅供趋势参考；量产前必须完成 COM FEA 复核。',
            suggestion: err.reason === 'env_not_ready'
              ? '请安装 Motor-CAD 并确保 Python 装有 pywin32（pip install pywin32）；可设 MOTORCAD_PYTHON 指定解释器。'
              : err.reason === 'timeout'
                ? 'Motor-CAD 求解超时（电磁分析约 190-200s），可增大 motorcadTimeoutMs 后重试。'
                : '请检查 Motor-CAD ActiveX 注册模式（默认设置 → 控件注册 → 单客户端设置）。',
            report: buildL2ReportField(err),
          }
        }

        return {
          status: 'error',
          tool: 'motor_motorcad_verify',
          level: 'l2',
          design,
          mesh_precheck: mesh,
          error: err.message,
          reason: err.reason || 'unknown',
          report: buildL2ReportField(err),
        }
      }
      }
      // 遥测聚合：配额闸（quota）/授权闸（authorized）放行后的调用才计入
      // status: success=COM FEA 成功；fallback=降级兜底（method 已标注，计入调用但 ok=false 计失败域）
      const __res = await __run()
      if (__res && __res.quota === undefined && __res.authorized !== false) {
        logUsage(getUsageSink(config), {
          tool: 'motor_motorcad_verify', ok: __res.status === 'success' || __res.status === 'fallback',
          elapsed_ms: Date.now() - __t0,
          error: (__res.status === 'success' || __res.status === 'fallback')
            ? undefined : String(__res.error ?? 'unknown'),
        })
        scheduleTelemetry(config)
      }
      return JSON.stringify(withFaultAssistHint(__res, { config }), null, 2)
    },
  })
  
  console.log('[dsh-motor-ai L2] 注册 motor_motorcad_verify')
}

/**
 * 注册所有 L2 工具
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @returns {Promise<string[]>}
 */
export async function registerL2Tools(ctx, config = {}) {
  const registered = []
  
  try {
    await registerL2Validate(ctx, config)
    registered.push('motor_l2_validate')
  } catch (err) {
    console.warn('[dsh-motor-ai L2] motor_l2_validate 注册失败:', err.message)
  }
  
  try {
    await registerMotorCADVerify(ctx, config)
    registered.push('motor_motorcad_verify')
  } catch (err) {
    console.warn('[dsh-motor-ai L2] motor_motorcad_verify 注册失败:', err.message)
  }
  
  return registered
}

export default {
  registerL2Tools,
  L2_TOOL_NAMES,
  MotorCADSession,
}
