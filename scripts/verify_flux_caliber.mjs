#!/usr/bin/env node
/**
 * P0-8 门禁（完整版 dsh-motor-ai 1.2.4 + core 1.5.4，2026-10-31）
 * ---------------------------------------------------------------------------
 * 验证 P0-8 能力在完整版三处接线（l0-estimate / pipeline / design-validate 的
 * probeRow 就地注入 + solve_turns 回显）真实生效，并通过 300kW 实证锚点确认口径。
 *
 * 覆盖：
 *   §1 静态锚点（源码级守卫：TOOL_PARAMS 声明 + 透传 + 就地注入真实存在）
 *   §2 l0-estimate args 通道：back_emf_drop（k_E 反标 turns_ideal_at_load）
 *   §3 l0-estimate args 通道：tooth_peak_gate（齿部峰值口径字段 + 饱和判定）
 *   §4 design-validate.solve_turns：回显 back_emf_drop_factor / turns_ideal_at_load
 *   §5 300kW 实证锚点（峰值 2.53T 超饱和限 33%；k_E 反标 3.241→2.852）
 *
 * 门禁纪律：每个返回声明体内必有断言；开关双通道（args+env）分别断言；
 * 取值路径必须构造"只有该路径能区分"的用例。配额：freeQuotaEnabled:false。
 * 用法： node scripts/verify_flux_caliber.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runL0Estimate } from '../tools/l0/l0-estimate.mjs'
import { runL0Pipeline } from '../tools/l0/pipeline.mjs'
import { runDesignValidate, runSolveTurns } from '../tools/l0/design-validate.mjs'
import { quickL0Estimate } from '@wangxue98/dsh-motor-ai-core'

let pass = 0, fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROW300 = {
  stator_od: 602, stator_id: 402, rotor_od: 400, core_length: 640, air_gap: 1.02,
  tooth_width: 4.39, yoke_thickness: 39.6, shaft_dia: 140,
  poles: 6, voltage: 690, speed: 985, slots_stator: 72, slots_rotor: 28,
  turns_per_coil: 3, parallel_circuits: 2, power_kw: 300, torque_nm: 2909,
  cooling: 'forced_air', line_freq_hz: 50, insulation_class: 'H', motor_type: 'induction',
}
const WIDE = { ...ROW300, tooth_width: 8.77 }
const CFG = { freeQuotaEnabled: false }
const PI2 = Math.PI / 2

// ── §1 静态锚点 ──────────────────────────────────────────────
console.log('\n§1 静态锚点（源码级守卫）')
{
  const est = readFileSync(`${__dirname}/../tools/l0/l0-estimate.mjs`, 'utf8')
  const pipe = readFileSync(`${__dirname}/../tools/l0/pipeline.mjs`, 'utf8')
  const dv = readFileSync(`${__dirname}/../tools/l0/design-validate.mjs`, 'utf8')
  ok(est.includes('tooth_peak_gate === false') && est.includes('back_emf_drop'),
    'l0-estimate 透传 tooth_peak_gate / back_emf_drop（源码锚点）')
  ok(est.includes("tooth_peak_gate:") && est.includes("back_emf_drop:"),
    'l0-estimate TOOL_PARAMS 声明两个新参数（源码锚点）')
  ok(pipe.includes('args.tooth_peak_gate != null ? { tooth_peak_gate')
    && pipe.includes('args.back_emf_drop != null ? { back_emf_drop'),
    'pipeline 显式白名单透传两个新参数（源码锚点）')
  ok(dv.includes('opts?.toothPeakGate === false ? { toothPeakGate: false }')
    && dv.includes('opts?.backEmfDrop'),
    'design-validate probeRow 就地注入两个新开关（源码锚点，防静默无效）')
  ok(dv.includes('back_emf_drop_factor:') && dv.includes('turns_ideal_at_load:'),
    'design-validate.solve_turns 回显两个反标字段（源码锚点）')
}

// ── §2 args 通道：匝数反标 k_E ───────────────────────────────
console.log('\n§2 l0-estimate back_emf_drop（k_E 反标）')
{
  const def = runL0Estimate({ params_list: [ROW300], top_n: 1 }, CFG).results[0]
  const at = runL0Estimate({ params_list: [ROW300], top_n: 1, back_emf_drop: 0.88 }, CFG).results[0]
  ok(Number.isFinite(def.turns_per_coil_ideal), '默认无 k_E 时 turns_per_coil_ideal 有值', `=${def.turns_per_coil_ideal}`)
  ok(Number.isFinite(at.turns_per_coil_ideal_at_load), 'k_E=0.88 回吐 turns_per_coil_ideal_at_load', `=${at.turns_per_coil_ideal_at_load}`)
  ok(near(at.turns_per_coil_ideal_at_load, def.turns_per_coil_ideal * 0.88, 0.01),
    'at_load ≈ ideal × 0.88（反标生效）', `${at.turns_per_coil_ideal_at_load} vs ${def.turns_per_coil_ideal * 0.88}`)
  ok(at.turns_per_coil_ideal_at_load < def.turns_per_coil_ideal, 'k_E 反标后匝数减少（与 RMxprt 一致方向）')
  // 非法值回落默认 1.0 ⇒ at_load 退化等于 ideal
  const bad = runL0Estimate({ params_list: [ROW300], top_n: 1, back_emf_drop: 9 }, CFG).results[0]
  ok(bad.turns_per_coil_ideal_at_load == null || bad.turns_per_coil_ideal_at_load === def.turns_per_coil_ideal,
    '非法 k_E(=9) 回落默认（不污染 Ideal 匝数）')
}

// ── §3 args 通道：齿部峰值门禁 ───────────────────────────────
console.log('\n§3 l0-estimate tooth_peak_gate（峰值口径）')
{
  const on = runL0Estimate({ params_list: [ROW300], top_n: 1 }, CFG).results[0]
  ok(Number.isFinite(on.tooth_flux_density_peak), '默认（ON）回吐 tooth_flux_density_peak', `peak=${on.tooth_flux_density_peak}`)
  // ⚠ 峰值基于**实际**口径 tooth_flux_density_actual（回退兼容字段 tooth_flux_density 是旧派生值，勿混用）
  ok(near(on.tooth_flux_density_peak, on.tooth_flux_density_actual * PI2, 0.05),
    'peak ≈ Bt_actual × π/2（与 RMxprt 峰值同源）', `${on.tooth_flux_density_peak} vs ${on.tooth_flux_density_actual * PI2}`)
  ok(on.tooth_peak_sat === true, '窄齿 300kW 默认 ON 时峰值 >1.9T ⇒ 饱和告警（区分力）', `peak=${on.tooth_flux_density_peak}`)
  // 宽齿对照：峰值应显著低于窄齿
  const wide = runL0Estimate({ params_list: [WIDE], top_n: 1 }, CFG).results[0]
  ok(wide.tooth_peak_sat === false, '宽齿 8.77mm ⇒ 峰值未饱和（区分力）', `peak=${wide.tooth_flux_density_peak}`)
  ok(on.tooth_flux_density_peak > wide.tooth_flux_density_peak * 1.5, '窄齿峰值显著高于宽齿（方向正确）')

  // 门禁开关只控「是否发 V07-peak 告警」，不改物理真值字段 ⇒ 用 design-validate 的 issues 验证
  const dvOn = runDesignValidate({ params: ROW300, tooth_peak_gate: true }, CFG)
  const dvOff = runDesignValidate({ params: ROW300, tooth_peak_gate: false }, CFG)
  const v07peak = (r) => (r.issues ?? []).filter((i) => i.rule === 'V07' && /峰值|peak/i.test(i.msg ?? ''))
  ok(v07peak(dvOn).length > 0, 'gate ON ⇒ design-validate 回吐 V07 峰值告警',
    v07peak(dvOn).map((i) => i.msg.slice(0, 60)).join(' | '))
  ok(v07peak(dvOff).length === 0, 'gate OFF ⇒ 不发 V07 峰值告警')
  // metrics 侧与开关一致：ON 回吐峰值三元组，OFF 不回吐（l0 同语义）
  ok(dvOn.metrics?.flux?.tooth_peak_t > 1.9 && dvOn.metrics?.flux?.tooth_caliber === 'peak_and_pole_mean_dual',
    'gate ON ⇒ metrics.flux 回吐 tooth_peak_t + 双口径标记', `peak=${dvOn.metrics?.flux?.tooth_peak_t}`)
  ok(dvOff.metrics?.flux?.tooth_peak_t === undefined,
    'gate OFF ⇒ metrics.flux 不回吐峰值（与开关一致）')

  // back_emf_drop 的 args→opts→validateDesign 接线（metrics.back_emf 回显，有区分力）
  const dvDef = runDesignValidate({ params: ROW300 }, CFG)
  const dvKe = runDesignValidate({ params: ROW300, back_emf_drop: 0.88 }, CFG)
  ok(dvDef.metrics?.back_emf?.back_emf_drop_factor === 1 && dvKe.metrics?.back_emf?.back_emf_drop_factor === 0.88,
    'args.back_emf_drop ⇒ validateDesign metrics.back_emf.back_emf_drop_factor（1→0.88）')
  ok(dvDef.metrics?.back_emf?.turns_ideal_at_load === 3.241 && near(dvKe.metrics?.back_emf?.turns_ideal_at_load, 2.852, 0.01),
    'metrics.back_emf.turns_ideal_at_load 反标生效（3.241→2.852）',
    `${dvDef.metrics?.back_emf?.turns_ideal_at_load}→${dvKe.metrics?.back_emf?.turns_ideal_at_load}`)
}

// ── §4 design-validate.solve_turns 回显 ──────────────────────
console.log('\n§4 design-validate solve_turns（反标回显）')
{
  // args→opts→runSolveTurns 全链路（经 runDesignValidate 分发，验证外层 opts 构造行）
  const viaDv = runDesignValidate({ solve_turns: ROW300, back_emf_drop: 0.88 }, CFG)
  ok(viaDv.mode === 'solve_turns' && viaDv.electrical?.back_emf_drop_factor === 0.88,
    'runDesignValidate(solve_turns+back_emf_drop) ⇒ electrical.back_emf_drop_factor=0.88（外层 opts 接线）',
    `=${viaDv.electrical?.back_emf_drop_factor}`)
  ok(near(viaDv.electrical?.turns_ideal_at_load, viaDv.electrical?.turns_ideal * 0.88, 0.01),
    '经 DV 的 at_load ≈ ideal × 0.88', `${viaDv.electrical?.turns_ideal_at_load}`)
  const r = runSolveTurns(ROW300, { backEmfDrop: 0.88 }, CFG)
  ok(r.mode === 'solve_turns', 'solve_turns 模式正常返回')
  ok(Number.isFinite(r.electrical?.back_emf_drop_factor) && r.electrical.back_emf_drop_factor === 0.88,
    '回显 back_emf_drop_factor=0.88', `=${r.electrical?.back_emf_drop_factor}`)
  ok(Number.isFinite(r.electrical?.turns_ideal_at_load),
    '回显 turns_ideal_at_load', `=${r.electrical?.turns_ideal_at_load}`)
  ok(near(r.electrical.turns_ideal_at_load, r.electrical.turns_ideal * 0.88, 0.01),
    'at_load ≈ ideal × 0.88', `${r.electrical.turns_ideal_at_load} vs ${r.electrical.turns_ideal * 0.88}`)
}

// ── §5 300kW 实证锚点 ────────────────────────────────────────
console.log('\n§5 300kW 实证锚点')
{
  const e = quickL0Estimate(ROW300, { backEmfDrop: 0.88 })
  ok(near(e.tooth_flux_density_peak, 2.53, 0.1), '窄齿峰值 ≈2.53T（超饱和限 1.9T 约 33%）', `=${e.tooth_flux_density_peak}`)
  ok(near(e.turns_per_coil_ideal_at_load, 2.85, 0.05), 'k_E=0.88 ⇒ 反标匝 ≈2.85（接近 RMxprt 达标 2 匝方向）', `=${e.turns_per_coil_ideal_at_load}`)
  ok(e.tooth_flux_density_peak > 1.9, '确认 300kW 原方案"Bt 达标"是平均口径假达标')
}

console.log(`\n══ P0-8 完整版门禁：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail === 0 ? 0 : 1)

function near(a, b, tol = 0.05) { return Math.abs(a - b) < tol }
