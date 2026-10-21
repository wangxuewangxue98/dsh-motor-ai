/**
 * 故障协助（在线经验智能支持）客户端库 —— Part 二完整版
 * ===========================================================
 * 用户在使用插件报故障时，提示用户上传脱敏故障情况，获取在线经验智能支持；
 * 解决完问题后知识经验回流（submit_resolved_case，lib/issue-resolved.mjs）。
 *
 * 本模块承担两段职责：
 *   1. submitFaultReport —— 把「脱敏故障情况」POST 到接收端 /api/dsh/fault-report
 *      （fire-and-forget，落盘 ['flt', ts, uuid]，供制作者后续沉淀到知识库）。
 *   2. querySimilarCases —— GET 接收端 /api/dsh/issue-resolved/query，
 *      在「已解决问题」知识库里做轻量相似度匹配，返回 top-N 经验建议。
 *
 * 与 telemetry / experience / issue-resolved 同级，严格遵守脱敏底线：
 *   1. 只发/查白名单字段（FAULT_REPORT_FIELDS），绝不含身份类字段
 *      （账号 / 路径 / 提示词 / 密钥 / 联系方式 / 设计参数正文）。
 *   2. fire-and-forget：HTTP 失败/超时**绝不影响**工具主流程。
 *   3. 默认启用（受 faultAssistEnabled 控制；该开关由 cordis.patch.yml 注入，
 *      与 issueResolvedEnabled 同级）；显式 === false 才退出（opt-out）。
 *
 * 注意：本模块复用 telemetry.mjs 的 classifyError 把故障现象归一成安全类别，
 * 绝不回传原始 error 文本（原文可能夹带参数/路径/密钥）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyError } from './telemetry.mjs'

/** 模块自身目录（用于定位随包 package.json 读版本号） */
const __dirname = path.dirname(fileURLToPath(import.meta.url))

let _fallbackVersion = null
function fallbackVersion() {
  if (_fallbackVersion !== null) return _fallbackVersion
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
    _fallbackVersion = String(pkg.version || '')
  } catch {
    _fallbackVersion = ''
  }
  return _fallbackVersion
}

// ─────────────────────────────────────────────────────────────
// 1. 脱敏白名单（与接收端 FAULT_REPORT_FIELDS 逐字一致）
// ─────────────────────────────────────────────────────────────

/** 允许外发的故障字段白名单（硬编码，其余键一律丢弃） */
export const FAULT_REPORT_FIELDS = [
  'category',            // 故障分类：geometry / thermal / magnetic / winding / material / workflow / other
  'symptom',             // 故障现象描述（用户遇到什么）
  'related_tool',        // 关联工具名（如 motor_rmxprt_solve）
  'severity',            // 严重度：low / medium / high
  'tags',                // 标签数组（便于知识库检索）
  'error_category',      // 脱敏错误类别（由 classifyError 归一，不回传原文）
  'related_plugin_version',
]

/** 红线黑名单：这些键**永远**不得出现在故障上报里 */
export const FAULT_REPORT_FORBIDDEN = [
  'client_id', 'user', 'account', 'username', 'hostname', 'cwd', 'prompt',
  'token', 'api_key', 'secret', 'password', 'email', 'phone', 'wechat',
  'design_params', 'result', 'design', 'path', 'file', 'directory',
]

// ─────────────────────────────────────────────────────────────
// 2. 端点解析
// ─────────────────────────────────────────────────────────────

/**
 * 解析故障上报端点（POST /api/dsh/fault-report）。
 * 优先级：config.faultReportEndpoint 显式配置 > commerceBackendUrl 自动拼。
 */
export function resolveFaultReportEndpoint(config = {}) {
  const explicit = String(config.faultReportEndpoint || '').trim()
  if (explicit) return explicit
  const backend = String(config.commerceBackendUrl || config.backendUrl || '').trim()
  if (backend) return backend.replace(/\/+$/, '') + '/api/dsh/fault-report'
  return ''
}

