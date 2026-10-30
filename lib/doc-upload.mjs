/**
 * 整篇文档分块回传（doc 通道，v1.2.1）
 * ===========================================================
 * 需求：客户端「收集的资料 / 整理的文件」需要**完整原样**回传（非蒸馏条目），
 * 经贡献型工具 motor_upload_doc 把整篇文档分块发回接收端
 * （POST /api/dsh/doc-upload，kind='l0-doc-upload'），落 ['doc']，
 * 维护者经 export 拉取重组还原原文件。**不进检索库**——要入库走策展切条
 * （motor_submit_experience / 策展管线）。
 *
 * 与 fbk 通道（motor_submit_experience）的分工：
 *   - experience-feedback：蒸馏后的经验条目（进 ['fbk'] → 策展 → ['kb'] 检索注入）
 *   - doc-upload：完整原文件传输（进 ['doc']，字节级还原留档）
 *
 * 协议要点（与接收端 main.ts handleDocUpload 对齐）：
 *   - 分块 {doc_id, filename, mime, seq, total, encoding, data}；
 *   - encoding='utf8'（文本）按**字节**切块并回退多字节边界（中文 1 字符=3 字节，
 *     按字符切会超 KV value 64KiB 上限被拒）；'base64'（二进制图片/PDF）；
 *   - 单块 data ≤48KB；单文档 ≤512 块（token 档 ≈18MB）/ 32 块（开放档 ≈1.1MB）；
 *   - 鉴权两档（v1.2.2 起开放档也带轻量共享密钥 lib/open-channel-secret.mjs）：
 *     带 docUploadToken → token 档全限额；无 token → 开放档（接收端需 DOC_UPLOAD_OPEN=1，
 *     单文档 ≤32 块 ≈1.1MB），URL 恒带 ?token=<开放密钥>——接收端设 OPEN_CHANNEL_SECRET
 *     同值后闸门生效，未设则该参数被忽略（零联系自主回传不变）；
 *   - fire-and-forget：失败只返回结果对象，绝不抛出、绝不阻断主流程。
 *
 * 合规底线：
 *   1. 默认关闭：docUploadEnabled !== true = 完全不启用（**opt-in**）。
 *   2. 文件内容**不做脱敏扫描**（原样传输是本通道目的）——调用方（AI 会话/用户）
 *      自行把关敏感文档；工具描述里明确提示。
 *   3. 文件名只取 basename（服务端同款消毒，双保险）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { resolveOpenSecret } from './open-channel-secret.mjs'

/** 文本扩展名（这些按 utf8 直传，其余一律 base64） */
export const TEXT_EXTS = new Set([
  '.md', '.txt', '.json', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.yml', '.yaml', '.csv', '.log', '.html', '.css', '.xml', '.ini', '.toml',
  '.bat', '.sh', '.sql', '.svg', '.tex', '.rst',
])

/** 单块 data 载荷字节上限（与接收端 MAX_DOC_CHUNK_B64 一致） */
export const MAX_CHUNK_BYTES = 48 * 1024
/** 开放档（无 token）分块上限（与接收端 MAX_DOC_TOTAL_CHUNKS_OPEN 一致） */
export const MAX_CHUNKS_OPEN = 32
/** token 档分块上限（与接收端 MAX_DOC_TOTAL_CHUNKS 一致） */
export const MAX_CHUNKS_TOKEN = 512

const MIME_TABLE = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.html': 'text/html',
}

export function guessEncoding(filename) {
  return TEXT_EXTS.has(path.extname(filename).toLowerCase()) ? 'utf8' : 'base64'
}

export function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (MIME_TABLE[ext]) return MIME_TABLE[ext]
  return guessEncoding(filename) === 'utf8' ? 'text/plain' : 'application/octet-stream'
}

export function docIdOf(filename) {
  const base = path.basename(filename).replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]/g, '-')
  const rand = crypto.randomBytes(6).toString('hex')
  const id = `d-${base || 'doc'}-${rand}`.slice(0, 64)
  return /^[a-zA-Z0-9_-]{6,64}$/.test(id) ? id : `d-doc-${rand}`
}

/**
 * utf8 字节级分块：按字节切、回退多字节字符边界（中文不截断）。
 * @param {Buffer} raw
 * @param {number} maxBytes 单块字节上限
 * @returns {string[]} 每块为可独立 decode 的 utf8 字符串
 */
export function chunkUtf8Bytes(raw, maxBytes = 30 * 1024) {
  const chunks = []
  let start = 0
  const n = raw.length
  while (start < n) {
    let end = Math.min(start + maxBytes, n)
    // 回退到 UTF-8 字符起始字节（后续字节形如 10xxxxxx）
    while (end < n && (raw[end] & 0xc0) === 0x80) end -= 1
    chunks.push(raw.subarray(start, end).toString('utf8'))
    start = end
  }
  return chunks.length ? chunks : ['']
}

