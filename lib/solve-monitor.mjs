/**
 * 解算过程轮询监视器（v1.2.5 solve-monitor）
 * ===========================================================
 * 需求（2026-11-02，源自 300kW L2 鳍片扫描实战）：
 *   L1(RMxprt)/L2(Motor-CAD) 求解是 spawn 子进程长任务，旧实现 = 硬超时一刀切：
 *   运行期黑盒、无法区分「慢解 / 挂死 / 许可冲突 / 模态框阻塞」，超时即杀且故障不分型。
 *
 * 本模块提供：
 *   1. monitorBridgeChild(child, opts) —— 对 bridge 子进程做「硬超时 + 心跳超时」双监视：
 *      - 任何 stdout/stderr 输出都刷新心跳；stdout 中 ev=progress 的 JSONL 行
 *        （bridge 心跳线程每 30s 发）额外作为进度事件上报。
 *      - 硬超时（hardTimeoutMs）语义与旧版完全一致（到点 SIGKILL + reason:'timeout'）。
 *      - 心跳超时（heartbeatTimeoutMs）：无任何输出超过阈值 ⇒ reason:'heartbeat_stale'
 *        （挂死/模态框阻塞特征），附最后 stage 与 stale 时长。
 *      - stdout 解析兼容旧协议：结果恒取「最后一个非空行」的 JSON——心跳行在结果行
 *        之前，旧消费方（取最后一行）不受影响；本模块逐行解析可同时收进度。
 *   2. classifyStderrMessage(text) —— stderr 关键词故障分类：
 *      license_conflict（加密狗/许可）/ com_error（COM 调用失败）/ pywin32_missing。
 *   3. reason 集合：timeout / heartbeat_stale / no_output / bad_json /
 *      python_unavailable / bridge_missing（前三者为既有语义，全部保留）。
 *
 * 兼容性承诺（不破坏任何既有门禁）：
 *   - 上层（motorcad-verify.mjs / rmxprt-solve.mjs）对 err.reason 的分支集合不变；
 *   - bridge 心跳线程默认开启但只新增 stdout 行，旧解析（最后一行）天然兼容；
 *   - opts.heartbeatTimeoutMs 传 0 / 不传且未显式配置时自动回落 = hardTimeoutMs
 *     （即禁用心跳检测，行为退化为旧版纯硬超时）。
 */

