/**
 * 工具：motor_submit_experience —— 文字经验反馈回流（经验反馈渠道 P0-B/P1，v1.2.0）
 * ===========================================================
 * 定位：用户/AI 会话在 Motor-CAD / 电机设计实践中总结出「踩坑经验 / 改进建议 /
 * 能力缺口」后，把**纯技术文字**发回接收端（/api/dsh/experience-feedback），
 * 落 ['fbk']，供维护者策展晋升知识库（['kb']），design-assist 即可在后续设计中
 * 主动注入这些经验——形成「用 → 悟 → 传 → 用」闭环。
 *
 * 与 submit_resolved_case 的分工（防重复回流，勿混用）：
 *   - submit_resolved_case：**问题→根因→解决**（故障向；进 ['iss']，可被故障检索命中）
 *   - 本工具：**经验 / 踩坑 / 建议 / 缺口**（知识向；进 ['fbk']，策展后进 ['kb']）
 *
 * 设计要点：
 *   - 贡献型工具，不调用任何估算 / 校验函数，**不消耗免费额度**。
 *   - fire-and-forget：提交失败只返回友好提示，绝不阻断用户主流程。
 *   - 默认需 experienceFeedbackEnabled=true 才真正外发；否则仅提示开启开关。
 *   - 脱敏四道闸：白名单裁剪 + 黑名单键即拒 + S01–S10 内容级扫描（命中即拒） +
 *     rec_id 内容 sha1（审计可溯）。
 */

import {
  submitExperienceFeedback,
  feedbackRecIdOf,
} from '../lib/experience-feedback.mjs'
import { getUsageSink, logUsage } from '@wangxue98/dsh-motor-ai-core'

export const EXPERIENCE_FEEDBACK_TOOL_NAME = 'motor_submit_experience'

/** 工具入参声明 */
export const TOOL_PARAMS = {
  title: {
    type: 'string',
    description: '一句话标题（必填）：如「变频供电下铜损需按绕组实际温度修正」「热包络扫描的最小转速护栏」',
  },
  body: {
    type: 'string',
    description:
      '经验正文（必填，200~1500 字为宜）：写清楚「现象 → 原因 → 该怎么做」，只写通用技术结论，'
      + '⚠️ 严禁包含：具体几何尺寸/匝数/电流/效率等设计数值、客户与项目名、本机路径、联系方式——'
      + '内容级脱敏自检（S01~S10）命中会被拒绝提交',
  },
  category: {
    type: 'string',
    enum: ['geometry', 'thermal', 'magnetic', 'winding', 'material', 'workflow', 'other'],
    description: '分类（可选）：geometry 几何 / thermal 热与温升 / magnetic 磁路 / winding 绕组 / material 材料 / workflow 工作流 / other 其他',
  },
  related_tool: {
    type: 'string',
    description: '关联工具名（可选）：如 motor_l2_validate / motor_motorcad_verify / motor_l0_estimate',
  },
  severity: {
    type: 'string',
    enum: ['low', 'medium', 'high'],
    description: '重要度（可选，默认 low）：high=普遍踩坑/强烈建议，medium=特定场景，low=锦上添花',
  },
  tags: {
    type: 'array',
    description: '标签（可选）：便于策展归类与检索，如 ["铜损", "温度", "变频"]',
  },
  source_ref: {
    type: 'string',
    description: '来源备注（可选）：如「Motor-CAD 培训 第五讲·热分析」；仅写公开资料名，勿写内部文档路径',
  },
}

/**
 * 纯函数：组装 payload 并提交（不触额度）。
 * @returns {Promise<{ status: 'submitted'|'skipped'|'error', message: string, rec_id?: string }>}
 */
export async function runSubmitExperienceFeedback(args, config = {}) {
  const t0 = Date.now()
  const payload = {
    title: args?.title,
    body: args?.body,
    category: args?.category,
    related_tool: args?.related_tool,
    severity: args?.severity ?? 'low',
    tags: Array.isArray(args?.tags) ? args.tags : undefined,
    source_ref: args?.source_ref,
  }
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k]

  const res = await submitExperienceFeedback(config, payload)
  if (res.submitted) {
    logUsage(getUsageSink(config), {
      tool: 'motor_submit_experience', ok: true, elapsed_ms: Date.now() - t0, n: 1,
    })
    return {
      status: 'submitted',
      rec_id: res.rec_id,
      message: '已提交到经验反馈通道，感谢你的经验贡献！维护者策展后会进入在线知识库，后续设计将自动注入。',
    }
  }
  if (res.reason === 'disabled' || res.reason === 'no-endpoint') {
    return {
      status: 'skipped',
      message:
        '经验反馈通道当前未启用：请在插件配置中设置 experienceFeedbackEnabled: true'
        + '（并保留 commerceBackendUrl 或显式填 experienceFeedbackEndpoint）。开启后可自动发回。\n'
        + '你的内容未丢失，可在开启后重新提交；也可以现在把这段经验写入本地文档留存。',
    }
  }
  if (String(res.reason || '').startsWith('sensitive:')) {
    return {
      status: 'error',
      message:
        '提交被脱敏自检拒绝：' + String(res.reason).slice('sensitive:'.length) + '\n'
        + '请移除正文中的具体设计数值 / 客户项目标识 / 本机路径 / 联系方式后重试'
        + '（只写通用技术结论，不写设计明细）。',
    }
  }
  return {
    status: 'error',
    message: `提交未成功（${res.reason ?? 'unknown'}）。你的内容未丢失，可在修复后重试。`,
  }
}

/**
 * 工具注册（薄封装，动态 import 保证离线可加载）
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export async function registerExperienceFeedbackTool(ctx, config = {}) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  ctx.tools.register(defineTool({
    name: EXPERIENCE_FEEDBACK_TOOL_NAME,
    description:
      '提交一条「文字经验 / 踩坑 / 改进建议」到 dsh-motor-ai 在线知识库（经验反馈渠道）。\n'
      + '当你在电机设计 / Motor-CAD / 插件使用中总结出通用技术经验（现象→原因→该怎么做）后，\n'
      + '用本工具把经验发回维护者，策展后进入在线知识库，后续设计会自动注入这些经验。\n'
      + '分工：故障类「问题→根因→解决」请用 submit_resolved_case；本工具只收经验/建议/缺口。\n'
      + '这是贡献型工具，不消耗免费额度。内容经白名单 + 内容级脱敏自检（S01~S10），'
      + '严禁包含设计数值 / 客户项目 / 路径 / 联系方式。\n'
      + '⚠️ 需先在插件配置开启 experienceFeedbackEnabled: true（默认关闭，opt-in）才真正外发。',
    parameters: TOOL_PARAMS,
    output: {
      // schema 与 execute 返回类型一致：本工具 execute 返回 JSON 字符串（全仓一致约定）。
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        return JSON.stringify(await runSubmitExperienceFeedback(args, config), null, 2)
      } catch (err) {
        return JSON.stringify({ status: 'error', message: String(err?.message ?? err) }, null, 2)
      }
    },
  }))
}

export default { runSubmitExperienceFeedback, registerExperienceFeedbackTool, TOOL_PARAMS, EXPERIENCE_FEEDBACK_TOOL_NAME }
