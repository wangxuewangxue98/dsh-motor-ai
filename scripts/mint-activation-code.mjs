#!/usr/bin/env node
/**
 * 离线激活码签发工具（收费轨 A 的签码基建）
 * ============================================================
 * 签发者（持私钥方）在本地运行本脚本生成激活码，
 * 通过私域渠道（微信/支付宝收款后）发给购买者。
 *
 * 用法：
 *   # 生成密钥（首次，妥善保管，勿入库/勿随包分发）
 *   node scripts/mint-activation-code.mjs --genkey
 *
 *   # 签发激活码（需先设置密钥，或用 --key 参数临时传入）
 *   set ACTIVATION_HMAC_KEY=xxxx   (Windows)
 *   node scripts/mint-activation-code.mjs --type full --issuer wangxue98 --buyer 15389089358@163.com
 *   node scripts/mint-activation-code.mjs --type l1 --valid-days 365 --buyer 张三
 *
 * 密钥来源优先级：--key 参数 > ACTIVATION_HMAC_KEY 环境变量 > ./activation-keys.json（仅本地开发）
 */

import { createActivateCode } from '../lib/license.mjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    genkey: { type: 'string', description: '生成新密钥并保存（传 "yes" 表示同时写入本地 keys 文件）' },
    type: { type: 'string', default: 'full' },
    issuer: { type: 'string', default: 'wangxue98' },
    buyer: { type: 'string', default: '' },
    'valid-days': { type: 'string', description: '有效期天数（缺省 = 永久）' },
    key: { type: 'string', description: 'HMAC 密钥（缺省读 ACTIVATION_HMAC_KEY）' },
    json: { type: 'boolean', description: '以 JSON 输出（便于批量脚本消费）' },
  },
  allowPositionals: false,
})

function fail(msg) {
  console.error(`[mint] ${msg}`)
  process.exit(1)
}

// --- 生成密钥 ---
if (values.genkey) {
  const key = randomBytes(32).toString('hex')
  console.log('生成的 HMAC 密钥（妥善保管，切勿随包分发/入库）：')
  console.log(key)
  if (values.genkey === 'yes') {
    const keyFile = new URL('../activation-keys.json', import.meta.url)
    const data = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : { keys: {} }
    const id = 'k_' + randomUUID().slice(0, 8)
    data.keys[id] = key
    writeFileSync(keyFile, JSON.stringify(data, null, 2) + '\n', 'utf8')
    console.log(`[mint] 已写入本地开发密钥文件（id=${id}），该文件应加入 .gitignore`
      + ' 且**绝不能**出现在 npm 发布面（它不在 files 白名单内，请自查）')
  }
  process.exit(0)
}

// --- 取密钥 ---
const secret = values.key || process.env.ACTIVATION_HMAC_KEY
if (!secret) {
  fail('未提供 HMAC 密钥。请先 --genkey 生成，再用 --key 传入或设置 ACTIVATION_HMAC_KEY 环境变量。')
}

// --- 签发 ---
const type = values.type
if (!['l1', 'l2', 'full'].includes(type)) fail(`--type 必须为 l1/l2/full，收到: ${type}`)
const validDays = values['valid-days'] ? Number(values['valid-days']) : null
if (values['valid-days'] && (!Number.isInteger(validDays) || validDays <= 0)) {
  fail('--valid-days 必须为正整数')
}

const code = createActivateCode({
  type,
  issuer: values.issuer,
  buyer: values.buyer,
  validDays,
  secret,
})

if (values.json) {
  console.log(JSON.stringify({
    code,
    type,
    issuer: values.issuer,
    buyer: values.buyer,
    valid: validDays ? `${validDays}d` : 'permanent',
    issuedAt: new Date().toISOString(),
  }, null, 2))
} else {
  console.log('=== 激活码（发给购买者）===')
  console.log(code)
  console.log(`--- 规格: type=${type} issuer=${values.issuer} buyer=${values.buyer || '(未指定)'} 有效期=${validDays ? validDays + ' 天' : '永久'}`)
  console.log('购买者使用方式: 在 DSH 中运行 /dsh-motor-ai-activate（code=上面这串）')
}
