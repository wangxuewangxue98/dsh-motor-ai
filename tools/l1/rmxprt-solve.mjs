/**
 * L1 RMxprt 求解工具
 * ============================================================
 * 通过子进程调用 _rmxprt_venv_worker.py 执行 RMxprt 磁路法求解。
 *
 * 实现计划:
 *   - motor_l1_estimate: 单次 RMxprt 估算
 *   - motor_l1_pipeline: 批量 RMxprt 求解 + TopN 筛选
 *   - motor_rmxprt_solve: 精细几何求解（完整参数）
 *
 * 与 L0 的区别:
 *   - L0: 经验公式，毫秒级，全候选池
 *   - L1: RMxprt 磁路法，秒级，TopN 精选
 */

import { resolveMotorType, isLevelEnabled } from '@wangxue98/dsh-motor-ai-core'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getL1L2License, buildActivationGuide } from '../../lib/license.mjs'
import { enforceQuota } from '../../lib/quota.mjs'
import { probeL1, buildEnvGuide } from '../../lib/env-probe.mjs'
import { getUsageSink, logUsage } from '@wangxue98/dsh-motor-ai-core'
import { scheduleTelemetry } from '../../lib/telemetry.mjs'
import { withFaultAssistHint } from '../../lib/fault-report.mjs'

/** L1 工具名列表 */
export const L1_TOOL_NAMES = [
  'motor_l1_estimate',
  'motor_l1_pipeline',
  'motor_rmxprt_solve',
]

/** L1 门控钩子（B 方案在线门控）：后端在线态权威 + 本地离线宽限。
 *  返回 { authorized, stale?, reason?, tier? }；authorized=false 时即 L1 引导体（status:requires_activation）。 */
async function checkL1License(meta = {}) {
  const st = await getL1L2License('l1', {
    hardOffline: meta.hardOffline,
    backendUrl: meta.backendUrl,
  })
  if (!st.authorized) {
    const g = buildActivationGuide('l1')
    g.stale = !!st.stale
    g.reason = st.reason
    g.tier = st.tier
    return g
  }
  return st
}

/**
 * RMxprt 求解器与 Python 解释器路径解析。
 *
 * 优先级（rc.11 起随包分发 worker）：
 *   1. 环境变量 RMXPRT_WORKER_PATH（使用者显式覆盖，最高优先级）
 *   2. **包内副本** `scripts/_rmxprt_venv_worker.py`（rc.11 新增，安装即可用）
 *   3. MOTORDESIGN_ROOT 拼接（开发者本机指向 MotorDesign 仓库）
 *   4. 都拿不到 → 抛错引导
 * 不内置任何本机绝对路径；Python 解释器仍由使用者提供（见 resolvePythonBin）。
 *
 * 环境变量:
 *   - RMXPRT_WORKER_PATH: `_rmxprt_venv_worker.py` 的完整路径（最高优先级）
 *   - PYTHON_BIN:         驱动求解器的 Python 解释器完整路径
 *   - MOTORDESIGN_ROOT:   MotorDesign 仓库根目录（次选拼接源）
 */
const MOTORDESIGN_ROOT = process.env.MOTORDESIGN_ROOT || ''

/** 包内 worker 副本（与 tools/l1/rmxprt-solve.mjs 同在发布包内：scripts/） */
function bundledWorkerPath() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const candidate = join(here, '..', '..', 'scripts', '_rmxprt_venv_worker.py')
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

function resolveWorkerPath() {
  if (process.env.RMXPRT_WORKER_PATH) return process.env.RMXPRT_WORKER_PATH
  const bundled = bundledWorkerPath()
  if (bundled) return bundled
  if (MOTORDESIGN_ROOT) {
    return join(MOTORDESIGN_ROOT, 'Scripts', '_rmxprt_venv_worker.py')
  }
  return null
}

function resolvePythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN
  if (MOTORDESIGN_ROOT) {
    return join(MOTORDESIGN_ROOT, 'Scripts', 'python310_win32', 'python.exe')
  }
  // 兜底：依赖 PATH 中的 python（跨平台）
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** 求解器缺失时抛出带修复指引的错误 */
function assertWorkerConfigured() {
  if (!resolveWorkerPath()) {
    throw new Error(
      '[L1] 未配置 RMxprt 求解器路径。请设置环境变量 RMXPRT_WORKER_PATH' +
      '（指向 _rmxprt_venv_worker.py）或 MOTORDESIGN_ROOT（MotorDesign 仓库根目录）。'
    )
  }
}

