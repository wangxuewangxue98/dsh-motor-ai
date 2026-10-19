/**
 * P1-B 完整版线上端到端：完整版配置打线上 receiver issue-resolved，核对 mirror 落盘
 */
import fs from 'node:fs'
import path from 'node:path'

const { submitResolvedCase } = await import('./lib/issue-resolved.mjs')

const REMOTE = 'https://dsh-motor-ai-receiver.wangxuewangxue98.deno.net/api/dsh/issue-resolved'
const cfg = { issueResolvedEnabled: true, issueResolvedEndpoint: REMOTE }

const marker = `e2e-full-${Date.now()}`
const r = await submitResolvedCase(cfg, {
  category: 'workflow',
  symptom: `完整版回流联调用例 ${marker}`,
  root_cause: '联调验证：完整版 submit_resolved_case → receiver → mirror 链路',
  remediation: '无需修复',
  resolution_process: '提交 → 200 → mirror 落盘核对',
  severity: 'low',
  tags: ['e2e', 'p1-b', 'full'],
})
console.log('提交结果:', JSON.stringify(r))

// 扇出为异步，轮询等待落盘（最多 20s）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mirrorRoot = 'D:/dsh-motor-ai-receiver-deno/p15v_mirror'
let found = null
for (let i = 0; i < 10 && !found; i++) {
  await sleep(2000)
  const days = fs.readdirSync(mirrorRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  for (const day of days.slice(-2)) {
    const fp = path.join(mirrorRoot, day, '_api_dsh_issue-resolved.jsonl')
    if (!fs.existsSync(fp)) continue
    for (const line of fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean)) {
      try {
        const rec = JSON.parse(line)
        if (JSON.stringify(rec).includes(marker)) { found = rec; break }
      } catch { /* 坏行跳过 */ }
    }
    if (found) break
  }
  if (found) console.log(`(第 ${i + 1} 轮命中)`)
}
if (found) {
  console.log('✅ mirror 落盘命中:')
  console.log('   plugin =', found.plugin, '| kind =', found.kind, '| version =', found.plugin_version)
  console.log('   symptom =', found.symptom)
  console.log('   身份字段检查: email/abs_path/api_key =', found.email, found.abs_path, found.api_key, '（应均为 undefined）')
  process.exit(0)
} else {
  console.log('❌ mirror 未命中（提交结果:', JSON.stringify(r), '）')
  process.exit(1)
}
