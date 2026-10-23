/**
 * 设计经验注入（design-assist，统一供给）—— 客户设计前自动利用知识库经验
 * ===========================================================
 * 定位：在客户做 L0 估算 / 设计任务前（或结果返回时），把 KB-A/KB-B 中相关的
 * 设计经验（L1 杠杆知识、L2 评价经验、已解决的设计类案例）注入到返回体，
 * 让客户无感复用历史经验。
 *
 * 数据源：接收端 GET /api/dsh/kb/query（在 ['kb'] 策展知识 + ['iss'] 已解决里做
 * CJK bigram 相似匹配，返回 top-N { kind, title, url, snippet, score }）。
 *
 * 合规与健壮性（与 fault-report 同级）：
 *   1. fire-and-forget：HTTP 失败 / 超时**绝不影响**设计主流程（异常静默降级）。
 *   2. 仅读取公开/脱敏经验字段（title/url/snippet），不回传任何设计参数。
 *   3. 默认启用（受 designAssistEnabled 控制；与 faultAssistEnabled 同级 opt-out）。
 */

import fs from 'node:fs'
import path from 'node:path'
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

/**
 * 解析设计经验查询端点（GET /api/dsh/kb/query）。
 * 优先级：config.kbQueryEndpoint 显式配置 > commerceBackendUrl 自动拼。
 */
export function resolveKbQueryEndpoint(config = {}) {
  const explicit = String(config.kbQueryEndpoint || '').trim()
  if (explicit) return explicit
  const backend = String(config.commerceBackendUrl || config.backendUrl || '').trim()
  if (backend) return backend.replace(/\/+$/, '') + '/api/dsh/kb/query'
  return ''
}

/**
 * 查询设计经验（GET /api/dsh/kb/query）。
 * @param {object} config 插件配置（kbQueryEndpoint / commerceBackendUrl / designAssistEnabled）
 * @param {object} opts { q, limit? }
 * @returns {Promise<{ ok: boolean, matches: object[], total?: number, reason?: string }>}
 */
export async function queryDesignKnowledge(config = {}, opts = {}) {
  const enabled = config.designAssistEnabled !== false
  if (!enabled) return { ok: false, reason: 'disabled', matches: [] }
  const endpoint = resolveKbQueryEndpoint(config)
  if (!endpoint) return { ok: false, reason: 'no-endpoint', matches: [] }
  const q = String(opts.q || '').trim()
  if (!q) return { ok: false, reason: 'empty_query', matches: [] }

  const params = new URLSearchParams()
  params.set('q', q)
  const limit = Number(opts.limit) || 5
  params.set('limit', String(Math.min(Math.max(limit, 1), 20)))

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 5000) : null
    const sep = endpoint.includes('?') ? '&' : '?'
    const res = await fetch(endpoint + sep + params.toString(), {
      method: 'GET',
      headers: { 'User-Agent': 'dsh-motor-ai-full/design-assist' },
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

/**
 * 把设计经验提示注入到设计工具返回对象（非破坏性：新增 design_knowledge_hints 字段）。
 * 仅当查询成功且有匹配时写入；异常静默降级，绝不抛错影响主流程。
 * @param {object} resultObj 设计工具的结果对象（会被原地追加 design_knowledge_hints）
 * @param {object} opts { config, q, limit? }
 * @returns {Promise<object>} 同一对象
 */
export async function withDesignAssist(resultObj, opts = {}) {
  if (!resultObj || typeof resultObj !== 'object') return resultObj
  const config = opts.config || {}
  if (config.designAssistEnabled === false) return resultObj
  // 已有则不覆盖
  if (Array.isArray(resultObj.design_knowledge_hints)) return resultObj
  try {
    const q = String(opts.q || '').trim()
    if (!q) return resultObj
    const res = await queryDesignKnowledge(config, { q, limit: opts.limit || 5 })
    if (res.ok && res.matches.length) {
      resultObj.design_knowledge_hints = res.matches.map((m) => ({
        kind: m.kind,
        title: m.title,
        url: m.url || null,
        snippet: m.snippet || '',
        score: m.score,
      }))
    }
  } catch { /* 静默降级：绝不阻断设计主流程 */ }
  return resultObj
}

export default {
  resolveKbQueryEndpoint,
  queryDesignKnowledge,
  withDesignAssist,
}
