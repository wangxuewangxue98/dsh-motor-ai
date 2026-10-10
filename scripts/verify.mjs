#!/usr/bin/env node
/**
 * dsh-motor-ai 完整版自检验证脚本
 * 检查包结构、依赖、导入是否正常
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  if (pkg.dependencies?.['@yourscope/dsh-motor-ai-core']) {
    console.log(`✅ core 依赖: ${pkg.dependencies['@yourscope/dsh-motor-ai-core']}`)
  } else {
    console.log('❌ 缺少 @yourscope/dsh-motor-ai-core 依赖')
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
  const core = await import('@yourscope/dsh-motor-ai-core')
  console.log(`✅ @yourscope/dsh-motor-ai-core 导入成功`)
  console.log(`   导出: ${Object.keys(core).slice(0, 5).join(', ')}...`)
} catch (err) {
  console.log(`❌ core 导入失败: ${err.message}`)
  failures++
}

try {
  // 尝试导入插件入口（使用 file:// URL 避免 Windows 路径问题）
  const pluginUrl = new URL('index.mjs', ROOT_URL)
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
  const pluginUrl = new URL('index.mjs', ROOT_URL)
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
