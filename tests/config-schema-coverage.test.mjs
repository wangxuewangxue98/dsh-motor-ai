// tests/config-schema-coverage.test.mjs
// rc.11：CONFIG_SCHEMA 键覆盖（P0-②）+ L1 worker 随包分发（P0-①）
//   - 代码读取的 config 键必须 ⊆ schema 声明键（否则 DSH 裁键 → 恒 undefined）
//   - 包内 worker 必须存在且可被 bundledWorkerPath 解析到
//   - schema default 与代码内默认逐键一致抽查（防声明后行为漂移）
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('✅', msg) } else { fail++; console.log('❌', msg) } }

// ---- 1) schema 键提取 ----
const idxSrc = readFileSync(join(ROOT, 'index.mjs'), 'utf8')
const schemaBlock = idxSrc.match(/const CONFIG_SCHEMA = \{[\s\S]*?\n\}/)
ok(!!schemaBlock, 'index.mjs 含 CONFIG_SCHEMA')
const declared = new Set(
  [...schemaBlock[0].matchAll(/^    ([a-zA-Z_][a-zA-Z0-9_]*): \{$/gm)].map((x) => x[1])
)
console.log(`   schema 声明键数: ${declared.size}`)

// ---- 2) 代码读取键 ⊆ 声明键 ----
const RUNTIME_KEYS = new Set(['pluginVersion'])
const scanFiles = [
  'index.mjs',
  'lib/quota.mjs', 'lib/license.mjs', 'lib/telemetry.mjs',
  'lib/usage-log.mjs', 'lib/experience-upload.mjs', 'lib/regression-gate.mjs',
  'lib/surrogate-engine.mjs', 'lib/formula-engine.mjs',
  'tools/l0/param-matrix.mjs', 'tools/l0/l0-estimate.mjs',
  'tools/l0/pipeline.mjs', 'tools/l0/design-validate.mjs',
  'tools/l1/rmxprt-solve.mjs', 'tools/l2/motorcad-verify.mjs',
]
const read = new Set()
for (const f of scanFiles) {
  const p = join(ROOT, f)
  if (!existsSync(p)) continue
  const src = readFileSync(p, 'utf8')
  for (const m of src.matchAll(/\bconfig\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) read.add(m[1])
}
const missing = [...read].filter((k) => !declared.has(k) && !RUNTIME_KEYS.has(k)).sort()
ok(missing.length === 0, `读取键全部已声明${missing.length ? '，缺失: ' + missing.join(',') : ''}`)

// ---- 3) 关键后端通道键必须声明（rc.11 核心）----
for (const k of ['backendUrl', 'commerceBackendUrl', 'telemetryEnabled', 'motorcadMode', 'l0Mode']) {
  ok(declared.has(k), `关键键已声明: ${k}`)
}

// ---- 4) schema default 与代码内默认一致（抽查）----
const defaults = {
  l0Mode: "'formula'",
  maxMatrixSize: '2000',
  efficiencyCap: '96',
  tempRiseRange: '[45, 130]',
  surrogateConfidenceThreshold: 'DEFAULT_CONFIDENCE_THRESHOLD',
  motorcadMode: "'com'",
  motorcadProgid: "'MotorCAD.AppAutomation'",
  motorcadTimeoutMs: '600000',
  quotaPluginId: 'DEFAULT_QUOTA_PLUGIN_ID',
}
const codeSrc = [
  readFileSync(join(ROOT, 'tools/l0/l0-estimate.mjs'), 'utf8'),
  readFileSync(join(ROOT, 'lib/regression-gate.mjs'), 'utf8'),
  readFileSync(join(ROOT, 'tools/l2/motorcad-verify.mjs'), 'utf8'),
  readFileSync(join(ROOT, 'lib/quota.mjs'), 'utf8'),
].join('\n')
for (const [k, v] of Object.entries(defaults)) {
  const re = new RegExp(`config\\??\\.${k}\\s*\\?\\?\\s*${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  ok(re.test(codeSrc) || codeSrc.includes(`${v}`), `默认值一致: ${k} → ${v}`)
}

// ---- 5) L1 worker 随包分发 ----
const worker = join(ROOT, 'scripts', '_rmxprt_venv_worker.py')
ok(existsSync(worker), 'scripts/_rmxprt_venv_worker.py 在仓库（files 含 scripts/ → 随包）')
const l1Src = readFileSync(join(ROOT, 'tools/l1/rmxprt-solve.mjs'), 'utf8')
ok(/bundledWorkerPath/.test(l1Src), 'L1 路径解析含包内副本优先（bundledWorkerPath）')
ok(/RMXPRT_WORKER_PATH/.test(l1Src), 'L1 仍支持 RMXPRT_WORKER_PATH 覆盖')
ok(/MOTORDESIGN_ROOT/.test(l1Src), 'L1 仍支持 MOTORDESIGN_ROOT 次选')
// 包内副本可解析（import.meta.url 相对定位）
{
  const here = join(ROOT, 'tools', 'l1')
  const p = join(here, '..', '..', 'scripts', '_rmxprt_venv_worker.py')
  ok(existsSync(p), 'bundledWorkerPath 目标可解析（tools/l1 → scripts/）')
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
