/**
 * motor_env_check —— L1/L2 运行环境一键体检
 * ============================================================
 * 用户授权使用 L1/L2 前（或任何时候想自检），调用本工具：
 *
 *   探测矩阵：python（候选链）→ pyaedt（L1）/ pywin32（L2）→ AEDT / Motor-CAD 安装
 *   输出：每项 ✅/❌ + 详情 + 缺失项的人话修复指引（下载页 / pip 命令 / 环境变量）
 *
 * 设计决策：
 *   1. **不占每日配额**——它是自检/自救工具：环境损坏 + 配额用尽的用户
 *      必须还能体检才能自救；且无后端成本（不跑解算）。
 *   2. 无授权要求（L0 级常驻）——未激活用户同样需要知道缺什么。
 *   3. 探测挂遥测（scheduleTelemetry）——匿名统计用户机器环境分布，
 *      仅白名单统计量，不含路径明细（见 lib/telemetry.mjs TELEM_FIELDS）。
 */

import { probeAll, formatProbeReport, buildEnvGuide, PROBE_ITEMS } from '../lib/env-probe.mjs'
import { scheduleTelemetry } from '../lib/telemetry.mjs'

export const ENV_CHECK_TOOL_NAME = 'motor_env_check'

/** 按 level 过滤后的体检报告文本 */
function reportForLevel(all, level) {
  const head = level === 'all'
    ? ''
    : `（仅关注 ${level.toUpperCase()}：${all[level].ready ? '就绪' : '未就绪'}）\n`
  const text = formatProbeReport(all)
  return level === 'all' ? text : head + text
}

export async function registerEnvCheck(ctx, config = {}) {
  ctx.tools.register({
    name: ENV_CHECK_TOOL_NAME,
    description: `L1/L2 运行环境一键体检 + 修复引导（免费、不占配额、随时可调）。
探测五项：Python 解释器（候选链）、pyaedt（L1 必需）、pywin32（L2 必需）、
Ansys AEDT 安装、Motor-CAD 安装。缺失项给出具体修复步骤
（下载页 / pip install 命令 / 环境变量 / DSH 配置键）。

适用场景：
- 准备调用 L1/L2 前先体检，缺什么补什么
- L1/L2 报 ENV_NOT_READY 后按本工具指引逐项修复
- 换机器/换 Python 环境后验证依赖齐全

参数:
  - level: 关注层级（l1 / l2 / all，默认 all）

返回: 人话体检报告（每项状态 + 详情 + 修复指引）`,
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['l1', 'l2', 'all'],
          default: 'all',
          description: '关注层级：l1=RMxprt 环境 / l2=Motor-CAD 环境 / all=全部',
        },
      },
    },
    // DSH 0.1.7 硬要求：output { schema, render }，execute 必须返回 string
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const level = ['l1', 'l2', 'all'].includes(args?.level) ? args.level : 'all'
        const all = await probeAll(config)
        const text = reportForLevel(all, level)
        scheduleTelemetry(config)
        return text
      } catch (err) {
        scheduleTelemetry(config)
        return JSON.stringify({
          status: 'error',
          tool: ENV_CHECK_TOOL_NAME,
          error: String(err?.message ?? err),
          hint: '环境探测自身失败（罕见）：请确认 DSH 进程有权限枚举磁盘与启动 Python。',
        }, null, 2)
      }
    },
  })
}

export default { registerEnvCheck, ENV_CHECK_TOOL_NAME, PROBE_ITEMS, buildEnvGuide }
