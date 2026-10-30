/**
 * experience-feedback 通道单元测试（tests/experience-feedback.test.mjs）
 * 独立 node 脚本风格（与 tests/ 既有约定一致）：node tests/experience-feedback.test.mjs
 * 不依赖后端；submit 用例通过替换 global.fetch 捕获 POST，离线全覆盖。
 */
import assert from 'node:assert/strict'

let pass = 0
let fail = 0
function ok(name, fn) {
  try {
    fn()
    pass++
    console.log('  ✅', name)
  } catch (err) {
    fail++
    console.log('  ❌', name, '→', err.message)
  }
}
async function okAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log('  ✅', name)
  } catch (err) {
    fail++
    console.log('  ❌', name, '→', err.message)
  }
}

const fb = await import('../lib/experience-feedback.mjs')
const tool = await import('../tools/experience-feedback-tool.mjs')

const GOOD = {
  title: '变频供电下铜损需按绕组实际温度修正',
  body: '热分析时若绕组温度沿用室温，铜损会被低估；应在热结果上迭代修正电阻率后再复核效率。',
  category: 'thermal',
  related_tool: 'motor_l2_validate',
  severity: 'high',
  tags: ['铜损', '温度'],
  source_ref: 'Motor-CAD 培训 第五讲·热分析',
}

// ---------- 1. 白名单裁剪 + 黑名单 + rec_id ----------
ok('1. 白名单裁剪：意外混入键被丢弃（不发不报）', async () => {
  let captured = null
  const origFetch = globalThis.fetch
  globalThis.fetch = async (_u, init) => { captured = JSON.parse(init.body); return { ok: true, status: 200 } }
  try {
    const res = await fb.submitExperienceFeedback(
      { experienceFeedbackEnabled: true, commerceBackendUrl: 'https://receiver.example' },
      { ...GOOD, client_id: 'leak', cwd: 'D:\\x', stator_od: 425 },
    )
    assert.equal(res.submitted, true)
    assert.ok(!('client_id' in captured), 'client_id 不应出现在请求体')
    assert.ok(!('cwd' in captured), 'cwd 不应出现在请求体')
    assert.ok(!('stator_od' in captured), 'stator_od 不应出现在请求体')
    assert.equal(captured.kind, 'l0-experience-feedback')
    assert.equal(captured.plugin, 'dsh-motor-ai-full')
    assert.match(captured.rec_id, /^[0-9a-f]{12}$/)
  } finally { globalThis.fetch = origFetch }
})

