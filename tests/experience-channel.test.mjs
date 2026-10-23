/**
 * experience 通道（design_exp）打通验证
 * ============================================================
 * 背景（2026-10-24 取证）：
 *   通道此前断成两截 —— ① 落盘侧只有 l0-estimate 一处，L1/L2 完整版无落盘点；
 *   ② 上报侧 reportExperience 全仓零调用点（注释声称的 setupExperienceUpload
 *   根本不存在），样本只落盘不上报，48h 后被 gcExperience 抹掉 ⇒ 实质静默失效。
 *
 * 本用例覆盖补上的三个新导出：
 *   - normalizeDesignRow：L1/L2 异构返回 → buildDesignExp 行形状
 *   - logDesignExperience：统一落盘入口（空样本丢弃 / 开关 opt-out）
 *   - scheduleExperience：节流上报调度（opt-out / 节流窗口）
 * 以及端到端：真实 POST 到接收端 /api/dsh/experience 落 ['exp']。
 *
 * 合规断言：所有样本必须过 DESIGN_EXP_FORBIDDEN 红线扫描（身份字段零泄漏）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ⚠️ 必须在 import 被测模块**之前**改 DSH_HOME：getExperienceSink 读它定位落盘槽位
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exp-'))
process.env.DSH_HOME = TMP_HOME

const {
  normalizeDesignRow, logDesignExperience, scheduleExperience,
  buildDesignExp, scanForbidden, reportExperience,
  experienceMinIntervalMs, DESIGN_EXP_FORBIDDEN, DESIGN_EXP_SPEC_CORE,
} = await import('../lib/experience-upload.mjs')

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

const RECEIVER = 'https://dsh-motor-ai-receiver.wangxuewangxue98.deno.net/api/dsh/experience'

// ── 1) normalizeDesignRow：L1 形状（spec 用 speed_rpm/voltage_v/motorType 口径）──
console.log('\n== 1) normalizeDesignRow 适配 ==')
const l1Row = normalizeDesignRow({
  spec: { power_kw: 15, speed_rpm: 1460, voltage_v: 380, poles: 4, motorType: 'induction', cooling: 'IC411' },
  geo: { stator_od: 260, stator_id: 170, core_length: 190, air_gap: 0.55, slots_stator: 48, slots_rotor: 40 },
  out: { efficiency: 92.4, temp_rise: 62, total_loss: 780 },
})
ok(l1Row.params.speed === 1460, 'speed_rpm → params.speed 归一', JSON.stringify(l1Row.params))
ok(l1Row.params.voltage === 380, 'voltage_v → params.voltage 归一')
ok(l1Row.params.motor_type === 'induction', 'motorType → params.motor_type 归一')
ok(l1Row.params.stator_od === 260, 'geo 字段原名进入 params')
ok(l1Row.efficiency_raw === 92.4, 'efficiency → efficiency_raw 归一')
ok(l1Row.poles === undefined || l1Row.params.poles === 4, 'poles 未与 pole_pairs 混淆')

// ── 2) 红线自检：整条链路不得出现身份字段 ──
console.log('\n== 2) 合规红线（身份字段零泄漏）==')
const rec1 = buildDesignExp(l1Row, {})
const hits = scanForbidden(rec1)
ok(hits.length === 0, `scanForbidden 无命中（${DESIGN_EXP_FORBIDDEN.length} 个红线键）`, hits.join(','))
ok(rec1.spec_complete === true, '规格完整（spec_complete=true）', JSON.stringify(rec1.spec))
ok(typeof rec1.rec_id === 'string' && rec1.rec_id.length === 12, 'rec_id 为 12 位幂等键', rec1.rec_id)
ok(typeof rec1.ts === 'string' && !Number.isNaN(Date.parse(rec1.ts)), 'ts 为合法 ISO（48h GC 判据）', rec1.ts)
ok(rec1._selfcheck !== undefined, '_selfcheck 存在（落盘时被剥除）')

// ── 3) L2 降级态：confidence='low' 字符串不得当数值写入 ──
console.log('\n== 3) L2 降级态不造假 ==')
const l2Fallback = normalizeDesignRow({
  spec: { power_kw: 15, speed_rpm: 1460, voltage_v: 380, poles: 4 },
  geo: { stator_od: 260 },
  out: { confidence: 'low', efficiency: 91.0 },
})
ok(l2Fallback.confidence === undefined, "confidence='low' 字符串被拒（不写数值造假）", String(l2Fallback.confidence))
ok(l2Fallback.efficiency_raw === 91.0, '同批其它结论字段仍正常归一')

// ── 4) logDesignExperience：opt-out / 空样本丢弃 / 正常落盘 ──
console.log('\n== 4) logDesignExperience 落盘 ==')
const offCfg = { designExperienceUpload: false }
ok(logDesignExperience(offCfg, l1Row).logged === 0, '开关关 → logged=0（零副作用）')

const onCfg = { designExperienceUpload: true, experienceEndpoint: RECEIVER }
const r1 = logDesignExperience(onCfg, l1Row)
ok(r1.logged === 1, '开关开 → 正常落盘 1 条', JSON.stringify(r1))

const emptyRow = normalizeDesignRow({ spec: {}, geo: {}, out: {} })
ok(logDesignExperience(onCfg, emptyRow).logged === 0, '空样本（无规格无几何）被丢弃，不污染真值库')

const sinkFile = path.join(TMP_HOME, 'storages', 'dsh-motor-ai-l0', 'experience.jsonl')
ok(fs.existsSync(sinkFile), 'experience.jsonl 已创建', sinkFile)
const lines = fs.readFileSync(sinkFile, 'utf8').trim().split('\n')
ok(lines.length === 1, '文件内恰好 1 条（空样本未落盘）', `实际 ${lines.length} 条`)
const persisted = JSON.parse(lines[0])
ok(persisted._selfcheck === undefined, '_selfcheck 落盘前被剥除（不外发）')
ok(persisted.rec_type === 'design_exp', 'rec_type=design_exp')

// ── 5) scheduleExperience：opt-out / 节流 ──
console.log('\n== 5) scheduleExperience 节流与 opt-out ==')
ok((await scheduleExperience({ designExperienceUpload: false })).reason === 'disabled', 'designExperienceUpload 非 true → 拒绝调度')
ok(experienceMinIntervalMs({}) === 60_000, '默认节流窗口 60s')
ok(experienceMinIntervalMs({ experienceMinIntervalMs: 0 }) === 0, '显式 0 = 不节流')

// 用极大窗口强制节流，避免真实网络请求
const throttledCfg = { designExperienceUpload: true, experienceEndpoint: RECEIVER, experienceMinIntervalMs: 3_600_000 }
const s1 = await scheduleExperience(throttledCfg)
const s2 = await scheduleExperience(throttledCfg)
ok(s1.scheduled === true, '首次调度放行')
ok(s2.scheduled === false && s2.reason === 'throttled', '窗口内第二次被节流', JSON.stringify(s2))

// ── 6) 端到端：真实上报到接收端 ['exp'] ──
console.log('\n== 6) 端到端上报（真实接收端）==')
const e2eRow = normalizeDesignRow({
  spec: { power_kw: 15, speed_rpm: 1460, voltage_v: 380, poles: 4, motor_type: 'induction' },
  geo: { stator_od: 260, stator_id: 170, core_length: 190, air_gap: 0.55, slots_stator: 48, slots_rotor: 40 },
  out: { efficiency: 92.4, temp_rise: 62, total_loss: 780, verdict: 'feasible' },
})
const e2eRec = buildDesignExp(e2eRow, { pluginVersion: '0.0.0-e2e-experience' })
e2eRec.rec_id = 'e2eexp' + e2eRec.rec_id.slice(6) // 明确标记，便于审计区分
const e2eCfg = { designExperienceUpload: true, experienceEndpoint: RECEIVER, experienceMinIntervalMs: 0 }
logDesignExperience(e2eCfg, e2eRow)
const rep = await reportExperience(e2eCfg, { pluginVersion: '0.0.0-e2e-experience' })
ok(rep.reported === true, `reportExperience 上报成功（${rep.samples} 条）`, JSON.stringify(rep).slice(0, 200))
if (rep.reported) console.log(`     → rec_id=${e2eRec.rec_id}（审计时可按此前缀识别为验证样本）`)

// 清理临时目录
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