/**
 * 解析相似案例查询端点（GET /api/dsh/issue-resolved/query）。
 * 优先级：config.issueQueryEndpoint 显式配置 > commerceBackendUrl 自动拼。
 */
export function resolveIssueQueryEndpoint(config = {}) {
  const explicit = String(config.issueQueryEndpoint || '').trim()
  if (explicit) return explicit
  const backend = String(config.commerceBackendUrl || config.backendUrl || '').trim()
  if (backend) return backend.replace(/\/+$/, '') + '/api/dsh/issue-resolved/query'
  return ''
}

// ─────────────────────────────────────────────────────────────
// 3. 故障上报（fire-and-forget）
// ─────────────────────────────────────────────────────────────

/**
 * 提交一条脱敏故障情况到接收端（/api/dsh/fault-report）。
 * @param {object} config 插件配置（faultAssistEnabled / faultReportEndpoint / commerceBackendUrl）
 * @param {object} payload 工具传入的 { category, symptom, related_tool, severity, tags, error_category }
 * @returns {Promise<{ submitted: boolean, reason?: string }>}
 *
 * 合规：白名单裁剪 + error_category 自动归一（不回传原文）；
 *       必填校验（至少 symptom 或 category）；HTTP 失败静默。
 */
export async function submitFaultReport(config = {}, payload = {}) {
  const enabled = config.faultAssistEnabled !== false   // 默认开（opt-out）
  if (!enabled) return { submitted: false, reason: 'disabled' }
  const endpoint = resolveFaultReportEndpoint(config)
  if (!endpoint) return { submitted: false, reason: 'no-endpoint' }

  // 白名单裁剪：仅保留 FAULT_REPORT_FIELDS，其余键（含任何意外混入的身份字段）丢弃
  const cleaned = {}
  for (const k of FAULT_REPORT_FIELDS) {
    if (payload[k] !== undefined && payload[k] !== null) cleaned[k] = payload[k]
  }
  // 必填校验：至少要有 symptom 或 category，避免空回流污染知识库
  if (!cleaned.symptom && !cleaned.category) {
    return { submitted: false, reason: 'empty-content' }
  }
  // error_category 若未显式给，从 symptom 文本自动归一成安全类别（不回传原文）
  if (!cleaned.error_category && cleaned.symptom) {
    cleaned.error_category = classifyError(cleaned.symptom)
  }
  // tags 必须数组（否则接收端拒）
  if (cleaned.tags !== undefined && !Array.isArray(cleaned.tags)) {
    cleaned.tags = [String(cleaned.tags)]
  }

  const body = {
    plugin: 'dsh-motor-ai-full',
    plugin_version: fallbackVersion(),
    kind: 'l0-fault-report',
    ...cleaned,
    reported_at: new Date().toISOString(),
  }

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 5000) : null
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'dsh-motor-ai-full/fault-report' },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (timer) clearTimeout(timer)
    if (res && res.ok) return { submitted: true }
    return { submitted: false, reason: `http_${res?.status ?? 'n/a'}` }
  } catch (err) {
    return { submitted: false, reason: String(err?.message ?? err).slice(0, 60) }
  }
}

// ─────────────────────────────────────────────────────────────
// 4. 相似案例查询（GET /api/dsh/issue-resolved/query）
// ─────────────────────────────────────────────────────────────

/**
 * 在「已解决问题」知识库里查询相似案例（接收端做轻量相似度匹配）。
 * @param {object} config 插件配置（issueQueryEndpoint / commerceBackendUrl）
 * @param {object} opts { q, category?, related_tool?, limit? }
 * @returns {Promise<{ ok: boolean, matches: object[], total?: number, reason?: string }>}
 *
 * matches 每条形如：{ category, symptom, root_cause, remediation, resolution_process,
 *                    related_tool, severity, tags, score }
 */
