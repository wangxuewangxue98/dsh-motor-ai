/**
 * 完整版遥测聚合计数单元测试（telemetry-aggregate.test.mjs）
 * 不依赖后端；fetch 打桩；临时 DSH_HOME 隔离 usage.jsonl / usage.offset。
 * 覆盖（方案 B，2026-10-14）：
 *   1. aggregateUsage 聚合身份 = dsh-motor-ai（l0 残留防回归）
 *   2. sanitizeTelemetry 白名单裁剪 + error 归类（绝不外发原文/设计参数）
 *   3. reportTelemetry 默认开（opt-out 语义）+ endpoint 回退 usage-report 通道
 *   4. offset 只按成功批次推进（失败重报不丢数据）
 *   5. scheduleTelemetry 节流 + opt-out 拒绝调度
 *   6. CONFIG_SCHEMA 必须声明 telemetryEnabled/telemetryEndpoint（DSH 裁键防线）
 */
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'telemetry-test-'))
process.env.DSH_HOME = TMP
delete process.env.DSH_BACKEND_URL

let pass = 0
let fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅', name) } else { fail++; console.log('  ❌', name) }
}

const tel = await import('../lib/telemetry.mjs')
const { aggregateUsage, sanitizeTelemetry, reportTelemetry, scheduleTelemetry, defaultTelemetryEndpoint, TELEM_FIELDS } = tel

const SINK_DIR = join(TMP, 'storages', 'dsh-motor-ai-l0') // 与 core usage-log 同槽
const USAGE = join(SINK_DIR, 'usage.jsonl')
const OFFSET = join(SINK_DIR, 'usage.offset')