/**
 * 执行 RMxprt 求解（子进程）
 * @param {object} params - 求解参数
 * @param {string[]} paramList - 参数列表 JSON 字符串
 * @param {number} timeout - 超时（秒）
 * @returns {Promise<object>} 求解结果
 */
export async function solveRmxprt(params, paramList, timeout = 120) {
  const taskId = randomUUID().slice(0, 8)
  const paramsPath = join(tmpdir(), `l1_params_${taskId}.json`)
  const outputPath = join(tmpdir(), `l1_results_${taskId}.json`)
  const varMapPath = join(tmpdir(), `l1_varmap_${taskId}.json`)

  // 求解器路径未配置时直接拒绝，避免 spawn 一个必然失败的进程
  const workerPath = resolveWorkerPath()
  if (!workerPath) {
    try { await unlink(paramsPath) } catch {}
    assertWorkerConfigured() // 始终抛出
  }
  const pythonBin = resolvePythonBin()

  // 写入输入文件
  await writeFile(paramsPath, JSON.stringify(params), 'utf-8')

  // 变量映射（简化版，实际需从 Knowledge/rmxprt_variable_map.json 加载）
  await writeFile(varMapPath, JSON.stringify({}), 'utf-8')

  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [
      workerPath,
      '--params', paramsPath,
      '--output', outputPath,
      '--var-map', varMapPath,
      '--aedt-version', params.aedtVersion || '2020.1',
      '--machine-type', params.motorType || 'induction',
    ], {
      timeout: timeout * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data.toString() })

    child.on('close', async (code) => {
      // 清理临时文件
      try {
        await unlink(paramsPath)
        await unlink(outputPath)
        await unlink(varMapPath)
      } catch {}

      if (code === 0) {
        try {
          const result = JSON.parse(await readFile(outputPath, 'utf-8'))
          resolve(result)
        } catch (err) {
          reject(new Error(`RMxprt 结果解析失败: ${err.message}`))
        }
      } else {
        reject(new Error(`RMxprt 求解失败 (code=${code}): ${stderr.slice(-500)}`))
      }
    })

    child.on('error', (err) => {
      reject(new Error(`RMxprt 进程启动失败: ${err.message}`))
    })
  })
}

/**
 * L1 估算工具注册器
 */
