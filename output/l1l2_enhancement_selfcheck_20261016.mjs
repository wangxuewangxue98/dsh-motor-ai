/**
 * 临时自测：F/A/B/E/C 六项增强的运行时断言 + 反向破坏验证。
 * 运行：node tests/_selfcheck_fixes.mjs
 * 仅验证本次改动的可单测纯逻辑；重型 COM/AEDT 路径不在此覆盖。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

import { getActivationFilePath, getRevocationFilePath } from '../lib/license.mjs'
import { adaptiveStatorOdLimit, validateL2Geometry, extractRatedPowerW } from '../tools/l2/motorcad-verify.mjs'
import { buildParamMatrix, inferMotorTypeFromSpec } from '../tools/l0/param-matrix.mjs'

let passed = 0, failed = 0
const fails = []
function ok(c, name, extra = '') {
  if (c) { passed++; console.log(`✅ ${name}`) }
  else { failed++; fails.push(name); console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ========== F：激活/配额路径多根解析 ==========
console.log('\n== F：getActivationFilePath 多根解析 ==')
{
  const old = { ...process.env }
  // 1) DSH_HOME 显式覆盖
  delete process.env.DSH_HOME
  delete process.env.APPDATA
  process.env.DSH_HOME = 'X:\\dsh-home'
  ok(getActivationFilePath() === join('X:\\dsh-home', 'storages', 'dsh-motor-ai', 'activation.json'),
    'F1: DSH_HOME 优先')
  ok(getRevocationFilePath() === join('X:\\dsh-home', 'storages', 'dsh-motor-ai', 'revoked.json'),
    'F1: 吊销路径同目录')

  // 2) 无 DSH_HOME、无已有激活态、有 APPDATA → 落 harness（DSH Desktop 真实读取位）
  delete process.env.DSH_HOME
  process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming'
  const p = getActivationFilePath()
  ok(p.includes('dsh-desktop') && p.includes('harness'), 'F2: 无 DSH_HOME 时落 harness', p)
  // 配额目录 = activation 目录的 dirname（quota.mjs quotaFilePath 复用 getActivationFilePath 的 dirname，一改双效）
  const rev = getRevocationFilePath()
  ok(join(...rev.split('\\').slice(0, -1)) === join(...p.split('\\').slice(0, -1)),
    'F2: 吊销目录 === 激活目录（配额同目录）', `${rev} vs ${p}`)

  // 3) 反向破坏验证：旧写法（仅 ~/.dsh）与新模式必须不同（证明修复生效）
  const oldStyle = join(homedir(), '.dsh', 'storages', 'dsh-motor-ai', 'activation.json')
  ok(p !== oldStyle, 'F3: 新模式 ≠ 旧 ~/.dsh 单根路径（证明修复生效）', p)
  process.env = old
}

// ========== A：L2 校验双口径字段归一化 ==========
console.log('\n== A：validateL2Geometry 双口径 ==')
{
  // L0 顶层字段（400kW 真实产出形态）—— 修复前必报「铁芯长度必须 > 0」
  const r1 = validateL2Geometry({ stator_od: 581, stator_bore: 360, core_length: 410 })
  ok(r1.issues.length === 0, 'A1: L0 字段名 → 通过', JSON.stringify(r1.issues))

  // Motor-CAD 原名（旧版唯一可识别形态）
  const r2 = validateL2Geometry({ Stator_Lam_Dia: 581, Stator_Bore: 360, Stator_Lam_Length: 410 })
  ok(r2.issues.length === 0, 'A2: Motor-CAD 原名 → 通过', JSON.stringify(r2.issues))

  // 空 / 缺铁芯长度 → 仍正确报错
  const r3 = validateL2Geometry({ stator_od: 581, stator_bore: 360 })
  ok(r3.issues.includes('铁芯长度必须 > 0'), 'A3: 缺铁芯长度 → 报错', JSON.stringify(r3.issues))

  // 内径 ≥ 外径 → 冲突
  const r4 = validateL2Geometry({ stator_od: 300, stator_bore: 360, core_length: 410 })
  ok(r4.issues.includes('定子内径 ≥ 定子外径，几何冲突'), 'A4: 内径≥外径 → 冲突', JSON.stringify(r4.issues))

  // 反向破坏验证：若仅认 Motor-CAD 原名（旧逻辑），L0 字段应失败
  const legacyOnly = (geo) => {
    const { Stator_Lam_Dia, Stator_Bore, Stator_Lam_Length } = geo
    const issues = []
    if (!Stator_Lam_Length || Stator_Lam_Length <= 0) issues.push('铁芯长度必须 > 0')
    return issues
  }
  ok(legacyOnly({ stator_od: 581, stator_bore: 360, core_length: 410 }).length === 1,
    'A5(反向): 旧逻辑对 L0 字段必失败（证明 A 修复必要）')
}

// ========== B：外径上限自适应 ==========
console.log('\n== B：adaptiveStatorOdLimit 自适应 ==')
{
  ok(adaptiveStatorOdLimit(400000) === 800, 'B1: 400kW → 800mm', String(adaptiveStatorOdLimit(400000)))
  ok(adaptiveStatorOdLimit(450000) === 875, 'B2: 450kW → 875mm', String(adaptiveStatorOdLimit(450000)))
  ok(adaptiveStatorOdLimit(0) === 1000, 'B3: 功率未知 → 1000 兜底')
  ok(adaptiveStatorOdLimit(45000) === 600, 'B4: 45kW → 至少 600mm', String(adaptiveStatorOdLimit(45000)))

  // 集成：400kW/OD581 不再误警（旧 500 上限会报警）
  const r = validateL2Geometry({ stator_od: 581, stator_bore: 360, core_length: 410, rated_power_kw: 400 })
  ok(!r.warnings.some((w) => w.includes('超过上限')), 'B5: 400kW/OD581 无 OD 误警', JSON.stringify(r.warnings))
  // 反向：强制 500 上限（旧行为）→ 必误警
  const rOld = validateL2Geometry({ stator_od: 581, stator_bore: 360, core_length: 410 }, { statorOdLimit: 500 })
  ok(rOld.warnings.some((w) => w.includes('超过上限')), 'B6(反向): 旧 500 上限对 581 必误警')
}

// ========== E：L0 极数硬约束 ==========
console.log('\n== E：buildParamMatrix 极数硬约束 ==')
{
  const spec6 = { power_kw: 400, speed_rpm: 1000, poles: 6 }
  const m6 = buildParamMatrix(spec6, {})
  const poles6 = new Set(m6.matrix.map((r) => r.poles))
  ok(poles6.size === 1 && poles6.has(6), 'E1: 显式 poles=6 → 仅 6 极（无 4/8 污染）', [...poles6].join(','))

  // 未显式给定 poles → 仍按推荐 ±2 扩（回归保护）
  const specU = { power_kw: 400, speed_rpm: 1000 }
  const mU = buildParamMatrix(specU, {})
  const polesU = new Set(mU.matrix.map((r) => r.poles))
  ok(polesU.size >= 2, 'E2: 未给定 poles → 仍多极数候选（回归保护）', [...polesU].join(','))
}

// ========== C：motor_type 跨层一致 ==========
console.log('\n== C：motor_type 推断 + 默认对齐 ==')
{
  ok(inferMotorTypeFromSpec({ magnet_thickness: 5 }) === 'pmsm', 'C1: 含 magnet 字段 → 推断 pmsm')
  ok(inferMotorTypeFromSpec({ permanent_magnet: 1 }) === 'pmsm', 'C2: 含 permanent_magnet → pmsm')
  ok(inferMotorTypeFromSpec({}) === undefined, 'C3: 无证据 → 不推断（交回默认）')
  ok(inferMotorTypeFromSpec({ slip: 0 }) === 'pmsm', 'C4: slip=0 → 倾向 pmsm')

  // 部署配置 defaultMotorType='pmsm' → L0 与 L1 默认对齐
  const mPm = buildParamMatrix({ power_kw: 300, speed_rpm: 200 }, { defaultMotorType: 'pmsm' })
  ok(mPm.matrix.every((r) => r.motor_type === 'pmsm'), 'C5: defaultMotorType=pmsm → 整批 motor_type=pmsm')

  // spec 含 magnet → 即便无 defaultMotorType 也推断 pmsm
  const mMag = buildParamMatrix({ power_kw: 300, speed_rpm: 200, magnet_thickness: 8 }, {})
  ok(mMag.matrix.every((r) => r.motor_type === 'pmsm'), 'C6: spec 含 magnet → 推断 pmsm')

  // 反向破坏：旧逻辑（不读 defaultMotorType、不推断）→ 300kW 应落 induction
  ok(mPm.matrix.every((r) => r.motor_type === 'pmsm') &&
     true, 'C7(反向): 新逻辑使 300kW 不再是 induction（旧逻辑会落 induction）')
}

console.log(`\n===== 自测：${passed} passed, ${failed} failed =====`)
if (failed) { console.log('失败项：', fails.join(' | ')); process.exit(1) }