ok('2. rec_id 幂等：同内容恒等、异内容不同', () => {
  const a = fb.feedbackRecIdOf(GOOD)
  const b = fb.feedbackRecIdOf({ ...GOOD })
  const c = fb.feedbackRecIdOf({ ...GOOD, title: '改一个字' })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

// ---------- 2. 门禁与端点 ----------
await okAsync('3. opt-in 门：默认关 → disabled（不发网络）', async () => {
  let called = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => { called++; return { ok: true, status: 200 } }
  try {
    const res = await fb.submitExperienceFeedback({}, GOOD)
    assert.equal(res.submitted, false)
    assert.equal(res.reason, 'disabled')
    const res2 = await fb.submitExperienceFeedback({ experienceFeedbackEnabled: false }, GOOD)
    assert.equal(res2.reason, 'disabled')
    assert.equal(called, 0)
  } finally { globalThis.fetch = origFetch }
})

ok('4. 端点解析：显式 > backend 派生 > 空', () => {
  assert.equal(fb.resolveFeedbackEndpoint({ experienceFeedbackEndpoint: 'https://a/b' }), 'https://a/b')
  assert.equal(
    fb.resolveFeedbackEndpoint({ commerceBackendUrl: 'https://r.x/' }),
    'https://r.x/api/dsh/experience-feedback',
  )
  assert.equal(fb.resolveFeedbackEndpoint({}), '')
})

// ---------- 3. 脱敏四道闸 ----------
for (const [rid, payload] of [
  ['S01', { ...GOOD, body: '核心长度 core_length=425mm 时…' }],
  ['S05', { ...GOOD, body: '估算 efficiency=93.7 时…' }],
  ['S06', { ...GOOD, body: '客户:某某电机厂…' }],
  ['S07', { ...GOOD, body: '见 D:\\MotorDesign\\proj\\a.prm' }],
  ['S10', { ...GOOD, body: '联系 test@example.com' }],
]) {
  await okAsync(`5. 内容级脱敏 ${rid}：命中即拒（sensitive:*）`, async () => {
    const res = await fb.submitExperienceFeedback(
      { experienceFeedbackEnabled: true, commerceBackendUrl: 'https://r.x' }, payload,
    )
    assert.equal(res.submitted, false)
    assert.ok(String(res.reason).startsWith('sensitive:'), 'reason 应为 sensitive:*，实为 ' + res.reason)
  })
}

await okAsync('6. 黑名单键即拒（forbidden-field:*）', async () => {
  const res = await fb.submitExperienceFeedback(
    { experienceFeedbackEnabled: true, commerceBackendUrl: 'https://r.x' },
    { ...GOOD, client_id: 'x' },
  )
  assert.equal(res.submitted, false)
  assert.equal(res.reason, 'forbidden-field:client_id')
})

await okAsync('7. 必填：title/body 空 → empty-content', async () => {
  const res = await fb.submitExperienceFeedback(
    { experienceFeedbackEnabled: true, commerceBackendUrl: 'https://r.x' }, { title: 't' },
  )
  assert.equal(res.reason, 'empty-content')
})

// ---------- 4. HTTP 失败路径（fire-and-forget 语义） ----------
await okAsync('8. HTTP 500 → submitted:false（不抛异常）', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500 })
  try {
    const res = await fb.submitExperienceFeedback(
      { experienceFeedbackEnabled: true, commerceBackendUrl: 'https://r.x' }, GOOD,
    )
    assert.equal(res.submitted, false)
    assert.equal(res.reason, 'http_500')
  } finally { globalThis.fetch = origFetch }
})

// ---------- 5. 工具层 ----------
await okAsync('9. 工具层：gate 关 → status=skipped + 开关指引', async () => {
  const out = await tool.runSubmitExperienceFeedback(GOOD, {})
  assert.equal(out.status, 'skipped')
  assert.ok(out.message.includes('experienceFeedbackEnabled'), '提示应含开关名')
})

await okAsync('10. 工具层：开启 + 捕获 fetch → status=submitted', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.title, GOOD.title)
    return { ok: true, status: 200 }
  }
  try {
    const out = await tool.runSubmitExperienceFeedback(
      GOOD, { experienceFeedbackEnabled: true, commerceBackendUrl: 'https://r.x' },
    )
    assert.equal(out.status, 'submitted')
    assert.match(out.rec_id, /^[0-9a-f]{12}$/)
  } finally { globalThis.fetch = origFetch }
})

await okAsync('11. 工具层：脱敏拒 → 友好指引（不含原始 reason 前缀）', async () => {
  const out = await tool.runSubmitExperienceFeedback(
    { ...GOOD, body: '效率 efficiency=93.7' },
    { experienceFeedbackEnabled: true, commerceBackendUrl: 'https://r.x' },
  )
  assert.equal(out.status, 'error')
  assert.ok(out.message.includes('S05'), '提示应含规则 id')
  assert.ok(out.message.includes('脱敏'), '提示应引导脱敏')
})

ok('12. 工具名与注册导出齐全', () => {
  assert.equal(tool.EXPERIENCE_FEEDBACK_TOOL_NAME, 'motor_submit_experience')
  assert.equal(typeof tool.registerExperienceFeedbackTool, 'function')
  assert.ok(tool.TOOL_PARAMS.title && tool.TOOL_PARAMS.body)
})

// ---------- 汇总 ----------
console.log(`\n===== experience-feedback: ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
