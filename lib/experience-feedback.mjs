/**
 * 文字经验反馈回流（经验反馈渠道 P0-B/P1，v1.2.0）
 * ===========================================================
 * 需求：用户/AI 会话在 Motor-CAD / 电机设计实践中总结出「踩坑经验 / 改进建议 /
 * 能力缺口」后，经贡献型工具 motor_submit_experience 主动发回接收端
 * （POST /api/dsh/experience-feedback，kind='l0-experience-feedback'），
 * 落 ['fbk']，供维护者策展晋升 ['kb'] → design-assist 自动注入后续设计。
 *
 * 与 issue-resolved（submit_resolved_case）的分工（防重复回流，工具描述里同步写明）：
 *   - issue-resolved：**问题→根因→解决**（故障向；进 ['iss']，可被故障检索命中）
 *   - experience-feedback：**经验 / 踩坑 / 建议 / 缺口**（知识向；进 ['fbk']，策展后进 ['kb']）
 *
 * 与 l0 版（dsh-motor-ai-l0）的关系：完整版独有通道（l0 无此端点接线）。
 *
 * 合规底线（与 issue-resolved / telemetry / experience 同级，另加内容级自检）：
 *   1. 只发 FEEDBACK_FIELDS 白名单字段（硬编码），其余键一律丢弃。
 *   2. FEEDBACK_FORBIDDEN 黑名单键命中即拒（双保险；接收端同款黑名单兜底）。
 *   3. **S01–S10 内容级正则扫描**（移植 tools/feedback/case-feedback.mjs:28-39），
 *      命中即拒——自由文本是键名白名单管不住的泄漏面，必须内容级自检。
 *      （几何尺寸 / 槽数 / 匝数线规 / 电流电密 / 效率损耗 / 客户项目 / 本机路径 /
 *        UNC 路径 / 哈希长串 / 邮箱手机号）
 *   4. fire-and-forget：HTTP 失败 / 超时绝不影响工具主流程。
 *   5. 默认关闭：experienceFeedbackEnabled !== true = 完全不启用（**opt-in**，
 *      比 design_exp 的 opt-out 更保守——文字反馈比数值样本更易夹带上下文）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

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

// 仅允许回流的纯技术内容字段（与接收端白名单逐字一致；rec_id 单独追加）
export const FEEDBACK_FIELDS = [
  'title', 'body', 'category', 'related_tool', 'severity', 'tags',
  'source_ref', 'related_plugin_version',
]

// 黑名单键（与接收端 EXPERIENCE_FEEDBACK_FORBIDDEN 逐字一致）：命中即拒，不做静默剥离
export const FEEDBACK_FORBIDDEN = [
  'client_id', 'user', 'account', 'username', 'hostname', 'cwd', 'prompt',
  'token', 'api_key', 'secret', 'password', 'email', 'phone', 'wechat',
  'design_params', 'result', 'design', 'path', 'file', 'directory',
]

// S01–S10 内容级脱敏规则（与 case-feedback.mjs:28-39 逐条对应）
export const SENSITIVE_RULES = [
  { id: 'S01', name: '几何尺寸', re: /\b(?:stator_od|stator_id|core_length|yoke_thickness)\s*[=:]\s*[\d.]+/i },
  { id: 'S02', name: '槽数', re: /\b(?:slots?_stator|slots?_rotor|Q[se])\s*[=:]\s*\d+/i },
  { id: 'S03', name: '匝数/线规', re: /\b(?:turns?_per_coil|wire_dia|n_strands)\s*[=:]\s*[\d.]+/i },
  { id: 'S04', name: '电流/电密', re: /\b(?:peak_current|line_current|current_density|Irms)\s*[=:]\s*[\d.]+/i },
  { id: 'S05', name: '效率/损耗数值', re: /\b(?:l0_eff|l1_eff|efficiency|total_loss|copper_loss|iron_loss)\s*[=:]\s*[\d.]+/i },
  { id: 'S06', name: '客户/项目标识', re: /(?:客户|项目|单位|company|customer|project)\s*[=:：]\s*\S+/i },
  { id: 'S07', name: '本机绝对路径', re: /[A-Za-z]:[\\/](?:Users|MotorDesign|home)\S*/ },
  { id: 'S08', name: 'UNC/网络路径', re: /\\\\[\w.-]+\\[^\s]+/ },
  { id: 'S09', name: '哈希/长串token', re: /\b[0-9a-f]{16,}\b/i },
  { id: 'S10', name: '邮箱/手机号', re: /[\w.+-]+@[\w-]+\.[\w.]+|\b1[3-9]\d{9}\b/ },
]