export async function querySimilarCases(config = {}, opts = {}) {
  const endpoint = resolveIssueQueryEndpoint(config)
  if (!endpoint) return { ok: false, reason: 'no-endpoint', matches: [] }
  const q = String(opts.q || '').trim()
  if (!q) return { ok: false, reason: 'empty_query', matches: [] }

  const params = new URLSearchParams()
  params.set('q', q)
  if (opts.category) params.set('category', String(opts.category))
  if (opts.related_tool) params.set('related_tool', String(opts.related_tool))
  const limit = Number(opts.limit) || 5
  params.set('limit', String(Math.min(Math.max(limit, 1), 20)))

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 5000) : null
    const sep = endpoint.includes('?') ? '&' : '?'
    const res = await fetch(endpoint + sep + params.toString(), {
      method: 'GET',
      headers: { 'User-Agent': 'dsh-motor-ai-full/fault-assist' },
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (timer) clearTimeout(timer)
    if (!res || !res.ok) return { ok: false, reason: `http_${res?.status ?? 'n/a'}`, matches: [] }
    const data = await res.json().catch(() => null)
    if (!data || !Array.isArray(data.matches)) return { ok: false, reason: 'bad_body', matches: [] }
    return { ok: true, matches: data.matches, total: data.total ?? data.matches.length }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 60), matches: [] }
  }
}

// ─────────────────────────────────────────────────────────────
// 5. 报错路径引导提示（注入到工具 error / env_not_ready 返回体）
// ─────────────────────────────────────────────────────────────

/** 组装「故障协助」引导文案（纯文本，用于 error 返回体 fault_assist.message） */
export function buildFaultAssistHint(config = {}) {
  const kb = String(config.knowledgeBaseUrl || '').trim()
  const lines = [
    '── 故障协助（在线经验智能支持）──',
    '如本提示未能解决，请调用 motor_fault_assist 工具上传脱敏故障情况：',
    '系统会自动匹配在线知识库中的相似已解决案例，给出经验建议。',
    '问题解决后，请用 submit_resolved_case 把「原因 + 改进措施 + 解决过程」回流知识库，帮助后续用户。',
  ]
  if (kb) lines.push(`在线知识库先行查阅：${kb}`)
  return lines.join('\n')
}

/**
 * 把「故障协助」引导注入到工具 error / env_not_ready / fallback 返回体，供用户顺手调用。
 * 非破坏性：直接在原对象上加 fault_assist 字段，不影响既有 status/error 等。
 * 兼容两种错误形态：
 *   - L1/L2 形态：{ status: 'error' | 'env_not_ready' | 'fallback', ... }
 *   - L0 形态：{ error: true, message, ... }
 * @param {object} errorResult 工具 execute 内构造的返回对象
 * @param {object} opts { config }
 * @returns {object} 注入后的同一对象（便于直接 JSON.stringify）
 */
export function withFaultAssistHint(errorResult, opts = {}) {
  if (!errorResult || typeof errorResult !== 'object') return errorResult
  const isErr =
    errorResult.status === 'error' ||
    errorResult.status === 'env_not_ready' ||
    errorResult.status === 'fallback' ||
    errorResult.error === true
  if (!isErr) return errorResult
  const config = opts.config || {}
  // 仅在故障协助开关开启时附加（显式 === false 退出）；与 submit_resolved_case 一致
  if (config.faultAssistEnabled === false) return errorResult
  errorResult.fault_assist = {
    message: buildFaultAssistHint(config),
    suggest_tool: 'motor_fault_assist',
    knowledge_base: String(config.knowledgeBaseUrl || '').trim() || null,
  }
  return errorResult
}

export default {
  FAULT_REPORT_FIELDS, FAULT_REPORT_FORBIDDEN,
  resolveFaultReportEndpoint, resolveIssueQueryEndpoint,
  submitFaultReport, querySimilarCases,
  buildFaultAssistHint, withFaultAssistHint,
}