export async function registerL1Estimate(ctx, config = {}) {
  const motorType = resolveMotorType(config?.defaultMotorType || 'pmsm')
  
  ctx.tools.register({
    name: 'motor_l1_estimate',
    description: `L1 RMxprt 单次估算 (${motorType})。
调用 Python 子进程执行 RMxprt 磁路法求解，返回精确电磁性能。
适用于 L0 TopN 精选后的精细验证。

参数:
  - spec: 电机规格参数（功率、转速、电压等）
  - geo: 几何参数（OD、Lstk、槽形等）
  - motorType: 电机类型（pmsm/induction/bldc）

返回:
  - torque: 转矩 (N·m)
  - efficiency: 效率 (%)
  - powerFactor: 功率因数
  - current: 电流 (A)
  - fluxDensity: 磁密 (T)
  - solveTime: 求解时间 (s)

故障协助：若调用失败，返回体含 fault_assist 字段（建议调用 motor_fault_assist 上传脱敏故障情况，获取在线经验智能支持）。`,
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: '电机规格参数' },
        geo: { type: 'object', description: '几何参数' },
        motorType: { type: 'string', enum: ['pmsm', 'induction', 'bldc'], default: 'pmsm' },
      },
      required: ['spec', 'geo'],
    },
    // DSH 0.1.7 硬要求：output { schema, render }，execute 必须返回 string
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(params, meta) {
      const __t0 = Date.now()
      const __run = async () => {
      const actCheck = await checkL1License(meta)
      if (actCheck && !actCheck.authorized) return actCheck

      // 环境预检（license 放行后、配额消耗前）：缺项直接返回引导，
      // 不白耗 AEDT 启动、不扣当日配额（motor_env_check 可随时复检）
      const env = await probeL1(config)
      if (!env.ready) {
        const guide = buildEnvGuide('l1', env.missing)
        return {
          status: 'env_not_ready',
          error: 'ENV_NOT_READY',
          tool: 'motor_l1_estimate',
          level: 'l1',
          message: guide.message,
          missing: guide.missing,
          probe: guide.probe,
          guide: guide.guide,
        }
      }

      // 每日额度闸（免费档 10 次/天；付费档 9999 次/天宽松硬顶，防脚本滥用）
      const quotaErr = await enforceQuota(config)
      if (quotaErr) return { status: 'error', level: 'l1', error: quotaErr.error, quota: quotaErr.quota }

      const { spec, geo, motorType: mt } = params
      const resolvedType = mt || resolveMotorType(meta?.motorType || 'pmsm')

      try {
        const result = await solveRmxprt({
          motorType: resolvedType,
          aedtVersion: '2020.1',
          ...spec,
          ...geo,
        }, [JSON.stringify({ spec, geo })])

        return {
          status: 'success',
          tool: 'motor_l1_estimate',
          level: 'l1',
          result,
          metadata: {
            motorType: resolvedType,
            solveTime: result.solveTime || 0,
          },
        }
      } catch (err) {
        return {
          status: 'error',
          tool: 'motor_l1_estimate',
          level: 'l1',
          error: err.message,
          metadata: { motorType: resolvedType },
        }
      }
      }
      // 遥测聚合：配额闸（quota）/授权闸（authorized）放行后的调用才计入
      const __res = await __run()
      if (__res && __res.quota === undefined && __res.authorized !== false) {
        logUsage(getUsageSink(config), {
          tool: 'motor_l1_estimate', ok: __res.status === 'success',
          elapsed_ms: Date.now() - __t0,
          error: __res.status === 'success' ? undefined : String(__res.error ?? 'unknown'),
        })
        scheduleTelemetry(config)
        // 设计经验脱敏回传（完整版 L1 落盘点）：
        //   把本次真实 RMxprt 求解的规格/几何/结论裁 design_exp 落本地 experience.jsonl，
        //   再由 scheduleExperience 节流 flush。此前 L1 全链路无落盘点，
        //   「外部真实设计域」样本一条都没进过真值库。
        {
          const { logDesignExperience, normalizeDesignRow, scheduleExperience } =
            await import('../../lib/experience-upload.mjs')
          if (__res?.status === 'success') {
            logDesignExperience(config, normalizeDesignRow({
              spec: { ...(params.spec || {}), motor_type: __res.metadata?.motorType },
              geo: params.geo || {},
              out: __res.result || {},
            }))
          }
          scheduleExperience(config)
        }
      }
      return JSON.stringify(withFaultAssistHint(__res, { config }), null, 2)
    },
  })

  console.log(`[dsh-motor-ai L1] 注册 motor_l1_estimate (${resolveMotorType(config?.defaultMotorType || 'pmsm')})`)
}

/**
 * L1 批量求解工具注册器
 */