/** stderr 关键词 → 故障细分类（FBK-20261102-002/003 实测经验固化） */
const STDERR_CLASSIFIERS = [
  { cls: 'license_conflict', re: /already accessing dongle|licence|license|加密狗|许可/i },
  { cls: 'com_error', re: /pywintypes|com_error|(-214\d{6})|AttributeError\.COMError/i },
  { cls: 'pywin32_missing', re: /No module named ['"]?win32com|ImportError.*pythoncom/i },
]

/**
 * stderr 关键词故障分类。
 * @param {string} text
 * @returns {'license_conflict'|'com_error'|'pywin32_missing'|null}
 */
export function classifyStderrMessage(text) {
  const s = String(text || '')
  for (const { cls, re } of STDERR_CLASSIFIERS) {
    if (re.test(s)) return cls
  }
  return null
}

/**
 * 解析 bridge stdout 多行输出：分离 ev=progress 心跳行与最终结果行。
 * @param {string} out 累积的 stdout 文本
 * @returns {{ resultLine: string|null, progressEvents: object[], progressRaw: string[] }}
 */
export function parseBridgeStdoutLines(out) {
  const lines = String(out || '').split(/\r?\n/).filter((l) => l.trim())
  const progressEvents = []
  let resultLine = null
  for (const line of lines) {
    let obj = null
    try { obj = JSON.parse(line) } catch { obj = null }
    if (obj && obj.ev === 'progress') {
      progressEvents.push(obj)
    } else {
      resultLine = line // 非心跳行：以最后一行为准（旧协议单行输出天然兼容）
    }
  }
  return { resultLine, progressEvents }
}

/**
 * 监视 bridge 子进程直至退出（硬超时 + 心跳超时双监视）。
 * @param {import('node:child_process').ChildProcess} child spawn 返回的子进程（stdio 须为 pipe）
 * @param {object} [opts]
 * @param {number}   [opts.hardTimeoutMs=600000]    硬超时（到点 SIGKILL，reason:'timeout'）
 * @param {number}   [opts.heartbeatTimeoutMs]      心跳超时（无任何输出判挂死，reason:'heartbeat_stale'）；
 *                                                  0/undefined ⇒ 回落 hardTimeoutMs（禁用心跳检测，兼容旧行为）
 * @param {string}   [opts.label='bridge']          日志标签
 * @param {(ev: object) => void} [opts.onProgress]  收到 ev=progress 心跳行时回调
 * @returns {Promise<{body: object, exitCode: number, stderr: string,
 *                     progressEvents: object[], elapsedMs: number}>}
 */
export function monitorBridgeChild(child, opts = {}) {
  const hardTimeoutMs = Number(opts.hardTimeoutMs || 600000)
  const heartbeatTimeoutMs = (opts.heartbeatTimeoutMs != null && Number(opts.heartbeatTimeoutMs) > 0)
    ? Number(opts.heartbeatTimeoutMs)
    : hardTimeoutMs // 兼容回落：未配置心跳 ⇒ 退化为纯硬超时
  const label = opts.label || 'bridge'
  const t0 = Date.now()

  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let done = false
    let lastActivity = Date.now()
    let lastStage = null
    let progressEvents = []
    let tailBuf = ''

    const fail = (errObj) => {
      if (done) return
      done = true
      clearTimeout(hardTimer)
      clearInterval(hbTimer)
      try { child.kill('SIGKILL') } catch { /* noop */ }
      // stderr 关键词细分类叠加（license/com/pywin32），供上层给针对性建议
      const cls = classifyStderrMessage(err)
      if (cls && !errObj.reason.startsWith('python_unavailable')) errObj.stderrClass = cls
      errObj.progressEvents = progressEvents
      errObj.lastStage = lastStage
      errObj.elapsedMs = Date.now() - t0
      reject(Object.assign(new Error(`[${label}] ${errObj.message}`), errObj))
    }

    // 硬超时（语义与旧版一致）
    const hardTimer = setTimeout(() => {
      fail({ reason: 'timeout', message: `求解超时（硬上限 ${hardTimeoutMs}ms）` })
    }, hardTimeoutMs)

    // 心跳轮询（1s tick；无任何 stdout/stderr 活动超过阈值 ⇒ 挂死/模态框阻塞特征）
    const hbTimer = setInterval(() => {
      if (done) return
      const staleMs = Date.now() - lastActivity
      if (staleMs > heartbeatTimeoutMs) {
        fail({
          reason: 'heartbeat_stale',
          message: `解算过程无输出已 ${Math.round(staleMs / 1000)}s（阈值 ${Math.round(heartbeatTimeoutMs / 1000)}s，最后阶段=${lastStage || 'n/a'}）——疑似挂死或被模态框阻塞`,
          staleMs,
        })
      }
    }, 1000)

    child.stdout.on('data', (d) => {
      lastActivity = Date.now()
      tailBuf += d.toString('utf8')
      const lines = tailBuf.split(/\r?\n/)
      tailBuf = lines.pop() || '' // 半行留回
      for (const line of lines) {
        if (!line.trim()) continue
        let obj = null
        try { obj = JSON.parse(line) } catch { obj = null }
        if (obj && obj.ev === 'progress') {
          progressEvents.push(obj)
          lastStage = obj.stage ?? lastStage
          try { opts.onProgress?.(obj) } catch { /* 回调异常不影响主流程 */ }
        } else {
          out += (out && !out.endsWith('\n') ? '\n' : '') + line + '\n'
        }
      }
      if (tailBuf.trim()) {
        // 半行不解析；整个 close 时 parseBridgeStdoutLines 兜底
      }
    })
    child.stderr.on('data', (d) => {
      lastActivity = Date.now() // stderr 活动（L1 pyaedt 日志流）同样视作活着
      err += d.toString('utf8')
    })

    child.on('error', (e) => {
      fail({ reason: 'python_unavailable', message: `无法启动 Python 子进程: ${e.message}` })
    })

    child.on('close', (code) => {
      if (done) return
      // 半行兜底：把 tailBuf 并入再统一解析（close 后不会再有数据）
      const all = out + tailBuf
      const { resultLine, progressEvents: allProgress } = parseBridgeStdoutLines(all)
      if (!resultLine) {
        // 注意：这里走 fail（fail 自带 done 幂等检查+清理），不可提前置 done 短路掉 reject
        fail({ reason: 'no_output', message: `bridge 无输出（exit=${code}）${err ? ' | ' + err.slice(-300) : ''}` })
        return
      }
      let body
      try { body = JSON.parse(resultLine) } catch {
        fail({ reason: 'bad_json', message: `bridge 输出非 JSON: ${resultLine.slice(0, 200)}` })
        return
      }
      done = true
      clearTimeout(hardTimer)
      clearInterval(hbTimer)
      resolve({
        body,
        exitCode: code,
        stderr: err,
        progressEvents: progressEvents.length >= allProgress.length ? progressEvents : allProgress,
        elapsedMs: Date.now() - t0,
      })
    })
  })
}

export default { monitorBridgeChild, classifyStderrMessage, parseBridgeStdoutLines }
