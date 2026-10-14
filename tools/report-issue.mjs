/**
 * motor_report_issue —— 一键生成"可直接发送"的问题反馈稿
 * ============================================================
 * 定位：分发版用户与作者之间唯一不依赖后端的问题回流通道。
 * 分发机器常处于失联状态（后端不可达/邮箱兜底），之前联系邮箱只在
 * 「未激活 / 配额用尽」两条路径出现，L1/L2 运行期失败全路径零覆盖；
 * 本工具补上"问题反馈"入口，与 motor_env_check（自救）形成一对：
 *   - 环境坏了 → motor_env_check（自己修）
 *   - 修不好/程序疑似 bug → motor_report_issue（找作者）
 *
 * 采集内容（全部为诊断必要且不涉设计数据的最小集）：
 *   1. 环境体检（formatProbeReport：python/pyaedt/pywin32/AEDT/Motor-CAD 安装路径与版本）
 *   2. 激活态摘要（tier/source/到期日 —— **不含激活码本体**，作者侧无法复用）
 *   3. 运行时（插件版本 / node / platform / arch）
 *   4. 用户粘贴的错误摘要（可选入参）
 * 输出：纯文本反馈稿（含联系邮箱与"带什么信息"指引），用户复制邮件发送即可。
 *
 * 设计决策：
 *   - **免费、不占配额、无授权要求**：出问题最多的人（未激活/配额尽/环境坏）
 *     恰恰最需要反馈通道，任何门控都会把反馈掐死在起点。
 *   - **不发网络请求**：纯本地组装文本，离线可用；匿名统计走既有
 *     scheduleTelemetry（opt-out），与反馈稿互不耦合。
 *   - 安装路径属本机诊断必要信息，反馈稿明示用户可自行删改后再发送。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join as joinPath } from 'node:path'
import { probeAll, formatProbeReport } from '../lib/env-probe.mjs'
import { CONTACT_EMAIL, queryActivation } from '../lib/license.mjs'
import { scheduleTelemetry } from '../lib/telemetry.mjs'

export const REPORT_ISSUE_TOOL_NAME = 'motor_report_issue'

/** 插件版本（读包内 package.json，单一事实来源） */
function pluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(joinPath(fileURLToPath(import.meta.url), '..', 'package.json'), 'utf8'))
    return pkg.version || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 激活态摘要（绝不包含激活码/令牌本体） */
function activationSummary() {
  try {
    const st = queryActivation()
    if (!st || (!st.tier && !st.activated)) return '未激活（免费层）'
    const parts = []
    if (st.tier) parts.push(`档位=${st.tier}`)
    if (st.source) parts.push(`来源=${st.source}`)
    if (st.expiresAt) parts.push(`到期=${st.expiresAt}`)
    return parts.join('，') || '已激活'
  } catch {
    return '读取失败'
  }
}

/**
 * 组装反馈稿文本。
 * @param {object} [opts] { errorSummary?: string, toolName?: string, probe?: object }
 * @returns {Promise<string>}
 */
export async function buildIssueReport(opts = {}) {
  const probe = opts.probe || (await probeAll({}))
  const lines = []
  lines.push('== dsh-motor-ai 问题反馈稿 ==')
  lines.push(`插件版本：${pluginVersion()}（dsh-motor-ai 完整版）`)
  lines.push(`运行时：node ${process.versions.node} / ${process.platform} ${process.arch}`)
  lines.push(`激活态：${activationSummary()}`)
  if (opts.toolName) lines.push(`出问题工具：${opts.toolName}`)
  lines.push('')
  lines.push('== 用户描述 ==')
  lines.push(String(opts.errorSummary || '（未填写：请在此粘贴报错原文 / 复现步骤 / 期望与实际行为）'))
  lines.push('')
  lines.push('== 环境体检（motor_env_check 同源） ==')
  lines.push(formatProbeReport(probe))
  lines.push('')
  lines.push('== 发送方式 ==')
  lines.push(`1. 复制上方全文（可自行删去本机安装路径等敏感信息）`)
  lines.push(`2. 邮件发送至 ${CONTACT_EMAIL}，标题注明「dsh-motor-ai 问题反馈」`)
  lines.push('3. 若问题来自 L1/L2 调用，请一并附该次工具返回中的 error/com_reason 字段全文')
  return lines.join('\n')
}

export async function registerReportIssue(ctx, config = {}) {
  ctx.tools.register({
    name: REPORT_ISSUE_TOOL_NAME,
    description: `一键生成"可直接发送"的问题反馈稿（免费、不占配额、无需激活、离线可用）。
采集：环境体检 + 激活态摘要（不含激活码）+ 插件/运行时版本 + 你粘贴的报错摘要，
组装成含联系邮箱与发送指引的纯文本，复制发邮件即可。

适用场景：
- L1/L2（RMxprt / Motor-CAD）报错且按指引修不好
- 结果异常（如效率离谱、return=0 但数值可疑）
- 任何疑似插件 bug 或文档与实际不符

参数:
  - error_summary: 报错原文或问题描述（建议粘贴完整，越长越好定位）
  - tool_name: 出问题的工具名（如 motor_motorcad_verify，可省略）

返回: 反馈稿文本（发送方式见文末）`,
    parameters: {
      type: 'object',
      properties: {
        error_summary: {
          type: 'string',
          description: '报错原文或问题描述（建议粘贴完整返回/日志）',
        },
        tool_name: {
          type: 'string',
          description: '出问题的工具名，如 motor_motorcad_verify',
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const text = await buildIssueReport({
          errorSummary: String(args?.error_summary || '').slice(0, 4000),
          toolName: String(args?.tool_name || '').slice(0, 80),
        })
        scheduleTelemetry(config)
        return text
      } catch (err) {
        // 反馈工具自身故障也不能把用户堵死：退化为纯静态指引
        return [
          '== dsh-motor-ai 问题反馈稿（降级模式：自动采集失败） ==',
          `反馈邮箱：${CONTACT_EMAIL}`,
          '请手动附上：①插件版本（npm ls dsh-motor-ai）②报错原文全文 ③node -v 输出',
          '标题注明「dsh-motor-ai 问题反馈」。',
          '',
          `（自动采集异常：${String(err?.message ?? err)}）`,
        ].join('\n')
      }
    },
  })
}

export default { registerReportIssue, REPORT_ISSUE_TOOL_NAME, buildIssueReport }
