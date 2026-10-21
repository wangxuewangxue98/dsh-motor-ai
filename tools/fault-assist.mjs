/**
 * 工具：motor_fault_assist —— 故障协助（在线经验智能支持，Part 二完整版）
 * ===========================================================
 * 定位：用户在使用插件报故障时，用本工具上传「脱敏故障情况」，系统自动匹配
 * 在线知识库中的相似已解决案例，给出经验建议；同时把该故障情况上报接收端
 * （供制作者后续沉淀到知识库）。问题解决后，引导用户用 submit_resolved_case
 * 把「原因 + 改进措施 + 解决过程」回流知识库（需求②闭环）。
 *
 * 设计要点（与 submit_resolved_case / motor_report_issue 对齐）：
 *   - 免费、不占配额、无授权要求：出问题最多的人恰恰最需要协助通道。
 *   - 上报 + 查询均 fire-and-forget：任一环节失败都只降级提示，绝不阻断。
 *   - 内容全程脱敏：只发 FAULT_REPORT_FIELDS 白名单，error 原文归一成类别。
 *   - query_only=true 时可只查相似案例、不上报当前故障（纯查阅）。
 */

import {
  submitFaultReport,
  querySimilarCases,
} from '../lib/fault-report.mjs'
import { getUsageSink, logUsage } from '@wangxue98/dsh-motor-ai-core'
import { scheduleTelemetry } from '../lib/telemetry.mjs'

export const FAULT_ASSIST_TOOL_NAME = 'motor_fault_assist'

/** 工具入参声明 */
export const TOOL_PARAMS = {
  symptom: {
    type: 'string',
    description: '故障现象描述（遇到了什么，越具体越利于匹配）：如「RMxprt 求解报 python 模块缺失」「校验报 V08 轭厚 failed」',
  },
  category: {
    type: 'string',
    enum: ['geometry', 'thermal', 'magnetic', 'winding', 'material', 'workflow', 'other'],
    description: '故障分类（可选）：geometry 几何 / thermal 温升 / magnetic 磁密 / winding 绕组 / material 材料 / workflow 工作流 / other 其他',
  },
  related_tool: {
    type: 'string',
    description: '关联工具名（可选）：如 motor_rmxprt_solve / motor_motorcad_verify / motor_design_validate',
  },
  severity: {
    type: 'string',
    enum: ['low', 'medium', 'high'],
    description: '严重度（可选，默认 medium）',
  },
  tags: {
    type: 'array',
    description: '标签（可选）：便于知识库检索，如 ["轭厚", "磁饱和", "RMxprt"]',
  },
  error_category: {
    type: 'string',
    description: '错误类别（可选，缺省自动从 symptom 文本归一成安全类别；不传原始 error）',
  },
  query_only: {
    type: 'boolean',
    description: '仅查询相似案例、不上报当前故障（纯查阅模式）；缺省 false = 上报 + 查询',
  },
}

/**
 * 纯函数：上报故障 + 查询相似案例 + 组装智能支持文本。
 * @returns {Promise<string>} 直接可渲染的文本
 */
