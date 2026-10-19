/**
 * P1-B/C 完整版移植功能点测（本地 http server 拦截 fetch 验证 body）
 * 运行：node tests/p1bc-issue-resolved.test.mjs（在仓库根执行）
 * 覆盖：
 *  1) resolveIssueResolvedEndpoint：显式优先 / backend 派生 / 都空
 *  2) submitResolvedCase：disabled / no-endpoint / empty-content 拒绝路径
 *  3) submitResolvedCase：真实提交 → 本地 server 收到白名单裁剪后 body（kind/plugin/无身份字段）
 *  4) runSubmitResolvedCase：skipped 含 KB URL / 不含 URL
 *  5) buildQuotaExceededMessage：KB 注入 / 不注入
 *  6) resolveExperienceEndpoint：显式优先 / telemetry 同源派生 / backend 派生 / 都空
 *  7) DEFAULT_QUOTA_PLUGIN_ID === 'dsh-motor-ai-full'
 */
import http from 'node:http'
import assert from 'node:assert/strict'

const {
  ISSUE_RESOLVED_FIELDS, resolveIssueResolvedEndpoint, submitResolvedCase,
} = await import('../lib/issue-resolved.mjs')
const { runSubmitResolvedCase } = await import('../tools/l0/issue-resolved-tool.mjs')
const { buildQuotaExceededMessage, DEFAULT_QUOTA_PLUGIN_ID } = await import('../lib/quota.mjs')
const { resolveExperienceEndpoint } = await import('../lib/experience-upload.mjs')

// ── 本地拦截 server ──
let lastBody = null
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => { lastBody = JSON.parse(raw || '{}'); res.writeHead(200); res.end('{"ok":true}') })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('✅', name) } else { fail++; console.log('❌', name) } }

// 1) 端点解析
ok(resolveIssueResolvedEndpoint({ issueResolvedEndpoint: 'https://x.test/hook' }) === 'https://x.test/hook', '显式 endpoint 优先')
ok(resolveIssueResolvedEndpoint({ commerceBackendUrl: 'https://r.deno.net/' }) === 'https://r.deno.net/api/dsh/issue-resolved', 'backend 派生（去尾斜杠）')
ok(resolveIssueResolvedEndpoint({}) === '', '都空 → 空')

// 2) 拒绝路径
ok((await submitResolvedCase({ issueResolvedEnabled: false }, { symptom: 's' })).reason === 'disabled', 'disabled')
ok((await submitResolvedCase({ issueResolvedEnabled: true }, { symptom: 's' })).reason === 'no-endpoint', 'no-endpoint')
{
  const r = await submitResolvedCase({ issueResolvedEnabled: true, issueResolvedEndpoint: BASE + '/api/dsh/issue-resolved' }, { category: 'geometry' })
  ok(r.reason === 'empty-content', 'empty-content（仅 category 无 symptom/process）')
}

// 3) 真实提交 + body 校验
{
  const cfg = { issueResolvedEnabled: true, issueResolvedEndpoint: BASE + '/api/dsh/issue-resolved' }
  const r = await submitResolvedCase(cfg, {
    symptom: 'V08 轭厚 failed', root_cause: '轭厚偏小', remediation: '提到 16mm',
    resolution_process: '现象→定位→修复→复测通过', category: 'magnetic',
    // 混入身份类字段，应被白名单裁剪丢弃：
    email: 'someone@example.com', abs_path: 'D:/secret/x.mjs', api_key: 'sk-xxx',
  })
  ok(r.submitted === true, '提交成功（本地 server 200）')
  ok(lastBody && lastBody.kind === 'l0-issue-resolved', 'kind = l0-issue-resolved（receiver 协议常量）')
  ok(lastBody && lastBody.plugin === 'dsh-motor-ai-full', 'plugin = dsh-motor-ai-full（来源区分）')
  ok(lastBody && lastBody.email === undefined && lastBody.abs_path === undefined && lastBody.api_key === undefined, '身份类字段被白名单裁剪丢弃')
  ok(lastBody && lastBody.symptom === 'V08 轭厚 failed' && typeof lastBody.plugin_version === 'string', '内容字段透传 + plugin_version 来自 package.json')
}

// 4) runSubmitResolvedCase skipped 文案
{
  const r3 = await runSubmitResolvedCase({ symptom: 's' }, { issueResolvedEnabled: false, knowledgeBaseUrl: 'https://kb.example/share' })
  ok(r3.status === 'skipped' && r3.message.includes('https://kb.example/share'), 'skipped 含 KB 链接')
  const r4 = await runSubmitResolvedCase({ symptom: 's' }, { issueResolvedEnabled: false })
  ok(r4.status === 'skipped' && !r4.message.includes('http'), 'skipped 无 kb 不带链接')
}

// 5) quota 文案 KB 注入
{
  const withKb = buildQuotaExceededMessage({ limit: 10, used: 10, tier: 'free', knowledgeBaseUrl: 'https://kb.example/share' })
  ok(withKb.includes('在线知识库') && withKb.includes('https://kb.example/share'), 'quota free 文案注入 KB')
  const noKb = buildQuotaExceededMessage({ limit: 10, used: 10 })
  ok(!noKb.includes('在线知识库'), 'quota 不配 kb 无链接（向后兼容）')
  const paid = buildQuotaExceededMessage({ limit: 9999, used: 9999, tier: 'paid', knowledgeBaseUrl: 'https://kb.example/share' })
  ok(paid.includes('授权档上限'), 'paid 档文案不受影响')
}

// 6) experience 端点派生（潜伏问题 2 修复）
ok(resolveExperienceEndpoint({ experienceEndpoint: 'https://x.test/exp' }) === 'https://x.test/exp', 'experience 显式优先')
ok(resolveExperienceEndpoint({ telemetryEndpoint: 'https://r.deno.net/api/dsh/telemetry' }) === 'https://r.deno.net/api/dsh/experience', 'telemetry 同源派生 /api/dsh/experience')
ok(resolveExperienceEndpoint({ commerceBackendUrl: 'https://r.deno.net/' }) === 'https://r.deno.net/api/dsh/experience', 'backend 派生')
ok(resolveExperienceEndpoint({}) === '', '都空 → 空')
ok(resolveExperienceEndpoint({ telemetryEndpoint: 'not-a-url', backendUrl: 'http://127.0.0.1:5000' }) === 'http://127.0.0.1:5000/api/dsh/experience', '非法 telemetry URL 落 backend')

// 7) 潜伏问题 1：plugin_id 默认桶
ok(DEFAULT_QUOTA_PLUGIN_ID === 'dsh-motor-ai-full', 'DEFAULT_QUOTA_PLUGIN_ID = dsh-motor-ai-full')

server.close()
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
