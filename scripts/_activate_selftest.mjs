/**
 * 激活机制端到端自检（临时 DSH_HOME 隔离，不碰真实状态）
 * 适配 v2 非对称（Ed25519）：用 .secrets/activation-private.pem 签码，插件用内置公钥验签。
 * 用法: node _activate_selftest.mjs
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// 用临时 DSH_HOME，避免污染真实激活状态
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-act-'))
process.env.DSH_HOME = tmpHome

const here = path.dirname(fileURLToPath(import.meta.url))
const privPath = path.join(here, '..', '.secrets', 'activation-private.pem')
if (!fs.existsSync(privPath)) {
  console.error('[selftest] 缺少 .secrets/activation-private.pem；请先运行：node scripts/mint-activation-code.mjs --genkey --write-secret')
  process.exit(1)
}
const privateKey = fs.readFileSync(privPath, 'utf8')

// 动态 import 确保读到上面设置的环境变量
const lic = await import('../lib/license.mjs')
const {
  createActivateCode, activate, queryActivation,
  isLevelAllowed, decodeActivateCode, verifyActivateCode,
} = lic

// 伪造私钥（用于验证「非持有私钥签发的码被拒」）
const { privateKey: fakePrivateKey } = generateKeyPairSync('ed25519')

let pass = 0, fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}`) }
}

console.log('\n[1] 初始未激活态')
let st = queryActivation()
assert(!st.active, '默认未激活')
assert(st.tier === 'free', '默认 tier=free')
assert(isLevelAllowed('l0') === true, 'l0 免费可用')
assert(isLevelAllowed('l1') === false, 'l1 未激活拦截')
assert(isLevelAllowed('l2') === false, 'l2 未激活拦截')

console.log('\n[2] 签发 + 激活 (full, 永久, v2 非对称)')
const fullCode = createActivateCode({ type: 'full', issuer: 'wangxue98', buyer: 'test@163.com', privateKey })
console.log('  激活码:', fullCode)
assert(fullCode.startsWith('v2:'), '码以 v2: 开头')
const r1 = activate(fullCode)
assert(r1.success === true, '激活成功')
assert(r1.tier === 'full', 'tier=full')
st = queryActivation()
assert(st.active === true && st.tier === 'full', '状态已持久化为 full')
assert(isLevelAllowed('l1') === true, 'full 放行 l1')
assert(isLevelAllowed('l2') === true, 'full 放行 l2')

console.log('\n[3] 覆盖为 l1 限时码')
const l1Code = createActivateCode({ type: 'l1', issuer: 'wangxue98', buyer: 'test', validDays: 1, privateKey })
const r2 = activate(l1Code)
assert(r2.success === true, '重新激活成功')
st = queryActivation()
assert(st.tier === 'l1', 'tier 降级为 l1')
assert(isLevelAllowed('l2') === false, 'l1 不放行 l2')
assert(isLevelAllowed('l1') === true, 'l1 放行 l1')

console.log('\n[4] 伪造私钥签的码 → 验签失败')
const fakeCode = createActivateCode({ type: 'full', issuer: 'wangxue98', buyer: 'x', privateKey: fakePrivateKey })
const r3 = activate(fakeCode)
assert(r3.success === false, '伪造私钥签的码被拒')
assert(/签名/.test(r3.reason), '原因含"签名"')

console.log('\n[5] 篡改码 → 验签失败')
const tampered = fullCode.replace(/:[0-9a-f]{128}$/, ':' + '0'.repeat(128))
const r4 = activate(tampered)
assert(r4.success === false, '篡改码被拒')

console.log('\n[6] 过期码 → 拒')
const expiredCode = createActivateCode({ type: 'full', issuer: 'x', validDays: -1, privateKey })
const dec = decodeActivateCode(expiredCode)
const v = verifyActivateCode(dec)
assert(v.valid === false, '过期码验签失败')

console.log('\n[7] decode 格式容错')
assert(decodeActivateCode('garbage') === null, '非法码返回 null')
assert(decodeActivateCode(fullCode) !== null, '合法码可解析')
assert(decodeActivateCode('v3:foo') === null, '未知版本 v3 返回 null')

// 清理
fs.rmSync(tmpHome, { recursive: true, force: true })
delete process.env.DSH_HOME

console.log(`\n=== 自检结果: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
