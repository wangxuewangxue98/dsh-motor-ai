/**
 * solve-monitor 单元门禁（v1.2.5 解算过程轮询监视）
 * ===========================================================
 * 覆盖：
 *   ① parseBridgeStdoutLines：多行心跳+结果 / 旧协议单行 / 非法行
 *   ② classifyStderrMessage：许可冲突 / COM 错误 / pywin32 缺失 / 无关文本
 *   ③ monitorBridgeChild（EventEmitter 假 child，毫秒级，不真跑求解器）：
 *      - 正常完成：多行 stdout（心跳行+结果行）→ progressEvents 收集 + body 正确
 *      - 旧协议兼容：单行 stdout 无心跳 → 行为与旧 runBridge 一致
 *      - heartbeat_stale：静默 child 超短心跳阈值 → reason='heartbeat_stale'（不误判为 timeout）
 *      - 硬超时优先：hardTimeoutMs < heartbeatTimeoutMs 且静默 → reason='timeout'
 *      - stderr 分类：假 child 发 license 报错文本后挂死 → stderrClass='license_conflict'
 *   ④ 真 bridge ping 冒烟（环境可跑才执行，否则 SKIP）：stdout 最后一行恒为合法 JSON
 *      （心跳行不破坏「最后一行=结果」契约）
 * 失败即 process.exit(1)（脚本式门禁惯例）。
 */
import { EventEmitter } from 'node:events'
import {
  monitorBridgeChild,
  classifyStderrMessage,
  parseBridgeStdoutLines,
} from '../lib/solve-monitor.mjs'

let failed = 0
let skipped = 0
function must(cond, msg) {
  if (cond) { console.log(`  ✅ ${msg}`); return }
  failed++
  console.error(`  ❌ ${msg}`)
}
function skip(msg) { skipped++; console.log(`  ⏭️  SKIP: ${msg}`) }

/** 假 child：可编程 stdout/stderr 输出序列与静默 */
function fakeChild() {
  const c = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.kill = () => { c.killed = true; c.emit('close', null, 'SIGKILL') }
  return c
}

console.log('== ① parseBridgeStdoutLines ==')
{
  const multi = parseBridgeStdoutLines(
    '{"ev":"progress","stage":"connect"}\n{"ev":"progress","stage":"solve_emag"}\n{"ok":true,"x":1}\n')
  must(multi.progressEvents.length === 2
    && multi.progressEvents[1].stage === 'solve_emag',
  '多行输出：2 条 progress 全收集')
  must(multi.resultLine === '{"ok":true,"x":1}', '多行输出：结果行=最后非心跳行')

  const single = parseBridgeStdoutLines('{"ok":true,"y":2}\n')
  must(single.progressEvents.length === 0 && single.resultLine === '{"ok":true,"y":2}',
    '旧协议单行输出：零 progress、结果行正确（向后兼容）')

  const bad = parseBridgeStdoutLines('not-json\n{"ok":false}\n')
  must(bad.resultLine === '{"ok":false}', '非法行跳过不阻断')
}

console.log('== ② classifyStderrMessage ==')
{
  must(classifyStderrMessage('Motor-CAD already accessing dongle') === 'license_conflict',
    '许可冲突关键词 → license_conflict')
  must(classifyStderrMessage('pywintypes.com_error: (-2147023170') === 'com_error',
    'COM 异常关键词 → com_error')
  must(classifyStderrMessage("ImportError: No module named 'win32com'") === 'pywin32_missing',
    'pywin32 缺失 → pywin32_missing')
  must(classifyStderrMessage('all normal output') === null, '无关文本 → null')
}

