/**
 * §3.1.4 License Token（JWT 式）离线冒烟测试。
 * 不依赖私钥/外部服务：本地生成 Ed25519 密钥对，公钥经 env 注入验签路径，
 * 覆盖 签发→验签 / 入口分发 / 过期 / 篡改 / 吊销 / 非 JWT 分流 / activate 落盘 七项。
 */
import { generateKeyPairSync } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import assert from 'node:assert'

const __dirname = dirname(fileURLToPath(import.meta.url))
const lic = await import(pathToFileURL(join(__dirname, '..', 'lib', 'license.mjs')).href)

// 隔离激活落盘路径，避免污染真实 $DSH_HOME
process.env.DSH_HOME = join(tmpdir(), `dsh-license-test-${Date.now()}`)

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
process.env.ACTIVATION_PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' })

const now = Date.now()
const future = new Date(now + 365 * 86400 * 1000).toISOString()
const past = new Date(now - 86400 * 1000).toISOString()

let pass = 0
let fail = 0

async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log('  PASS', name)
  } catch (e) {
    fail++
    console.error('  FAIL', name, '::', e.message)
  }
}

await check('1. 签发商业年付 token 并验签 valid', () => {
  const tok = lic.createLicenseToken(
    { mode: 'commercial', tier: 'annual', expiresAt: future, maxWorkspaces: 1, jti: 'jti-001' },
    { privateKey },
  )
  const d = lic.decodeLicenseToken(tok)
  assert.ok(d, 'decode 失败')
  const v = lic.verifyLicenseToken(d)
  assert.strictEqual(v.valid, true)
  assert.strictEqual(v.mode, 'commercial')
  assert.strictEqual(v.tier, 'annual')
  assert.strictEqual(v.expiresAt, future)
})

await check('2. verifyLicense 入口识别 JWT 三段式', () => {
  const tok = lic.createLicenseToken({ tier: 'monthly', expiresAt: future, jti: 'jti-002' }, { privateKey })
  const v = lic.verifyLicense(tok)
  assert.strictEqual(v.valid, true)
  assert.strictEqual(v.tier, 'monthly')
})

await check('3. 过期 token → invalid（reason 含「过期」）', () => {
  const tok = lic.createLicenseToken({ tier: 'annual', expiresAt: past, jti: 'jti-003' }, { privateKey })
  const v = lic.verifyLicenseToken(lic.decodeLicenseToken(tok))
  assert.strictEqual(v.valid, false)
  assert.match(v.reason, /过期/)
})

await check('4. 篡改签名 → invalid（reason 含「签名」）', () => {
  const tok = lic.createLicenseToken({ tier: 'annual', expiresAt: future, jti: 'jti-004' }, { privateKey })
  const parts = tok.split('.')
  const bad = `${parts[0]}.${parts[1]}.` + 'A'.repeat(parts[2].length)
  const v = lic.verifyLicenseToken(lic.decodeLicenseToken(bad))
  assert.strictEqual(v.valid, false)
  assert.match(v.reason, /签名/)
})

await check('5. 吊销 jti → invalid（reason 含「吊销」）', () => {
  const tok = lic.createLicenseToken({ tier: 'annual', expiresAt: future, jti: 'jti-REV' }, { privateKey })
  const v = lic.verifyLicenseToken(lic.decodeLicenseToken(tok), { revokedJtis: ['jti-REV'] })
  assert.strictEqual(v.valid, false)
  assert.match(v.reason, /吊销/)
})

await check('6. 非 JWT 形态不被误判为 License Token', () => {
  assert.strictEqual(lic.isLicenseToken('v2:full:wangxue98::0:0:deadbeef'), false)
  assert.strictEqual(lic.isLicenseToken('DM-1234-5678'), false)
  const v = lic.verifyLicense('v2:full:wangxue98::0:0:deadbeef')
  assert.strictEqual(v.valid, false)
})

await check('7. activateLicenseToken 落盘且映射 tier=full / plan=计费档位', async () => {
  const tok = lic.createLicenseToken(
    { mode: 'commercial', tier: 'quarterly', expiresAt: future, jti: 'jti-ACT' },
    { privateKey },
  )
  const r = await lic.activateLicenseToken(tok)
  assert.strictEqual(r.success, true)
  assert.strictEqual(r.tier, 'full')
  assert.strictEqual(r.plan, 'quarterly')
  const st = lic.loadActivationState()
  assert.strictEqual(st.tier, 'full')
  assert.strictEqual(st.plan, 'quarterly')
  assert.strictEqual(st.source, 'license-token')
})

console.log(`\nlicense-token smoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
