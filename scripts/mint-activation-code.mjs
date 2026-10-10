#!/usr/bin/env node
/**
 * 离线激活码签发工具（非对称 Ed25519）
 * ============================================================
 * 签发者（持私钥方）在本地运行本脚本生成激活码，
 * 通过私域渠道（微信/支付宝收款后）发给购买者。
 *
 * 机制：v2 非对称（Ed25519）
 *   - 公钥随包发布（lib/activation-public.pem，公开安全），部署后的插件用其验签
 *   - 私钥由作者自持（.secrets/activation-private.pem，绝不入库/不随包）
 *
 * 用法：
 *   # 生成密钥对（首次；公钥写 lib/，私钥写 .secrets/ 或仅打印）
 *   node scripts/mint-activation-code.mjs --genkey --write-secret
 *
 *   # 签发激活码（私钥来源：--key > ACTIVATION_PRIVATE_KEY 环境变量 > .secrets/activation-private.pem）
 *   node scripts/mint-activation-code.mjs --type full --issuer wangxue98 --buyer 15389089358@163.com
 *   node scripts/mint-activation-code.mjs --type l1 --valid-days 365 --buyer 张三
 */

import { createActivateCode } from '../lib/license.mjs'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PUB_PATH = join(ROOT, 'lib', 'activation-public.pem')
const PRIV_PATH = join(ROOT, '.secrets', 'activation-private.pem')

const { values } = parseArgs({
  options: {
    genkey: { type: 'string', description: '生成 Ed25519 密钥对；传 "yes"/--write-secret 时把私钥写入 .secrets/' },
    'write-secret': { type: 'boolean', description: '配合 --genkey：将私钥写入 .secrets/activation-private.pem' },
    type: { type: 'string', default: 'full' },
    issuer: { type: 'string', default: 'wangxue98' },
    buyer: { type: 'string', default: '' },
    'valid-days': { type: 'string', description: '有效期天数（缺省 = 永久）' },
    key: { type: 'string', description: 'Ed25519 私钥 PEM（缺省读 ACTIVATION_PRIVATE_KEY 或 .secrets/activation-private.pem）' },
    json: { type: 'boolean', description: '以 JSON 输出（便于批量脚本消费）' },
  },
  allowPositionals: false,
})

function fail(msg) {
  console.error(`[mint] ${msg}`)
  process.exit(1)
}

// --- 生成密钥对 ---
if (values.genkey) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' })

  writeFileSync(PUB_PATH, pubPem)
  console.log('[mint] 公钥已写入 lib/activation-public.pem（随包发布，与 lib/license.mjs 内置常量须一致）')

  if (values.genkey === 'yes' || values['write-secret']) {
    if (!existsSync(dirname(PRIV_PATH))) mkdirSync(dirname(PRIV_PATH), { recursive: true })
    writeFileSync(PRIV_PATH, privPem)
    console.log('[mint] 私钥已写入 .secrets/activation-private.pem（该目录应 .gitignore 且**绝不**出现在 npm 发布面）')
  } else {
    console.log('[mint] 私钥（请自行保管，勿入库/勿随包）：')
    process.stdout.write(privPem)
  }
  process.exit(0)
}

// --- 取私钥（优先级：--key > 环境变量 > .secrets 文件）---
let privateKey
if (values.key) {
  privateKey = values.key
} else if (process.env.ACTIVATION_PRIVATE_KEY) {
  privateKey = process.env.ACTIVATION_PRIVATE_KEY
} else if (existsSync(PRIV_PATH)) {
  privateKey = readFileSync(PRIV_PATH, 'utf8')
}
if (!privateKey) {
  fail('未提供私钥。请先 --genkey 生成，再用 --key 传入、设置 ACTIVATION_PRIVATE_KEY，或将私钥置于 .secrets/activation-private.pem。')
}

// --- 签发（v2 非对称）---
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
  privateKey,
})

if (values.json) {
  console.log(JSON.stringify({
    code,
    type,
    issuer: values.issuer,
    buyer: values.buyer,
    valid: validDays ? `${validDays}d` : 'permanent',
    issuedAt: new Date().toISOString(),
    scheme: 'v2-ed25519',
  }, null, 2))
} else {
  console.log('=== 激活码（发给购买者）===')
  console.log(code)
  console.log(`--- 规格: type=${type} issuer=${values.issuer} buyer=${values.buyer || '(未指定)'} 有效期=${validDays ? validDays + ' 天' : '永久'} 方案=v2-ed25519`)
  console.log('购买者使用方式: 在 DSH 中运行 /dsh-motor-ai-activate（code=上面这串）')
}