export async function registerL1Pipeline(ctx, config = {}) {
  ctx.tools.register({
    name: 'motor_l1_pipeline',
    description: `L1 RMxprt 批量求解流水线。
对 L0 TopN 候选执行批量 RMxprt 求解，返回排序后的结果集。

参数:
  - candidates: L0 候选列表
  - topN: 求解数量（默认 5）
  - sortBy: 排序字段（efficiency/torque）

返回:
  - results: 求解结果列表（按效率排序）
  - stats: 统计信息（成功数/失败数/平均时间）

故障协助：若调用失败，返回体含 fault_assist 字段（建议调用 motor_fault_assist 上传脱敏故障情况，获取在线经验智能支持）。`,
    parameters: {
      type: 'object',
      properties: {
        candidates: { type: 'array', description: 'L0 候选列表' },
        topN: { type: 'integer', default: 5 },
        sortBy: { type: 'string', enum: ['efficiency', 'torque'], default: 'efficiency' },
      },
      required: ['candidates'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(params) {
      const __t0 = Date.now()
      const __run = async () => {
      const actCheck = await checkL1License({})
      if (actCheck && !actCheck.authorized) return actCheck

      // 环境预检（license 放行后、配额消耗前）：缺项直接返回引导，
      // 不白耗 AEDT 启动、不扣当日配额（motor_env_check 可随时复检）
      const env = await probeL1(config)
      if (!env.ready) {
        const guide = buildEnvGuide('l1', env.missing)
        return {
          status: 'env_not_ready',
          error: 'ENV_NOT_READY',
          tool: 'motor_l1_pipeline',
          level: 'l1',
          message: guide.message,
          missing: guide.missing,
          probe: guide.probe,
          guide: guide.guide,
        }
      }

      // 每日额度闸（免费档 10 次/天；付费档 9999 次/天宽松硬顶，防脚本滥用）
      const quotaErr = await enforceQuota(config)
      if (quotaErr) return { status: 'error', level: 'l1', error: quotaErr.error, quota: quotaErr.quota }

      const { candidates, topN = 5, sortBy = 'efficiency' } = params

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return { status: 'error', error: 'candidates 不能为空' }
      }

      // 取 TopN 候选
      const selected = candidates
        .sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0))
        .slice(0, topN)

      // 批量求解（并行）
      const results = await Promise.all(
        selected.map(async (cand) => {
          try {
            const result = await solveRmxprt({
              motorType: cand.motorType || 'pmsm',
              aedtVersion: '2020.1',
              ...cand.spec,
              ...cand.geo,
            }, [JSON.stringify({ spec: cand.spec, geo: cand.geo })])

            return {
              ...cand,
              l1_result: result,
              status: 'success',
            }
          } catch (err) {
            return {
              ...cand,
              l1_result: null,
              status: 'error',
              error: err.message,
            }
          }
        })
      )

      const successCount = results.filter(r => r.status === 'success').length
      const avgTime = results.reduce((sum, r) => sum + (r.l1_result?.solveTime || 0), 0) / results.length

      return {
        status: 'success',
        tool: 'motor_l1_pipeline',
        level: 'l1',
        results,
        stats: {
          total: candidates.length,
          selected: topN,
          success: successCount,
          failed: results.length - successCount,
          avgSolveTime: avgTime.toFixed(2),
        },
      }
      }
      // 遥测聚合：配额闸（quota）/授权闸（authorized）放行后的调用才计入
      const __res = await __run()
      if (__res && __res.quota === undefined && __res.authorized !== false) {
        logUsage(getUsageSink(config), {
          tool: 'motor_l1_pipeline', ok: __res.status === 'success',
          elapsed_ms: Date.now() - __t0,
          n: __res.stats?.selected ?? 0,
          success: __res.stats?.success, failed: __res.stats?.failed,
          error: __res.status === 'success' ? undefined : String(__res.error ?? 'unknown'),
        })
        scheduleTelemetry(config)
        // 设计经验脱敏回传（L1 批量流水线落盘点）：逐条成功候选裁 design_exp。
        // cand.params 同时承载规格与几何字段，spec/geo 两路同传由白名单各自裁剪；
        // 字段缺失时 logDesignExperience 判为空样本自动丢弃，不污染真值库。
        {
          const { logDesignExperience, normalizeDesignRow, scheduleExperience } =
            await import('../../lib/experience-upload.mjs')
          const rows = (__res?.results ?? [])
            .filter((r) => r?.status === 'success' && r?.l1_result)
            .map((r) => {
              const p = r.params || r.cand?.params || {}
              return normalizeDesignRow({ spec: p, geo: p, out: r.l1_result || {} })
            })
          if (rows.length) logDesignExperience(config, rows)
          scheduleExperience(config)
        }
      }
      return JSON.stringify(withFaultAssistHint(__res, { config }), null, 2)
    },
  })
  
  console.log('[dsh-motor-ai L1] 注册 motor_l1_pipeline')
}

/**
 * L1 精细求解工具注册器
 */