/** base64 分块（ASCII，字符=字节） */
export function chunkBase64(raw, maxBytes = 36 * 1024) {
  const b64 = raw.toString('base64')
  const chunks = []
  for (let i = 0; i < b64.length; i += maxBytes) chunks.push(b64.slice(i, i + maxBytes))
  return chunks.length ? chunks : ['']
}

/**
 * 解析 doc 上传目标 URL。
 * 优先级：config.docUploadEndpoint 显式 > commerceBackendUrl + /api/dsh/doc-upload。
 */
export function resolveDocEndpoint(config = {}) {
  const explicit = String(config.docUploadEndpoint || '').trim()
  if (explicit) return explicit
  const backend = String(config.commerceBackendUrl || config.backendUrl || '').trim()
  if (backend) return backend.replace(/\/+$/, '') + '/api/dsh/doc-upload'
  return ''
}

function postJson(url, body, timeoutMs = 15000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'dsh-motor-ai-full/doc-upload' },
    body: JSON.stringify(body),
    ...(controller ? { signal: controller.signal } : {}),
  }).finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * 上传整篇文档（分块，顺序 POST，失败重试 2 次）。
 * @param {object} config 插件配置（docUploadEnabled / docUploadEndpoint / docUploadToken / commerceBackendUrl）
 * @param {string} filePath 本地文件绝对路径
 * @param {object} [opts] { docId }
 * @returns {Promise<{uploaded: boolean, reason?: string, doc_id?: string, chunks?: number, bytes?: number, filename?: string}>}
 */
export async function uploadDocument(config = {}, filePath = '', opts = {}) {
  // opt-in 门：docUploadEnabled !== true 一律不启用
  if (config.docUploadEnabled !== true) return { uploaded: false, reason: 'disabled' }
  const endpoint = resolveDocEndpoint(config)
  if (!endpoint) return { uploaded: false, reason: 'no-endpoint' }

  let raw
  try {
    raw = fs.readFileSync(filePath)
  } catch {
    return { uploaded: false, reason: 'file-unreadable' }
  }
  const filename = path.basename(filePath)
  if (!filename || filename === '.' || filename === '..') {
    return { uploaded: false, reason: 'bad-filename' }
  }
  const encoding = guessEncoding(filename)
  const mime = guessMime(filename)
  const chunks = encoding === 'utf8'
    ? chunkUtf8Bytes(raw, 30 * 1024)
    : chunkBase64(raw, 36 * 1024)
  const docId = String(opts.docId || docIdOf(filename))
  const token = String(config.docUploadToken || '').trim()
  const cap = token ? MAX_CHUNKS_TOKEN : MAX_CHUNKS_OPEN
  if (chunks.length > cap) {
    return {
      uploaded: false, reason: 'too-large',
      doc_id: docId, chunks: chunks.length, bytes: raw.length,
      message: `分块 ${chunks.length} 超过${token ? 'token' : '开放'}档上限 ${cap}；`
        + (token ? '' : '配置 docUploadToken 可解锁 512 块（≈18MB），或拆分文件。'),
    }
  }

  // v1.2.2：开放档（无 docUploadToken）也携带轻量共享密钥 ?token=<openSecret>，
  // 与 token 档复用同一查询参数。接收端未设 OPEN_CHANNEL_SECRET 时该 token 被忽略
  // （向后兼容 1.2.1 纯开放）；设了同值后闸门生效（未携带密钥的老客户端 401）。
  const openSecret = resolveOpenSecret(config)
  const url = token
    ? `${endpoint}?token=${encodeURIComponent(token)}`
    : `${endpoint}?token=${encodeURIComponent(openSecret)}`
  for (let i = 0; i < chunks.length; i++) {
    const body = {
      plugin: 'dsh-motor-ai-full',
      kind: 'l0-doc-upload',
      doc_id: docId,
      filename,
      mime,
      seq: i + 1,
      total: chunks.length,
      encoding,
      data: chunks[i],
    }
    let ok = false
    let lastErr = ''
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const res = await postJson(url, body)
        ok = !!(res && res.ok)
        if (!ok) lastErr = `http_${res?.status ?? 'n/a'}`
      } catch (err) {
        lastErr = String(err?.message ?? err).slice(0, 60)
        if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
      }
    }
    if (!ok) return { uploaded: false, reason: `chunk-${i + 1}-failed:${lastErr}`, doc_id: docId, chunks: chunks.length, bytes: raw.length }
  }
  return { uploaded: true, doc_id: docId, chunks: chunks.length, bytes: raw.length, filename }
}

export default {
  TEXT_EXTS, MAX_CHUNK_BYTES, MAX_CHUNKS_OPEN, MAX_CHUNKS_TOKEN,
  guessEncoding, guessMime, docIdOf, chunkUtf8Bytes, chunkBase64,
  resolveDocEndpoint, uploadDocument,
}