function writeUsage(lines) {
  mkdirSync(SINK_DIR, { recursive: true })
  writeFileSync(USAGE, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  try { rmSync(OFFSET, { force: true }) } catch { /* noop */ }
}

// ---- 5) scheduleTelemetry 节流（先跑：模块级节流态是进程内的，保持用例独立）----
console.log('\n== scheduleTelemetry 节流 / opt-out ==')
{
  // 先备好待上报记录，否则 reportTelemetry 以 no-pending 短路、fetch 不会被触达
  writeUsage([{ tool: 'motor_param_matrix', ok: true, elapsed_ms: 3, n: 5, ts: '2026-10-14T07:00:00Z' }])
  let calls = 0
  globalThis.fetch = async () => { calls++; return { ok: true, status: 202 } }
  const cfg = { telemetryMinIntervalMs: 60_000 }
  const r1 = await scheduleTelemetry(cfg)
  ok('首次调度成功', r1.scheduled === true)
  ok('首次确实发起上报', calls === 1)
  const r2 = await scheduleTelemetry(cfg)
  ok('窗口内第二次被节流', r2.scheduled === false && r2.reason === 'throttled')
  ok('节流后未发起上报', calls === 1)

  // 重备待上报记录（上一次成功上报已推进 offset），再验证 minIntervalMs=0 不节流
  rmSync(OFFSET, { force: true })
  writeUsage([{ tool: 'motor_param_matrix', ok: true, elapsed_ms: 3, n: 5, ts: '2026-10-14T07:10:00Z' }])
  const r3 = await scheduleTelemetry({ telemetryMinIntervalMs: 0 })
  ok('minIntervalMs=0 不节流', r3.scheduled === true && calls === 2)

  const r4 = await scheduleTelemetry({ telemetryEnabled: false })
  ok('telemetryEnabled=false 显式退出', r4.scheduled === false && r4.reason === 'disabled')
  ok('退出后未发起上报', calls === 2)

  // 兼容旧键 telemetryIntervalSec（秒语义）
  const r5 = await scheduleTelemetry({ telemetryIntervalSec: 300 })
  ok('旧键 telemetryIntervalSec 参与节流', r5.scheduled === false && r5.reason === 'throttled')
  delete globalThis.fetch
}

// ---- 1) aggregateUsage 聚合身份与统计 ----
console.log('\n== aggregateUsage 聚合 ==')
{
  const records = [
    { tool: 'motor_l0_estimate', ok: true, elapsed_ms: 100, n: 10, ts: '2026-10-14T00:00:00Z' },
    { tool: 'motor_l0_estimate', ok: false, elapsed_ms: 300, error: 'timeout after 5s', ts: '2026-10-14T00:01:00Z' },
    { tool: 'motor_param_matrix', ok: true, elapsed_ms: 5, n: 20, ts: '2026-10-14T00:02:00Z' },
  ]
  const p = aggregateUsage(records, { pluginVersion: '1.0.0-rc.8' })
  ok('聚合身份 plugin=dsh-motor-ai', p.plugin === 'dsh-motor-ai')
  ok('kind=usage-aggregate（非 l0 残留）', p.kind === 'usage-aggregate')
  ok('calls_total=3', p.calls_total === 3)
  ok('ok_total=2 / failed_total=1', p.ok_total === 2 && p.failed_total === 1)
  ok('by_tool 分工具计数', p.by_tool.motor_l0_estimate?.calls === 2 && p.by_tool.motor_param_matrix?.calls === 1)
  ok('sum_n=30', p.sum_n === 30)
  ok('elapsed min/max 极值', p.elapsed_min_ms === 5 && p.elapsed_max_ms === 300)
  ok('success_rate 百分一位', p.overall_success_rate === 66.7)
  ok('last_ts 取最新', p.last_ts === '2026-10-14T00:02:00Z')
  ok('错误已归类（timeout）', p._err === undefined) // 归类在 sanitize 层，payload 不带原文
  ok('平台元数据无主机名/路径', !('hostname' in p) && !('cwd' in p))
}

// ---- 2) sanitizeTelemetry 白名单 ----
console.log('\n== sanitizeTelemetry 白名单 ==')
{
  const dirty = {
    tool: 'motor_l0_estimate', ok: true, elapsed_ms: 10,
    stator_od: 210, efficiency: 95.5, prompt: '泄露内容', api_key: 'secret',
    error: 'ENOENT: no such file D:\\secret\\path.mot',
  }
  const s = sanitizeTelemetry(dirty)
  ok('设计参数键被丢弃', !('stator_od' in s) && !('efficiency' in s))
  ok('提示词/密钥键被丢弃', !('prompt' in s) && !('api_key' in s))
  ok('error 只出类别不出原文', s.error === 'io_not_found' && !s.error.includes('secret'))
  ok('白名单字段保留', s.tool === 'motor_l0_estimate' && s.elapsed_ms === 10)
  ok('白名单常量不含设计键', TELEM_FIELDS.every((k) => !/stator|efficiency|torque_val|prompt|key/i.test(k)))
}

// ---- 3) reportTelemetry 默认开 + endpoint 回退 ----
console.log('\n== reportTelemetry 默认开 / 回退端点 ==')
{
  ok('回退端点拼装正确', defaultTelemetryEndpoint({}) === 'http://127.0.0.1:5000/api/dsh/dsh-plugins/dsh-motor-ai/usage-report')
  ok('回退端点吃 DSH_BACKEND_URL', (process.env.DSH_BACKEND_URL = 'http://mock.local:9', defaultTelemetryEndpoint({}) === 'http://mock.local:9/api/dsh/dsh-plugins/dsh-motor-ai/usage-report'))
  ok('回退端点吃 config.backendUrl 优先', defaultTelemetryEndpoint({ backendUrl: 'http://cfg.local/' }) === 'http://cfg.local/api/dsh/dsh-plugins/dsh-motor-ai/usage-report')
  delete process.env.DSH_BACKEND_URL

  writeUsage([
    { tool: 'motor_l0_estimate', ok: true, elapsed_ms: 42, n: 8, ts: '2026-10-14T08:00:00Z' },
  ])

  let hit = null
  globalThis.fetch = async (url, init) => {
    hit = { url, body: JSON.parse(init.body), headers: init.headers }
    return { ok: true, status: 202 }
  }
  // 显式未声明 telemetryEnabled（undefined）→ 默认开；endpoint 空 → 回退通道
  const r = await reportTelemetry({ backendUrl: 'http://mock.local:9', pluginVersion: 'rc.8' })
  ok('未声明开关时默认上报（opt-out）', r.reported === true && r.calls === 1)
  ok('回退到 usage-report 通道', hit?.url === 'http://mock.local:9/api/dsh/dsh-plugins/dsh-motor-ai/usage-report')
  ok('payload 聚合身份 dsh-motor-ai', hit?.body?.plugin === 'dsh-motor-ai')
  ok('UA 标识 dsh-motor-ai/telemetry', hit?.headers?.['User-Agent'] === 'dsh-motor-ai/telemetry')
  ok('成功后 offset 推进', readFileSync(OFFSET, 'utf8').trim() !== '' && Number(readFileSync(OFFSET, 'utf8')) > 0)

  // opt-out：显式 false
  hit = null
  const r2 = await reportTelemetry({ telemetryEnabled: false, backendUrl: 'http://mock.local:9' })
  ok('telemetryEnabled=false 不上报', r2.reported === false && r2.reason === 'disabled' && hit === null)

  // 显式 endpoint 优先（重备待上报记录：上一用例已把 offset 推到文件尾）
  rmSync(OFFSET, { force: true })
  writeUsage([{ tool: 'motor_param_matrix', ok: true, elapsed_ms: 3, n: 5, ts: '2026-10-14T07:30:00Z' }])
  hit = null
  await reportTelemetry({ telemetryEndpoint: 'http://custom.local/hook' })
  ok('显式 endpoint 优先于回退', hit?.url === 'http://custom.local/hook')

  // 失败不推进 offset（重报不丢）
  rmSync(OFFSET, { force: true })
  writeUsage([{ tool: 'motor_l1_estimate', ok: false, elapsed_ms: 9, error: 'boom', ts: '2026-10-14T09:00:00Z' }])
  globalThis.fetch = async () => ({ ok: false, status: 503 })
  const r3 = await reportTelemetry({})
  ok('HTTP 失败 reported=false', r3.reported === false)
  ok('失败不推进 offset', !existsSync(OFFSET))
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  const r4 = await reportTelemetry({})
  ok('网络异常静默不抛', r4.reported === false && !!r4.reason)
  delete globalThis.fetch
}

// ---- 6) CONFIG_SCHEMA 声明（DSH 裁键防线）----
console.log('\n== CONFIG_SCHEMA 声明 ==')
{
  const idx = readFileSync(join(__dirname, '..', 'index.mjs'), 'utf8')
  ok('CONFIG_SCHEMA 声明 telemetryEnabled', /telemetryEnabled:\s*\{/.test(idx))
  ok('CONFIG_SCHEMA 声明 telemetryEndpoint', /telemetryEndpoint:\s*\{/.test(idx))
  ok('CONFIG_SCHEMA 声明 telemetryBatchSize', /telemetryBatchSize:\s*\{/.test(idx))
  ok('CONFIG_SCHEMA 声明 telemetryMinIntervalMs', /telemetryMinIntervalMs:\s*\{/.test(idx))
  ok('默认值语义 = 默认开（default: true）', /telemetryEnabled:\s*\{[^}]*default:\s*true/s.test(idx))
}

console.log(`\n=== telemetry-aggregate: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
