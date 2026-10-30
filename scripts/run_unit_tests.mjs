#!/usr/bin/env node
/**
 * 单元测试 runner（v1.2.3）
 * ---------------------------------------------------------------------------
 * 为什么需要它：`npm test` 原先直接调 jest，但本仓 13 个 `tests/*.test.mjs` 是
 * **脚本式门禁**（自带 console 汇总 + 失败时 `process.exit(1)`），不是 jest 风格
 * （无 describe/it/expect）。jest 跑它们必然崩：worker 遇到 process.exit 直接
 * "Jest worker encountered 4 child process exceptions" ⇒ 13 suites 全 failed、0 tests。
 * 而逐个 `node tests/xxx.test.mjs` 直跑是**全绿**的（32/32、16/16、22/22、21/21…）。
 *
 * 本 runner 只做「逐个 spawn + 汇总退出码」，不改造任何测试文件（零回归）：
 *   - 每个文件独立进程（隔离 process.exit 与全局状态）
 *   - 汇总 passed/failed 文件数与总退出码
 *   - 支持 `node scripts/run_unit_tests.mjs <关键字>` 过滤
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const testsDir = join(here, '..', 'tests')
const filter = process.argv[2] ?? ''

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !filter || f.includes(filter))
  .sort()

if (!files.length) {
  console.error(`没有匹配的测试文件（filter=${filter || '(空)'}）`)
  process.exit(1)
}

let passFiles = 0
const failed = []
for (const f of files) {
  const r = spawnSync(process.execPath, [join(testsDir, f)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const tail = out.trim().split('\n').slice(-1)[0] ?? ''
  if (r.status === 0) {
    passFiles += 1
    console.log(`✅ ${f} — ${tail.slice(0, 120)}`)
  } else {
    failed.push(f)
    console.log(`❌ ${f} — exit=${r.status}`)
    // 失败时才回吐尾部输出，便于定位（成功时静默，避免刷屏）
    console.log(out.trim().split('\n').slice(-12).map((l) => `    ${l}`).join('\n'))
  }
}

console.log(`\n══ 单元测试：${passFiles} 个文件通过 / ${failed.length} 个失败（共 ${files.length}）══`)
if (failed.length) {
  console.log('失败文件：', failed.join(', '))
  process.exit(1)
}
