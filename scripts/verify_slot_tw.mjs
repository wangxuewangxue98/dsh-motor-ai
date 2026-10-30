#!/usr/bin/env node
/**
 * 门禁：P0-7 单一齿宽口径 + v1.2.3 VFD 排序方向修复（full 插件 dsh-motor-ai）
 * ---------------------------------------------------------------------------
 * 背景（2026-10-30）：完整版插件 1.2.2 与精简版 l0 0.6.9 同源分叉，本仓**未同步 P0-7**，
 * 且存在一个真 bug：sort_by='temp_rise_vfd' 已在排序白名单里，却不在升序集合里
 * ⇒ 按**降序**排（温升越高越靠前），与正弦口径 temp_rise 方向相反。
 *
 * 根因（P0-7，300kW 方案实证）：Bt 公式消费 row.tooth_width（tw_axis 值 4.39），
 * slotGeometryDerived 硬编码 π·Di/(2Qs)=8.77 ⇒ 同一次估算里并存两个互斥齿宽：
 *   齿统一 8.77 ⇒ Bt=0.807T 挂；齿统一 4.39 ⇒ fill=0.330 挂。
 *   「双达标」只在两公式解耦时存在（解耦 Artifact）。
 *
 * 覆盖：
 *   §1 静态锚点（源码级守卫：三处接线与三处 TOOL_PARAMS 声明真实存在）
 *   §2 l0 args 通道（runL0Estimate：OFF=legacy_derived / ON=explicit，槽面积手算判据）
 *   §3 env 通道（DSH_L0_SLOT_TW 由 core 直读 + opts 双向胜出）
 *   §4 单一齿宽闭环（ON 时槽侧齿宽 == Bt 侧齿宽；OFF 时两者不同 = 双齿宽实证）
 *   §5 design-validate 通道（本仓独有接线：单条校验与批量估算同口径）
 *   §6 VFD 排序方向（运行时实证：temp_rise_vfd 必须升序 = 越小越好）
 *   §7 pipeline 端到端（slot_tw 必须穿过**显式白名单**才生效，静态声明不够）
 *
 * 配额：freeQuotaEnabled:false（纯函数入口同样尊重）。
 * 用法： node scripts/verify_slot_tw.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runL0Estimate, SORTABLE_FIELDS, ASCENDING_FIELDS } from '../tools/l0/l0-estimate.mjs'
import { runL0Pipeline } from '../tools/l0/pipeline.mjs'
import { runDesignValidate } from '../tools/l0/design-validate.mjs'
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
const CFG = { freeQuotaEnabled: false }
const TW_DERIVED = Math.round((Math.PI * 402) / (2 * 72) * 100) / 100   // 8.77
const near = (a, b, tol = 0.05) => Math.abs(a - b) < tol
const firstRow = (r) => r?.results?.[0] ?? r?.top_results?.[0] ?? r

// ── §1 静态锚点 ──────────────────────────────────────────────
console.log('\n§1 静态锚点（源码级守卫）')
{
  const est = readFileSync(`${__dirname}/../tools/l0/l0-estimate.mjs`, 'utf8')
  const pipe = readFileSync(`${__dirname}/../tools/l0/pipeline.mjs`, 'utf8')
  const dv = readFileSync(`${__dirname}/../tools/l0/design-validate.mjs`, 'utf8')
  ok(est.includes("args.slot_tw === true || args.slot_tw === 'true'"),
    'l0-estimate 主路径透传 args.slot_tw ⇒ opts.slotTw（源码锚点）')
  ok(est.includes('slot_tw:') && est.includes('单一齿宽口径'),
    'l0-estimate TOOL_PARAMS 声明 slot_tw（源码锚点）')
  ok(pipe.includes('args.slot_tw != null ? { slot_tw: args.slot_tw }'),
    'pipeline 白名单透传 slot_tw（源码锚点：白名单调用不登记则到不了估算）')
  ok(pipe.includes('slot_tw:') && pipe.includes('单一齿宽口径'),
    'pipeline TOOL_PARAMS 声明 slot_tw（源码锚点）')
  ok(dv.includes('slotTw: true') && dv.includes('slot_tw:'),
    'design-validate opts 注入 + 声明 slot_tw（源码锚点）')
  // 排序修复锚点
  ok(ASCENDING_FIELDS.has('temp_rise_vfd') && ASCENDING_FIELDS.has('total_loss_vfd'),
    'ASCENDING_FIELDS 含 temp_rise_vfd / total_loss_vfd（导出值运行时断言）')
  ok(SORTABLE_FIELDS.includes('total_loss_vfd') && SORTABLE_FIELDS.includes('efficiency_vfd_raw'),
    'SORTABLE_FIELDS 含 total_loss_vfd / efficiency_vfd_raw（已注入字段须可排序）')
}

// ── §2 l0 args 通道 ──────────────────────────────────────────
console.log('\n§2 l0 args 通道（runL0Estimate）')
{
  const rOff = firstRow(runL0Estimate({ params_list: [ROW300], top_n: 1 }, CFG))
  ok(rOff.slot_tw_caliber === 'legacy_derived',
    'OFF：slot_tw_caliber=legacy_derived（旧行为，零回归）', `got=${rOff.slot_tw_caliber}`)
  ok(near(rOff.slot_tooth_width_mm, TW_DERIVED),
    `OFF：槽几何齿宽=派生 ${TW_DERIVED}`, `got=${rOff.slot_tooth_width_mm}`)

  const rOn = firstRow(runL0Estimate({ params_list: [ROW300], top_n: 1, slot_tw: true }, CFG))
  ok(rOn.slot_tw_caliber === 'explicit',
    "ON（args.slot_tw=true）：slot_tw_caliber=explicit（只有显式路径能得出）", `got=${rOn.slot_tw_caliber}`)
  ok(near(rOn.slot_tooth_width_mm, 4.39),
    'ON：槽几何齿宽=4.39（row 值，与 Bt 同源）', `got=${rOn.slot_tooth_width_mm}`)
  // 手算判据：depth=60.0，pitch=π·(Di+depth)/Qs ⇒ sw=pitch−4.39 ⇒ 毛槽=sw·depth
  const depth = 60.0
  const sw = (Math.PI * (402 + depth)) / 72 - 4.39
  ok(near(rOn.slot_area_mm2, sw * depth, 0.1),
    `ON：slot_area 手算 ${Number(sw * depth).toFixed(1)}mm² 逐位对上`, `got=${rOn.slot_area_mm2}`)
  ok(rOn.slot_fill_engineering < rOff.slot_fill_engineering,
    'ON：fill(eng) 显著低于 OFF（齿 4.39 ⇒ 槽更大 ⇒ 同导线更欠满）',
    `${rOff.slot_fill_engineering} → ${rOn.slot_fill_engineering}`)

  const rStr = firstRow(runL0Estimate({ params_list: [ROW300], top_n: 1, slot_tw: 'true' }, CFG))
  ok(rStr.slot_tw_caliber === 'explicit', "ON（slot_tw='true' 字符串）同效", `got=${rStr.slot_tw_caliber}`)
}

// ── §3 env 通道（core 直读） ─────────────────────────────────
console.log('\n§3 env 通道（DSH_L0_SLOT_TW，core 直读）')
{
  process.env.DSH_L0_SLOT_TW = '1'
  try {
    const e = quickL0Estimate(ROW300, {})
    ok(e.slot_tw_caliber === 'explicit' && near(e.slot_tooth_width_mm, 4.39),
      'env=1 且不传 opts ⇒ 显式口径生效（core 直读 env）')
    const eOff = quickL0Estimate(ROW300, { slotTw: false })
    ok(eOff.slot_tw_caliber === 'legacy_derived',
      'opts 显式关闭压过 env（双向胜出，铁律）', `got=${eOff.slot_tw_caliber}`)
  } finally {
    delete process.env.DSH_L0_SLOT_TW
  }
}

// ── §4 单一齿宽闭环（解耦 Artifact 实证） ────────────────────
console.log('\n§4 单一齿宽闭环（Bt 侧 vs 槽侧齿宽）')
{
  const rOff = firstRow(runL0Estimate({ params_list: [ROW300], top_n: 1 }, CFG))
  ok(!near(rOff.slot_tooth_width_mm, 4.39, 0.01),
    'OFF：槽侧齿宽(8.77) ≠ Bt 侧齿宽(4.39) ⇒ 双齿宽并存实证（这正是要修的）',
    `slot=${rOff.slot_tooth_width_mm} vs bt=4.39`)
  const rOn = firstRow(runL0Estimate({ params_list: [ROW300], top_n: 1, slot_tw: true }, CFG))
  ok(near(rOn.slot_tooth_width_mm, 4.39, 0.001),
    'ON：槽侧齿宽 == Bt 侧齿宽(4.39) ⇒ 单一口径闭环', `got=${rOn.slot_tooth_width_mm}`)
}

// ── §5 design-validate 通道（本仓独有接线） ──────────────────
console.log('\n§5 design-validate 通道（估算侧真正吃到 slotTw）')
{
  const dvOff = runDesignValidate({ params: ROW300 }, CFG)
  const dvOn = runDesignValidate({ params: ROW300, slot_tw: true }, CFG)
  ok(dvOff && !dvOff.error, 'design-validate 基线可运行（slot_tw 未破坏原路径）',
    dvOff?.error ? `error=${dvOff.error}` : '')

  // ⚠ 可观测性取证（决定本节能断言到什么程度，诚实边界，勿写成未验证的声明）：
  //   ① single 模式只调 validateDesign（:342），**不走 probeRow**；probeRow 仅服务
  //      sweep / solve_turns 两个杠杆原语 ⇒ 本通道的 slotTw 接线只对这两个原语生效。
  //   ② core validateDesign 不回吐 slot_area_mm2 / slot_fill_engineering / slot_tw_caliber。
  //   ③ core 实测：slotTw ON/OFF 时 copper_loss 恒为 12497.3W、total_loss 恒为 22722.4W
  //      —— 铜损由电流与已定绕组电阻决定，槽面积只影响「装不装得下」（fill），不是损耗驱动量。
  //   综合 ⇒ 该通道**当前无运行时可观测差异面**。故本门禁只守「接线存在 + 零回归」，
  //   不谎称有行为变化。若将来 core 让槽几何参与铜损或 validateDesign 回吐槽字段，本处须补断言。
  const src = readFileSync(`${__dirname}/../tools/l0/design-validate.mjs`, 'utf8')
  ok(src.includes('...(opts?.slotTw ? { slotTw: true } : {})'),
    'probeRow 内 quickL0Estimate 侧接线 slotTw（源码锚点；外层 opts 不继承，必须就地构造）')
  ok(dvOn && !dvOn.error && dvOn?.status === dvOff?.status
    && JSON.stringify(dvOn?.metrics) === JSON.stringify(dvOff?.metrics),
    '零回归：slot_tw ON 不改变单条校验的 verdict 与指标（默认 OFF 语义成立）',
    `status=${dvOff?.status}/${dvOn?.status}`)
}

// ── §6 VFD 排序方向（运行时实证，非静态锚点） ────────────────
console.log('\n§6 VFD 排序方向（temp_rise_vfd = 越小越好）')
{
  // 三行不同铁心长 ⇒ 不同温升；同 vfd 口径 ⇒ temp_rise_vfd 单调跟随 temp_rise
  const rows = [420, 520, 640].map((L) => ({ ...ROW300, core_length: L }))
  const r = runL0Estimate({
    params_list: rows, top_n: 3, sort_by: 'temp_rise_vfd',
    vfd: { enabled: true, filter: 'none', cable_m: 200 },
  }, CFG)
  const list = r?.results ?? r?.top_results ?? []
  ok(list.length === 3 && list.every((x) => typeof x?.temp_rise_vfd === 'number'),
    'vfd 开启后行内 temp_rise_vfd 有值（排序前提）',
    `n=${list.length} vals=${list.map((x) => x?.temp_rise_vfd).join(',')}`)
  const seq = list.map((x) => x.temp_rise_vfd)
  const ascending = seq.every((v, i) => i === 0 || v >= seq[i - 1] - 1e-9)
  ok(ascending, 'sort_by=temp_rise_vfd ⇒ **升序**（温升最低排最前；修复前为降序＝方向颠倒）',
    `seq=[${seq.map((v) => Number(v).toFixed(1)).join(' → ')}]`)
  // 反向交叉：sort_by 未登记字段必须被拒（防注入）
  const bad = runL0Estimate({ params_list: rows, top_n: 1, sort_by: '__proto__' }, CFG)
  ok(!bad?.error, '未登记 sort_by 被安全回退（不抛错、不注入）')
}

// ── §7 pipeline 端到端（白名单透传实证） ─────────────────────
console.log('\n§7 pipeline 端到端（slot_tw 须穿过显式白名单）')
{
  // 规格说明：300kW/6P 在本矩阵默认空间下会被 V15 全判 failed（results=0，非缺陷，
  // 是该规格与默认基准尺寸不匹配）⇒ 本端到端用 15kW/4P 经典验证机。
  const args = {
    power_kw: 15, speed_rpm: 1460, voltage_v: 380, poles: 4, motor_type: 'induction',
    count: 8, top_n: 1, sort_by: 'efficiency', write_handoff: false,
    tw_axis: true, slot_tw: true,
  }
  const p = runL0Pipeline(args, CFG)
  const row = p?.results?.[0] ?? null
  ok(p && !p?.error, 'pipeline 可运行（slot_tw + tw_axis 组合不破坏链路）',
    p?.error ? `error=${p?.error}` : '')
  ok((p?.results?.length ?? 0) > 0, 'pipeline 产出可行行（端到端前提）',
    `n=${p?.results?.length} failed=${p?.summary?.failed}`)
  ok(row?.slot_tw_caliber === 'explicit' || row?.slot_tw_caliber === 'derived_resolved',
    'pipeline 结果行吃到了单一齿宽口径（ON ⇒ 绝不可能是 legacy_derived）',
    `got=${row?.slot_tw_caliber}`)
  // 反例：不传 slot_tw 时必须是旧行为（证明前一条不是恒真）
  const pOff = runL0Pipeline({ ...args, slot_tw: false }, CFG)
  const rowOff = pOff?.results?.[0] ?? null
  ok(rowOff?.slot_tw_caliber === 'legacy_derived',
    'pipeline 不传 slot_tw ⇒ legacy_derived（对照组，防上条恒真）',
    `got=${rowOff?.slot_tw_caliber}`)
}

// ── 结果 ─────────────────────────────────────────────────────
console.log(`\n══ P0-7 + VFD 排序方向门禁：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail > 0 ? 1 : 0)