export async function runFaultAssist(args, config = {}) {
  const symptom = String(args?.symptom || '').trim()
  const category = args?.category
  const relatedTool = String(args?.related_tool || '').trim()
  const severity = args?.severity || 'medium'
  const tags = Array.isArray(args?.tags)
    ? args.tags.map(String)
    : (args?.tags ? [String(args.tags)] : [])
  const queryOnly = args?.query_only === true

  // 1) 上报脱敏故障情况（非 query_only 时）
  let reportRes = { submitted: false, reason: 'skipped' }
  if (!queryOnly) {
    reportRes = await submitFaultReport(config, {
      category,
      symptom,
      related_tool: relatedTool,
      severity,
      tags,
      error_category: args?.error_category,
    })
  }

  // 2) 查询相似案例（以 symptom 为主、related_tool/category 为辅构造查询词）
  const q = symptom || relatedTool || String(category || '')
  const queryRes = await querySimilarCases(config, {
    q,
    category,
    related_tool: relatedTool,
    limit: 5,
  })

  // 3) 组装智能支持文本
  const blocks = []
  blocks.push('== dsh-motor-ai 故障协助（在线经验智能支持） ==')
  blocks.push(`查询词：${q || '（空）'}`)

  if (queryRes.ok && queryRes.matches.length) {
    blocks.push(`\n✅ 匹配到 ${queryRes.matches.length} 条相似已解决案例，供参考：`)
    queryRes.matches.forEach((m, i) => {
      const score = typeof m.score === 'number' ? m.score.toFixed(2) : '—'
      blocks.push(`\n── 案例 ${i + 1}（相似度 ${score}）──`)
      if (m.category) blocks.push(`分类：${m.category}`)
      if (m.symptom) blocks.push(`现象：${m.symptom}`)
      if (m.root_cause) blocks.push(`根因：${m.root_cause}`)
      if (m.remediation) blocks.push(`改进措施：${m.remediation}`)
      if (m.resolution_process) blocks.push(`解决过程：${m.resolution_process}`)
      if (Array.isArray(m.tags) && m.tags.length) blocks.push(`标签：${m.tags.join('、')}`)
    })
  } else {
    blocks.push('\n⚠️ 知识库暂无高度匹配的已解决案例。建议：')
    blocks.push('1. 先调用 motor_env_check 自查运行环境（L1/L2 常见为 Python / pyaedt / Motor-CAD 缺失）。')
    blocks.push('2. 用 motor_report_issue 生成反馈稿，邮件发作者（含错误原文与工具名）。')
    const kb = String(config.knowledgeBaseUrl || '').trim()
    if (kb) blocks.push(`3. 在线知识库先行查阅：${kb}`)
    if (!queryRes.ok && queryRes.reason) {
      blocks.push(`（相似案例查询未成功：${queryRes.reason}）`)
    }
  }

  // 4) 回流提示
  blocks.push('\n── 知识经验回流 ──')
  if (reportRes.submitted) {
    blocks.push('✓ 你的脱敏故障情况已上报，制作者将据此持续沉淀经验到知识库。')
  } else if (!queryOnly) {
    blocks.push(`（本次故障上报未成功：${reportRes.reason}；不影响上面的查询与下方回流建议）`)
  }
  blocks.push('问题解决后，请用 submit_resolved_case 把「原因 + 改进措施 + 解决过程」回流知识库，帮助后续用户。')

  return blocks.join('\n')
}

/**
 * 工具注册（薄封装）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export async function registerFaultAssist(ctx, config = {}) {
  ctx.tools.register({
    name: FAULT_ASSIST_TOOL_NAME,
    description:
      '故障协助（在线经验智能支持，免费、不占配额、无需激活）。\n'
      + '当你在电机设计 / 插件使用中遇到报错或异常时，用本工具上传「脱敏故障情况」：\n'
      + '系统会自动匹配在线知识库中的相似已解决案例，给出根因与改进措施建议；\n'
      + '同时把该故障情况上报（供制作者持续沉淀经验）。\n'
      + '问题解决后，请用 submit_resolved_case 把「原因 + 改进措施 + 解决过程」回流知识库。\n'
      + '内容全程脱敏：仅含故障现象/分类/标签等技术描述，不含任何身份/路径/密钥信息。\n'
      + '设置 query_only=true 可只查相似案例、不上报当前故障。',
    parameters: {
      type: 'object',
      properties: TOOL_PARAMS,
      required: ['symptom'],
    },
    // ⚠️ DSH 契约硬要求：output.schema 必须是 { type: 'string' }（裸 object 缺
    // additionalProperties 会导致 defineTool 注册抛 authorError → 插件激活失败）。
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const t0 = Date.now()
        const text = await runFaultAssist(args, config)
        // 贡献型/支持型工具也记一条 usage（fire-and-forget，统计用，不占配额）
        try {
          logUsage(getUsageSink(config), {
            tool: FAULT_ASSIST_TOOL_NAME, ok: true, elapsed_ms: Date.now() - t0, n: 1,
          })
          scheduleTelemetry(config)
        } catch { /* 不影响主返回 */ }
        return text
      } catch (err) {
        return [
          '== dsh-motor-ai 故障协助（降级模式） ==',
          `自动匹配/上报异常：${String(err?.message ?? err)}`,
          '请改用 motor_report_issue 生成反馈稿，邮件发作者；',
          '或先调用 motor_env_check 自查运行环境。',
        ].join('\n')
      }
    },
  })

  console.log('[dsh-motor-ai] 注册 motor_fault_assist')
}

export default { registerFaultAssist, FAULT_ASSIST_TOOL_NAME, TOOL_PARAMS, runFaultAssist }