console.log('== ③ monitorBridgeChild（假 child）==')
{
  // ③-1 正常完成：心跳行+结果行
  {
    const c = fakeChild()
    const p = monitorBridgeChild(c, { hardTimeoutMs: 5000, heartbeatTimeoutMs: 2000 })
    c.stdout.emit('data', Buffer.from('{"ev":"progress","stage":"connect"}\n', 'utf8'))
    c.stdout.emit('data', Buffer.from('{"ev":"progress","stage":"solve_emag"}\n', 'utf8'))
    c.stdout.emit('data', Buffer.from('{"ok":true,"emag":{"OutputPower":285000}}\n', 'utf8'))
    c.emit('close', 0)
    const r = await p
    must(r.body.ok === true && r.body.emag.OutputPower === 285000, '③-1 正常完成：body 正确')
    must(r.progressEvents.length === 2 && r.progressEvents[1].stage === 'solve_emag',
      '③-1 正常完成：progressEvents 收集 2 条')
    must(r.elapsedMs >= 0 && r.exitCode === 0, '③-1 正常完成：exitCode/elapsedMs 就位')
  }
  // ③-2 旧协议兼容：单行结果
  {
    const c = fakeChild()
    const p = monitorBridgeChild(c, { hardTimeoutMs: 5000, heartbeatTimeoutMs: 2000 })
    c.stdout.emit('data', Buffer.from('{"ok":true,"legacy":true}', 'utf8')) // 无换行
    c.emit('close', 0)
    const r = await p
    must(r.body.legacy === true, '③-2 旧协议（无换行单行）兼容')
  }
  // ③-3 heartbeat_stale：静默 child，心跳阈值 300ms（不被判成 timeout）
  {
    const c = fakeChild()
    const p = monitorBridgeChild(c, { hardTimeoutMs: 30000, heartbeatTimeoutMs: 300 })
    const t0 = Date.now()
    p.then(
      () => must(false, '③-3 静默 child 不应成功'),
      (e) => {
        must(e.reason === 'heartbeat_stale', `③-3 静默 child → heartbeat_stale（实得 ${e.reason}）`)
        must(e.staleMs >= 300, '③-3 staleMs 就位')
        must(Date.now() - t0 < 10000, '③-3 心跳判定远快于硬超时（不等到 30s）')
        must(c.killed === true, '③-3 判挂死后 SIGKILL 子进程')
      },
    )
    await p.catch(() => {})
  }
  // ③-4 硬超时优先：hardTimeout 更短且静默 → timeout（旧语义）
  {
    const c = fakeChild()
    const p = monitorBridgeChild(c, { hardTimeoutMs: 300, heartbeatTimeoutMs: 30000 })
    p.then(
      () => must(false, '③-4 超时 child 不应成功'),
      (e) => must(e.reason === 'timeout', `③-4 硬超时 → timeout（实得 ${e.reason}）`),
    )
    await p.catch(() => {})
  }
  // ③-5 stderr 许可冲突分类：先发许可报错再静默 → heartbeat_stale + stderrClass
  {
    const c = fakeChild()
    const p = monitorBridgeChild(c, { hardTimeoutMs: 30000, heartbeatTimeoutMs: 300 })
    c.stderr.emit('data', Buffer.from('Motor-CAD already accessing dongle', 'utf8'))
    p.then(
      () => must(false, '③-5 不应成功'),
      (e) => must(e.reason === 'heartbeat_stale' && e.stderrClass === 'license_conflict',
        `③-5 挂死+许可报错 → heartbeat_stale + stderrClass=license_conflict（实得 ${e.reason}/${e.stderrClass}）`),
    )
    await p.catch(() => {})
  }
  // ③-6 no_output：无任何输出即退出
  {
    const c = fakeChild()
    const p = monitorBridgeChild(c, { hardTimeoutMs: 5000, heartbeatTimeoutMs: 2000 })
    c.emit('close', 1)
    p.then(
      () => must(false, '③-6 不应成功'),
      (e) => must(e.reason === 'no_output', `③-6 无输出退出 → no_output（实得 ${e.reason}）`),
    )
    await p.catch(() => {})
  }
}

console.log('== ④ 真 bridge ping 冒烟（可选）==')
{
  const { spawn } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = fileURLToPath(new URL('.', import.meta.url))
  const bridge = join(here, '..', 'scripts', 'motorcad_bridge.py')
  must(existsSync(bridge), '④-0 bridge 脚本随包存在')
  // 找一个带 pywin32 的 python（嵌入环境优先），找不到则 SKIP（不装 MC 的机器也须全绿）
  const candidates = [
    process.env.MOTORCAD_PYTHON,
    'D:\\Python310_emb\\python310\\python.exe',
    'python',
  ].filter(Boolean)
  let py = null
  for (const c of candidates) {
    try {
      const { spawnSync } = await import('node:child_process')
      const chk = spawnSync(c, ['-c', 'import pythoncom, win32com.client'], { timeout: 20000 })
      if (chk.status === 0) { py = c; break }
    } catch { /* 下一个候选 */ }
  }
  if (!py) {
    skip('本机无带 pywin32 的 Python，跳过真 bridge 冒烟（单元断言已全过）')
  } else {
    const child = spawn(py, [bridge], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const p = monitorBridgeChild(child, { hardTimeoutMs: 60000, heartbeatTimeoutMs: 20000, label: 'ping-smoke' })
    child.stdin.write(JSON.stringify({ action: 'ping' }), 'utf8')
    child.stdin.end()
    try {
      const r = await p
      must(r.body && typeof r.body === 'object' && 'ok' in r.body,
        `④-1 真 bridge：最后一行恒为合法 JSON 结果（ok=${r.body?.ok}, reason=${r.body?.reason ?? '-'}）`)
      must(r.progressEvents.every((e) => e.ev === 'progress'), '④-2 心跳行全为 progress 事件形态')
    } catch (e) {
      // 无 MotorCAD 环境时 bridge 也必须输出合法结果行（如 motorcad_not_found），不应 no_output/bad_json
      must(e.reason !== 'no_output' && e.reason !== 'bad_json',
        `④-1 真 bridge（无 MC 环境）：仍输出合法结果行（reason=${e.reason}，可接受）`)
    }
  }
}

console.log('========================================')
if (failed > 0) {
  console.error(`❌ solve-monitor 门禁失败 ${failed} 项`)
  process.exit(1)
}
console.log(`✅ solve-monitor 门禁全过（skipped=${skipped}）`)