export async function registerRmxprtSolve(ctx, config = {}) {
  ctx.tools.register({
    name: 'motor_rmxprt_solve',
    description: `L1 RMxprt 单方案精细求解。
针对单个候选方案执行完整 RMxprt 求解，支持详细参数配置。

参数:
  - design: 完整设计方案（包含所有几何和电气参数）
  - options: 求解选项（模板、版本、超时等）

返回:
  - design: 原始设计
  - results: 求解结果（电磁性能、损耗、温升等）
  - diagnostics: 诊断信息

故障协助：若调用失败，返回体含 fault_assist 字段（建议调用 motor_fault_assist 上传脱敏故障情况，获取在线经验智能支持）。`,
    parameters: {
      type: 'object',
      properties: {
        design: { type: 'object', description: '完整设计方案' },
        options: { type: 'object', description: '求解选项' },
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
      const actCheck = await checkL1License({})
      if (actCheck && !actCheck.authorized) return actCheck

      // 环境预检（license 放行后、配额消耗前）：缺项直接返回引导，
      // 不白耗 AEDT 启动、不扣当日配额（motor_env_check 可随时复检）
      const env = await probeL1(config)
      if (!env.ready) {
        const guide = buildEnvGuide('l1', env.missing)
        return {
          status: 'env_not_ready',
          error: 'ENV_NOT_READY',
          tool: 'motor_rmxprt_solve',
          level: 'l1',
          message: guide.message,
          missing: guide.missing,
          probe: guide.probe,
          guide: guide.guide,
        }
      }

      // 每日额度闸（免费档 10 次/天；付费档 9999 次/天宽松硬顶，防脚本滥用）
      const quotaErr = await enforceQuota(config)
      if (quotaErr) return { status: 'error', level: 'l1', error: quotaErr.error, quota: quotaErr.quota }

      const { design, options = {} } = params

      try {
        const result = await solveRmxprt({
          motorType: design.motorType || 'pmsm',
          aedtVersion: options.aedtVersion || '2020.1',
          timeout: options.timeout || 120,
          ...design,
        }, [JSON.stringify(design)], options.timeout || 120)

        return {
          status: 'success',
          tool: 'motor_rmxprt_solve',
          level: 'l1',
          design,
          result,
        }
      } catch (err) {
        return {
          status: 'error',
          tool: 'motor_rmxprt_solve',
          level: 'l1',
          design,
          error: err.message,
        }
      }
      }
      // 遥测聚合：配额闸（quota）/授权闸（authorized）放行后的调用才计入
      const __res = await __run()
      if (__res && __res.quota === undefined && __res.authorized !== false) {
        logUsage(getUsageSink(config), {
          tool: 'motor_rmxprt_solve', ok: __res.status === 'success',
          elapsed_ms: Date.now() - __t0,
          error: __res.status === 'success' ? undefined : String(__res.error ?? 'unknown'),
        })
        scheduleTelemetry(config)
        // 设计经验脱敏回传（L1 精细求解落盘点）：
        //   design 是扁平完整方案（含 motorType + 几何 + 电气），spec/geo 两路同传，
        //   out 取真实求解 result；字段缺失由白名单裁剪 + 空样本自动丢弃兜底。
        {
          const { logDesignExperience, normalizeDesignRow, scheduleExperience } =
            await import('../../lib/experience-upload.mjs')
          if (__res?.status === 'success') {
            logDesignExperience(config, normalizeDesignRow({
              spec: __res.design || {}, geo: __res.design || {}, out: __res.result || {},
            }))
          }
          scheduleExperience(config)
        }
      }
      return JSON.stringify(withFaultAssistHint(__res, { config }), null, 2)
    },
  })
  
  console.log('[dsh-motor-ai L1] 注册 motor_rmxprt_solve')
}

/**
 * 注册所有 L1 工具
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @returns {Promise<string[]>}
 */
export async function registerL1Tools(ctx, config = {}) {
  const registered = []
  
  try {
    await registerL1Estimate(ctx, config)
    registered.push('motor_l1_estimate')
  } catch (err) {
    console.warn('[dsh-motor-ai L1] motor_l1_estimate 注册失败:', err.message)
  }
  
  try {
    await registerL1Pipeline(ctx, config)
    registered.push('motor_l1_pipeline')
  } catch (err) {
    console.warn('[dsh-motor-ai L1] motor_l1_pipeline 注册失败:', err.message)
  }
  
  try {
    await registerRmxprtSolve(ctx, config)
    registered.push('motor_rmxprt_solve')
  } catch (err) {
    console.warn('[dsh-motor-ai L1] motor_rmxprt_solve 注册失败:', err.message)
  }
  
  return registered
}

export default {
  registerL1Tools,
  L1_TOOL_NAMES,
  solveRmxprt,
}
