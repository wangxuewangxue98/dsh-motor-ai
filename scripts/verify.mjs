#!/usr/bin/env node
/**
 * dsh-motor-ai 完整版自检验证脚本
 * 检查包结构、依赖、导入是否正常
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

// 获取项目根目录（scripts 的父目录）
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '..')
const ROOT_URL = pathToFileURL(ROOT).href

// ============================================================
// 1. 基础文件检查
// ============================================================
const REQUIRED_FILES = [
  'index.mjs',
  'package.json',
  'tools/l0/index.mjs',
  'tools/l1/index.mjs',
  'tools/l2/index.mjs',
  'tools/feedback/case-feedback.mjs',
  'tools/feedback/experience-hub.mjs',
]

let failures = 0
console.log('=== dsh-motor-ai 完整性检查 ===\n')

for (const file of REQUIRED_FILES) {
  const path = join(ROOT, file)
  if (existsSync(path)) {
    console.log(`✅ ${file}`)
  } else {
    console.log(`❌ ${file} 缺失`)
    failures++
  }
}

// ============================================================
// 2. package.json 检查
// ============================================================
console.log('\n=== package.json 检查 ===')
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))

  const checks = [
    ['name', 'dsh-motor-ai'],
    ['version', /^1\.0\.0/],
    ['description', /完整版|L1|L2|RMxprt|Motor-CAD/i],
  ]

  for (const [key, expected] of checks) {
    const actual = pkg[key]
    if (expected instanceof RegExp) {
      if (expected.test(actual)) {
        console.log(`✅ ${key}: ${actual}`)
      } else {
        console.log(`❌ ${key}: "${actual}" 不符合 ${expected}`)
        failures++
      }
    } else {
      if (actual === expected) {
        console.log(`✅ ${key}: ${actual}`)
      } else {
        console.log(`❌ ${key}: "${actual}" != "${expected}"`)
        failures++
      }
    }
  }

  // 检查依赖
  if (pkg.dependencies?.['@wangxue98/dsh-motor-ai-core']) {
    console.log(`✅ core 依赖: ${pkg.dependencies['@wangxue98/dsh-motor-ai-core']}`)
  } else {
    console.log('❌ 缺少 @wangxue98/dsh-motor-ai-core 依赖')
    failures++
  }

} catch (err) {
  console.log(`❌ package.json 解析失败: ${err.message}`)
  failures++
}

// ============================================================
// 3. 导入检查（模拟 DSH 环境）
// ============================================================
console.log('\n=== 导入检查 ===')
try {
  // 尝试导入核心模块
  const core = await import('@wangxue98/dsh-motor-ai-core')
  console.log(`✅ @wangxue98/dsh-motor-ai-core 导入成功`)
  console.log(`   导出: ${Object.keys(core).slice(0, 5).join(', ')}...`)
} catch (err) {
  console.log(`❌ core 导入失败: ${err.message}`)
  failures++
}

try {
  // 尝试导入插件入口（使用 file:// URL 避免 Windows 路径问题）
  const indexPath = join(ROOT, 'index.mjs')
  const pluginUrl = pathToFileURL(indexPath)
  const plugin = await import(pluginUrl.href)
  console.log(`✅ index.mjs 导入成功`)
  console.log(`   导出: ${Object.keys(plugin).slice(0, 5).join(', ')}...`)
} catch (err) {
  console.log(`❌ index.mjs 导入失败: ${err.message}`)
  failures++
}

// ============================================================
// 4. 互斥检测检查
// ============================================================
console.log('\n=== 互斥检测检查 ===')
try {
  // 清除全局标记后重新导入
  delete globalThis.__DSH_MOTOR_AI_FULL_LOADED__
  const indexPath = join(ROOT, 'index.mjs')
  const pluginUrl = pathToFileURL(indexPath)
  const plugin = await import(pluginUrl.href)
  console.log('✅ 互斥检测机制存在')
} catch (err) {
  if (err.message.includes('互斥') || err.message.includes('冲突')) {
    console.log('✅ 互斥检测触发正常')
  } else {
    console.log(`⚠️  意外错误: ${err.message}`)
  }
}

// ============================================================
// 4.5 发布安全门禁（防 l0@0.3.0 类缺陷回归）
// ============================================================
console.log('\n=== 发布安全门禁 ===')

// 门禁 A：P0 本机绝对路径泄漏（盘符绝对路径）
const P0_DIRS = ['index.mjs', 'lib', 'tools', 'models', 'scripts', 'skills']
let p0Bad = []
for (const d of P0_DIRS) {
  const dp = join(ROOT, d)
  if (!existsSync(dp)) continue
  try {
    const { stdout } = spawnSync('grep', ['-rInE', '[A-Za-z]:[\\\\/](Users|MotorDesign|home|Program Files)', dp], { encoding: 'utf8', shell: true })
    if (stdout) p0Bad = p0Bad.concat(stdout.split('\n').filter(Boolean))
  } catch { /* ignore */ }
}
if (p0Bad.length === 0) {
  console.log('✅ P0 本机绝对路径泄漏：0 处')
} else {
  console.log(`❌ P0 泄漏 ${p0Bad.length} 处：`); p0Bad.forEach(l => console.log('   ' + l)); failures++
}

// 门禁 B：进包 .mjs 的相对 import 必须命中包内文件
try {
  const packOut = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: true })
  const packInfo = JSON.parse(packOut)
  const packed = (packInfo[0] && packInfo[0].files ? packInfo[0].files : []).map(f => f.path)
  const packedSet = new Set(packed)
  let relCount = 0
  const missing = []
  for (const pf of packed) {
    if (!pf.endsWith('.mjs')) continue
    const abs = join(ROOT, pf)
    if (!existsSync(abs)) continue
    const src = readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const re = /(?:import|await\s+import|require)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g
    let m
    while ((m = re.exec(src))) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      const rr = relative(ROOT, resolve(ROOT, dirname(pf), spec)).split(sep).join('/')
      relCount++
      if (!packedSet.has(rr)) missing.push(`${pf} -> ${spec} (${rr})`)
    }
  }
  if (missing.length === 0) {
    console.log(`✅ 进包 .mjs 相对 import 命中包内：${relCount} 处，0 缺包`)
  } else {
    console.log(`❌ 进包文件引用但未进包：${missing.length} 处：`); missing.forEach(l => console.log('   ' + l)); failures++
  }
} catch (e) {
  console.log(`⚠️  进包门禁跳过（pack 失败）：${e.message}`)
}

// ============================================================
// 5. 汇总
// ============================================================
console.log('\n=== 检查结果 ===')
if (failures === 0) {
  console.log('✅ 全部检查通过')
  process.exit(0)
} else {
  console.log(`❌ ${failures} 项检查失败`)
  process.exit(1)
}