/**
 * 内容级脱敏自检：对 title + body 扫描 S01–S10，任一命中即抛错。
 * @param {string} title
 * @param {string} body
 * @throws {Error} 命中敏感规则时抛出（message 含规则 id 与名称）
 */
export function assertNoSensitiveContent(title, body) {
  const text = `${title ?? ''}\n${body ?? ''}`
  for (const rule of SENSITIVE_RULES) {
    if (rule.re.test(text)) {
      throw new Error(`脱敏自检命中 ${rule.id}（${rule.name}）：内容含敏感形态，请脱敏后再提交。`)
    }
  }
}

/**
 * rec_id：title + body 的 sha1 前 12 位（幂等键，供接收端审计去重与策展追溯）。
 */
export function feedbackRecIdOf(payload = {}) {
  const raw = `fb:${payload.title || ''};${payload.body || ''}`
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12)
}

/**
 * 解析回传目标 URL。
 * 优先级：config.experienceFeedbackEndpoint 显式配置 > 由 commerceBackendUrl 自动拼
 * /api/dsh/experience-feedback。两者皆空则回传不启用。
 */
export function resolveFeedbackEndpoint(config = {}) {
  const explicit = String(config.experienceFeedbackEndpoint || '').trim()
  if (explicit) return explicit
  const backend = String(config.commerceBackendUrl || config.backendUrl || '').trim()
  if (backend) return backend.replace(/\/+$/, '') + '/api/dsh/experience-feedback'
  return ''
}

/**
 * 提交一条文字经验反馈到接收端（fire-and-forget）。
 * @param {object} config 插件配置（experienceFeedbackEnabled / experienceFeedbackEndpoint / commerceBackendUrl）
 * @param {object} payload { title, body, category, related_tool, severity, tags, source_ref }
 * @returns {Promise<{ submitted: boolean, reason?: string, rec_id?: string }>}
 */
export async function submitExperienceFeedback(config = {}, payload = {}) {
  // opt-in 门：experienceFeedbackEnabled !== true 一律不启用（与 design_exp 的 opt-out 相反）
  if (config.experienceFeedbackEnabled !== true) return { submitted: false, reason: 'disabled' }
  const endpoint = resolveFeedbackEndpoint(config)
  if (!endpoint) return { submitted: false, reason: 'no-endpoint' }

  // 黑名单键命中即拒（防御性双保险：正常调用路径根本到不了这里）
  for (const bad of FEEDBACK_FORBIDDEN) {
    if (payload && typeof payload === 'object' && bad in payload) {
      return { submitted: false, reason: `forbidden-field:${bad}` }
    }
  }
  // 白名单裁剪：仅保留 FEEDBACK_FIELDS，其余键（含意外混入字段）丢弃
  const cleaned = {}
  for (const k of FEEDBACK_FIELDS) {
    if (payload[k] !== undefined && payload[k] !== null) cleaned[k] = payload[k]
  }
  // 必填：title + body 非空
  cleaned.title = String(cleaned.title || '').trim()
  cleaned.body = String(cleaned.body || '').trim()
  if (!cleaned.title || !cleaned.body) return { submitted: false, reason: 'empty-content' }
  // 内容级脱敏自检（S01–S10）：命中即拒，绝不静默脱敏后照发
  try {
    assertNoSensitiveContent(cleaned.title, cleaned.body)
  } catch (err) {
    return { submitted: false, reason: `sensitive:${err.message}` }
  }
  // 幂等键
  cleaned.rec_id = feedbackRecIdOf(payload)

  const body = {
    plugin: 'dsh-motor-ai-full',
    plugin_version: fallbackVersion(),
    kind: 'l0-experience-feedback',
    ...cleaned,
    reported_at: new Date().toISOString(),
  }

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 5000) : null
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'dsh-motor-ai-full/experience-feedback' },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (timer) clearTimeout(timer)
    if (res && res.ok) return { submitted: true, rec_id: cleaned.rec_id }
    return { submitted: false, reason: `http_${res?.status ?? 'n/a'}` }
  } catch (err) {
    return { submitted: false, reason: String(err?.message ?? err).slice(0, 60) }
  }
}

export default {
  FEEDBACK_FIELDS, FEEDBACK_FORBIDDEN, SENSITIVE_RULES,
  assertNoSensitiveContent, feedbackRecIdOf, resolveFeedbackEndpoint, submitExperienceFeedback,
}
