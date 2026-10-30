#!/usr/bin/env node
/**
 * doc 通道（lib/doc-upload.mjs + tools/doc-upload-tool.mjs）单元测试。
 * 独立 node 脚本（非 jest 用例）：node tests/doc-upload.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  chunkUtf8Bytes, chunkBase64, guessEncoding, guessMime, docIdOf,
  resolveDocEndpoint, uploadDocument, MAX_CHUNKS_OPEN,
} from '../lib/doc-upload.mjs'
import { runUploadDocument } from '../tools/doc-upload-tool.mjs'

let pass = 0
let fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) }
}

// ---------- 1. 纯函数：分块 ----------
console.log('[1] chunkUtf8Bytes 字节级分块（中文不截断）')
{
  const text = Array.from({ length: 20000 }, (_, i) => `第${i}节绕组温升α=0.00393/°C；`).join('')
  const raw = Buffer.from(text, 'utf8')
  const chunks = chunkUtf8Bytes(raw, 30 * 1024)
  const recombined = Buffer.from(chunks.join(''), 'utf8')
  ok('重组后字节一致', recombined.equals(raw))
  ok('每块 ≤ 30KB 字节', chunks.every((c) => Buffer.byteLength(c, 'utf8') <= 30 * 1024))
  ok('块数 > 1（确实发生了分块）', chunks.length > 1)
}
console.log('[2] chunkBase64 二进制分块')
{
  const raw = Buffer.from(Array.from({ length: 100000 }, (_, i) => (i * 7) % 256))
  const chunks = chunkBase64(raw, 36 * 1024)
  const b64 = Buffer.from(chunks.join(''), 'base64')
  ok('重组后字节一致', b64.equals(raw))
  ok('每块 ≤ 36KB', chunks.every((c) => c.length <= 36 * 1024))
}
console.log('[3] 类型猜测与 doc_id')
{
  ok('md → utf8', guessEncoding('a.md') === 'utf8')
  ok('png → base64', guessEncoding('a.png') === 'base64')
  ok('pdf → base64', guessEncoding('a.PDF') === 'base64')
  ok('md mime', guessMime('x.md') === 'text/markdown')
  ok('png mime', guessMime('x.png') === 'image/png')
  const id = docIdOf('电机 报告 v2.md')
  ok('doc_id 符合接收端正则', /^[a-zA-Z0-9_-]{6,64}$/.test(id))
  ok('doc_id 不含空格/中文', !/[ \u4e00-\u9fff]/.test(id))
}
console.log('[4] 端点解析')
{
  ok('显式优先', resolveDocEndpoint({ docUploadEndpoint: 'http://x/api/dsh/doc-upload', commerceBackendUrl: 'http://y' }) === 'http://x/api/dsh/doc-upload')
  ok('回退拼接', resolveDocEndpoint({ commerceBackendUrl: 'http://y/' }) === 'http://y/api/dsh/doc-upload')
  ok('皆空返回空', resolveDocEndpoint({}) === '')
}

// ---------- 2. 门禁（不发网络） ----------
console.log('[5] opt-in 门与端点缺失')
{
  const r1 = await uploadDocument({}, '/tmp/x.md')
  ok('默认关 → disabled', r1.reason === 'disabled')
  const r2 = await uploadDocument({ docUploadEnabled: true }, '/tmp/x.md')
  ok('无端点 → no-endpoint', r2.reason === 'no-endpoint')
  const r3 = await uploadDocument({ docUploadEnabled: true, docUploadEndpoint: 'http://x' }, '/nonexistent-file-xyz.md')
  ok('文件不可读 → file-unreadable', r3.reason === 'file-unreadable')
}

// ---------- 3. mock fetch 全链上传 ----------
console.log('[6] mock fetch：文本全链上传')
{
  const captured = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true, inserted: 1 }) }
  }
  const tmp = path.join(os.tmpdir(), `doc-upload-test-${Date.now()}.md`)
  fs.writeFileSync(tmp, '测试文档'.repeat(20000), 'utf8') // ≈240KB → 多块
  const res = await uploadDocument(
    { docUploadEnabled: true, docUploadEndpoint: 'http://mock/api/dsh/doc-upload' },
    tmp,
  )
  fs.unlinkSync(tmp)
  ok('uploaded=true', res.uploaded === true)
  ok('多块上传', res.chunks > 1)
  ok('payload kind 正确', captured[0]?.body.kind === 'l0-doc-upload')
  ok('seq/total 连续', captured.length === res.chunks
    && captured.every((c, i) => c.body.seq === i + 1 && c.body.total === res.chunks))
  ok('filename 为 basename', captured[0]?.body.filename.endsWith('.md') && !captured[0].body.filename.includes('/') && !captured[0].body.filename.includes('\\'))
  ok('无 token 走开放档 URL（无 query）', !String(captured[0]?.url).includes('token='))
  globalThis.fetch = origFetch
}
console.log('[7] mock fetch：二进制 base64 + token 档')
{
  const captured = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const tmp = path.join(os.tmpdir(), `doc-upload-test-${Date.now()}.png`)
  fs.writeFileSync(tmp, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)))
  const res = await uploadDocument(
    { docUploadEnabled: true, docUploadEndpoint: 'http://mock/api/dsh/doc-upload', docUploadToken: 'tok-abc' },
    tmp,
  )
  fs.unlinkSync(tmp)
  ok('uploaded=true', res.uploaded === true)
  ok('encoding=base64', captured[0]?.body.encoding === 'base64')
  ok('mime=image/png', captured[0]?.body.mime === 'image/png')
  ok('token 档 URL 带 token', String(captured[0]?.url).includes('token=tok-abc'))
  globalThis.fetch = origFetch
}
console.log('[8] 超限门禁（开放档 32 块）')
{
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ ok: true }) } }
  const tmp = path.join(os.tmpdir(), `doc-upload-big-${Date.now()}.txt`)
  fs.writeFileSync(tmp, 'a'.repeat(MAX_CHUNKS_OPEN * 30 * 1024 + 100), 'utf8')
  const res = await uploadDocument(
    { docUploadEnabled: true, docUploadEndpoint: 'http://mock/api/dsh/doc-upload' },
    tmp,
  )
  fs.unlinkSync(tmp)
  ok('too-large 拒绝', res.uploaded === false && res.reason === 'too-large')
  ok('未发任何网络请求', calls === 0)
  globalThis.fetch = origFetch
}
console.log('[9] 工具层 runUploadDocument 消息')
{
  const r1 = await runUploadDocument({}, {})
  ok('缺参 → error', r1.status === 'error')
  const r2 = await runUploadDocument({ file_path: '/tmp/x.md' }, {})
  ok('默认关 → skipped + 引导开启', r2.status === 'skipped' && r2.message.includes('docUploadEnabled'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
