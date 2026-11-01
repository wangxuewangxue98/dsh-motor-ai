/**
 * motor_template_fetch.mjs —— L2 模板在线获取工具（S3）
 *
 * 功能：从后端 /api/dsh/template-registry 查询可用模板列表，按需下载到本地缓存。
 * 落地 S3：复用 commerceBackendUrl 通道 + open-channel-secret 鉴权思路，不引入新技术栈。
 *
 * 后端端点契约（制作者侧按此实现；插件只负责调用）：
 *   GET /api/dsh/template-registry?token=<openSecret>
 *     → { templates: [{ id, name, motor_type, aedt_version, motorcad_module, size_bytes, sha256, source, license_note, download_url }] }
 *   GET <download_url>?token=<openSecret>
 *     → 二进制模板文件（.mot / .aedt）
 *
 * 本地缓存：$DSH_HOME/storages/dsh-motor-ai/templates/<id>.<ext>
 *   缓存命中（文件存在 + sha256 一致）→ 直接返回路径，不重复下载。
 *
 * 工具注册名：motor_template_fetch
 * 触发场景：L2 motor_motorcad_verify 在 resolveDefaultMotFile 找不到文件时，
 *           引导用户通过此工具获取在线模板。
 */

import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { resolveOpenSecret } from '../../lib/open-channel-secret.mjs'

const __dirname = dirname(import.meta.url)

/** 本地缓存根目录 */
export function templateCacheDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-motor-ai', 'templates')
}

/**
 * 解析模板注册表端点 URL。
 * @param {object} config
 * @returns {string} 端点 URL 或空串（后端不可达）
 */
export function resolveTemplateRegistryEndpoint(config = {}) {
  const base = String(
    config.commerceBackendUrl || config.backendUrl || process.env.DSH_BACKEND_URL || ''
  ).trim().replace(/\/+$/, '')
  if (!base) return ''
  return base + '/api/dsh/template-registry'
}

/**
 * 列出可用模板（从后端拉取 registry）。
 * @param {object} [config]
 * @returns {Promise<{ ok: boolean, templates?: Array<object>, error?: string }>}
 */
export async function listTemplates(config = {}) {
  const url = resolveTemplateRegistryEndpoint(config)
  if (!url) {
    return { ok: false, error: 'backend not configured（未配置 commerceBackendUrl，模板下载通道不可用）' }
  }
  const secret = resolveOpenSecret(config)
  const target = url + (secret ? '?token=' + encodeURIComponent(secret) : '')
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 8000) : null
    const res = await fetch(target, { signal: controller?.signal })
    if (timer) clearTimeout(timer)
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} from template-registry` }
    }
    const body = await res.json()
    if (!body || !Array.isArray(body.templates)) {
      return { ok: false, error: 'registry response missing templates array' }
    }
    return { ok: true, templates: body.templates }
  } catch (e) {
    return { ok: false, error: `template-registry fetch failed: ${e.message}` }
  }
}

/**
 * 下载单个模板到本地缓存。
 * @param {object} tmpl 来自 registry 的单条模板元数据
 * @param {object} [config]
 * @returns {Promise<{ ok: boolean, cached_path?: string, error?: string }>}
 */
export async function downloadTemplate(tmpl, config = {}) {
  if (!tmpl || !tmpl.id || !tmpl.download_url) {
    return { ok: false, error: 'invalid template metadata (missing id or download_url)' }
  }
  const cacheDir = templateCacheDir()
  mkdirSync(cacheDir, { recursive: true })
  const ext = (tmpl.download_url.match(/\.(\w+)(?:\?|$)/) || [])[1] || 'mot'
  const cachedPath = join(cacheDir, `${tmpl.id}.${ext}`)

  // 缓存命中：文件存在 + sha256 一致 → 直接返回
  if (existsSync(cachedPath) && tmpl.sha256) {
    try {
      const data = readFileSync(cachedPath)
      const actualSha = createHash('sha256').update(data).digest('hex')
      if (actualSha === tmpl.sha256) {
        return { ok: true, cached_path: cachedPath }
      }
    } catch { /* 校验失败，重新下载 */ }
  }

  // 下载
  const secret = resolveOpenSecret(config)
  const url = tmpl.download_url + (secret ? (tmpl.download_url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(secret) : '')
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 30000) : null
    const res = await fetch(url, { signal: controller?.signal })
    if (timer) clearTimeout(timer)
    if (!res.ok) {
      return { ok: false, error: `download HTTP ${res.status}` }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(cachedPath, buf)
    return { ok: true, cached_path: cachedPath }
  } catch (e) {
    return { ok: false, error: `download failed: ${e.message}` }
  }
}

/**
 * 快捷工具：按 motorType 自动解析 + 下载默认模板。
 * @param {object} params
 * @param {string} params.motorType
 * @param {object} [config]
 */
export async function fetchDefaultTemplate(params, config = {}) {
  const { motorType } = params
  if (!motorType) {
    return { ok: false, error: 'motorType 必填' }
  }
  // 先尝试本地默认模板（S2 已落地）
  const { resolveDefaultMotFile } = await import('./motorcad-verify.mjs').catch(() => ({}))
  if (resolveDefaultMotFile) {
    const local = resolveDefaultMotFile({ motorType })
    if (local && existsSync(local)) {
      return { ok: true, cached_path: local, source: 'local' }
    }
  }
  // 本地无 → 从在线 registry 获取
  const list = await listTemplates(config)
  if (!list.ok) return { ok: false, error: list.error }
  const match = list.templates.find(t => t.motor_type === motorType || t.id === motorType)
  if (!match) {
    return {
      ok: false,
      error: `未找到 ${motorType} 模板（registry 可用: ${list.templates.map(t => t.id).join(', ') || '空'}）`,
    }
  }
  const dl = await downloadTemplate(match, config)
  if (!dl.ok) return { ok: false, error: dl.error }
  return { ok: true, cached_path: dl.cached_path, source: 'online' }
}
