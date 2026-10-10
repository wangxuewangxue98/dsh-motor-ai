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

import { resolveMotorType } from '@yourscope/dsh-motor-ai-core'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'

/** L1 工具名列表 */
export const L1_TOOL_NAMES = [
  'motor_l1_estimate',
  'motor_l1_pipeline',
  'motor_rmxprt_solve',
]

/**
 * RMxprt 求解器路径（可通过环境变量覆盖）
 */
const RMXPRT_WORKER_PATH = process.env.RMXPRT_WORKER_PATH ||
  'D:/MotorDesign/Scripts/_rmxprt_venv_worker.py'

const PYTHON_BIN = process.env.PYTHON_BIN ||
  'D:/MotorDesign/Scripts/python310_win32/python.exe'

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

  // 写入输入文件
  await writeFile(paramsPath, JSON.stringify(params), 'utf-8')
  
  // 写入输入文件
  await (await import('node:fs')).writeFile(paramsPath, JSON.stringify(params), 'utf-8')
  
  // 变量映射（简化版，实际需从 Knowledge/rmxprt_variable_map.json 加载）
  await (await import('node:fs')).writeFile(varMapPath, JSON.stringify({}), 'utf-8')
  
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [
      RMXPRT_WORKER_PATH,
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
  - solveTime: 求解时间 (s)`,
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: '电机规格参数' },
        geo: { type: 'object', description: '几何参数' },
        motorType: { type: 'string', enum: ['pmsm', 'induction', 'bldc'], default: 'pmsm' },
      },
      required: ['spec', 'geo'],
    },
    async execute(params, meta) {
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
  - stats: 统计信息（成功数/失败数/平均时间）`,
    parameters: {
      type: 'object',
      properties: {
        candidates: { type: 'array', description: 'L0 候选列表' },
        topN: { type: 'integer', default: 5 },
        sortBy: { type: 'string', enum: ['efficiency', 'torque'], default: 'efficiency' },
      },
      required: ['candidates'],
    },
    async execute(params) {
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
  - diagnostics: 诊断信息`,
    parameters: {
      type: 'object',
      properties: {
        design: { type: 'object', description: '完整设计方案' },
        options: { type: 'object', description: '求解选项' },
      },
      required: ['design'],
    },
    async execute(params) {
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
