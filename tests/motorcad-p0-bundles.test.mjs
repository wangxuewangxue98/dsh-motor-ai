/**
 * P0 反馈联系束 + P0 齿宽/sanity 束 测试
 * 运行：node tests/motorcad-p0-bundles.test.mjs
 * 原则：纯本地、不发网络请求、不启动 Motor-CAD/AEDT。
 *   - 反馈束：L2 三失败分支 report 字段 / env-not-ready 回传 action /
 *     formatProbeReport 联系行 / motor_report_issue 反馈稿（不含激活码）。
 *   - 齿宽/sanity 束：tooth_width 映射 + buildMeshPrecheck 三态 +
 *     extractRatedPowerW 穷举 + bridge _sanity_gate（直接 import 函数行为）。
 */
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MOTORCAD_PARAM_CANDIDATES, buildMeshPrecheck, extractRatedPowerW,
  buildL2ReportField, expandDesignParams,
} from '../tools/l2/motorcad-verify.mjs'
import { buildIssueReport, REPORT_ISSUE_TOOL_NAME } from '../tools/report-issue.mjs'
import { formatProbeReport, probeAll } from '../lib/env-probe.mjs'

let passed = 0
let failed = 0
const failures = []
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`✅ ${name}`) }
  else { failed++; failures.push(name); console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

const here = join(fileURLToPath(import.meta.url), '..', '..')

// ---------- 1) 反馈束：参数映射 ----------
ok(MOTORCAD_PARAM_CANDIDATES.tooth_width?.includes('Tooth_Width'),
  'candidates 含 tooth_width → Tooth_Width 映射')
const expanded = expandDesignParams({ tooth_width: 21 })
ok(expanded.Tooth_Width === 21, 'expandDesignParams 透传 tooth_width → Tooth_Width')

// ---------- 2) 反馈束：buildL2ReportField ----------
const rep = buildL2ReportField({ reason: 'timeout' })
ok(rep.contact === '13546196530@163.com', 'report.contact 为作者邮箱')
ok(Array.isArray(rep.how) && rep.how.length >= 3 && rep.how.some((s) => s.includes('motor_env_check')),
  'report.how 指引含"附 motor_env_check 报告"')
ok(rep.how.some((s) => s.includes('timeout')), 'report.how 带出错 reason 尾注')

// ---------- 3) 反馈束：env-probe 联系行 ----------
const all = await probeAll({})
const reportText = formatProbeReport(all)
ok(reportText.includes('13546196530@163.com'), 'formatProbeReport 尾部含联系邮箱')
ok(reportText.includes('motor_report_issue'), 'formatProbeReport 引导到 motor_report_issue')

// ---------- 4) 反馈束：反馈稿组装（无敏感泄漏） ----------
ok(REPORT_ISSUE_TOOL_NAME === 'motor_report_issue', '工具名 motor_report_issue')
const issueText = await buildIssueReport({ errorSummary: '报错原文示例', toolName: 'motor_motorcad_verify' })
ok(issueText.includes('== dsh-motor-ai 问题反馈稿 =='), '反馈稿含标题')
ok(issueText.includes('13546196530@163.com'), '反馈稿含邮箱')
ok(issueText.includes('报错原文示例'), '反馈稿含用户错误摘要')
ok(issueText.includes('== 环境体检'), '反馈稿含环境体检段')
ok(!/v2:[A-Za-z0-9+/_-]{20,}/.test(issueText), '反馈稿不含激活码密文')

// ---------- 5) 齿宽束：buildMeshPrecheck 三态 ----------
const m1 = buildMeshPrecheck({ stator_od: 677, slots: 18 })
ok(m1.warnings.length === 1 && m1.warnings[0].includes('tooth_width'),
  '缺齿宽 → 提示显式提供（BUG11 防线）')
const m2 = buildMeshPrecheck({ stator_bore: 600, slots: 18, tooth_width: 120 })
ok(m2.warnings.some((w) => w.includes('≥ 齿距')), '齿宽 ≥ 齿距 → 几何不可能告警')
const m3 = buildMeshPrecheck({ stator_od: 677, slots: 18, tooth_width: 21 })
ok(m3.warnings.length === 0, '合理齿宽 → 零误报')
ok(m3.checked.tooth_width === 21 && m3.checked.slots === 18, 'checked 回显输入值')
ok(buildMeshPrecheck({}).warnings.length === 0, '空设计 → 不误报')

// ---------- 6) 齿宽束：Motor-CAD 原名入参兼容 ----------
const m4 = buildMeshPrecheck({ Stator_Bore: 600, Slot_Number: 18, Tooth_Width: 300 })
ok(m4.warnings.some((w) => w.includes('≥ 齿距')), 'Motor-CAD 原名入参同样被预检')

// ---------- 7) sanity 束：extractRatedPowerW ----------
ok(extractRatedPowerW({ rated_power: 450000 }) === 450000, '顶层 rated_power (W)')
ok(extractRatedPowerW({ spec: { power_kw: 200 } }) === 200000, 'spec 嵌套 power_kw ×1000')
ok(extractRatedPowerW({ P_N: 15000 }) === 15000, 'P_N 变体')
ok(extractRatedPowerW({}) === null, '无功率字段 → null')
ok(extractRatedPowerW({ rated_power: -5 }) === null, '负值/非法 → null')

// ---------- 8) sanity 束：bridge _sanity_gate（import Python 不可行，行为经门禁 6h 静态断言） ----------
// 这里用源码断言兜底：gate 逻辑必须写 result_warning / result_trusted 且消费 rated_power_w
const pysrc = readFileSync(join(here, 'scripts', 'motorcad_bridge.py'), 'utf8')
ok(pysrc.includes('def _sanity_gate'), 'bridge 定义 _sanity_gate')
ok(pysrc.includes('result["result_trusted"] = False') && pysrc.includes('result["result_warning"] = sw'),
  'bridge 异常时写 result_warning/result_trusted=False')
ok(pysrc.includes('req.get("rated_power_w")'), 'bridge 消费 rated_power_w')
ok(pysrc.includes('eff < 10.0'), '效率阈值 10% 落码')
ok(pysrc.includes('inp > rated_w * 10'), 'InputPower 超额定 10 倍判定落码')
// rc.15：损耗维度防线（求解空转时功率同为 0 ⇒ 判据 1/2 双双失效，靠此拦住）
ok(pysrc.includes('CORE_LOSS_VARS'), 'bridge 定义 CORE_LOSS_VARS（关键损耗字段集）')
ok(pysrc.includes('关键损耗字段全 0'), '「关键损耗字段全 0」判定落码')
ok(pysrc.includes('LOSS_ZERO_EPS'), '损耗零容差 LOSS_ZERO_EPS 落码')
{
  // 字段名自带 "]"（Loss_[Total]），必须锚定行首的 ] 作为列表结束符
  const coreBlock = (pysrc.match(/CORE_LOSS_VARS = \[[\s\S]*?\n\]/) || [''])[0]
  ok(coreBlock.includes('Loss_[Stator_Copper]') && coreBlock.includes('Loss_[Total]'),
    'CORE_LOSS_VARS 含定子铜耗与总损耗')
  for (const banned of ['Loss_[Rotor_Copper]', 'Loss_[Magnet]', 'Loss_[Windage]', 'Loss_[Stray_Load]']) {
    ok(!coreBlock.includes(banned), `CORE_LOSS_VARS 未误纳 ${banned}（合法工况可为 0）`)
  }
}

// ---------- 9) JS 侧承载 sanity 结果 ----------
const verifySrc = readFileSync(join(here, 'tools', 'l2', 'motorcad-verify.mjs'), 'utf8')
ok(verifySrc.includes('result_trusted: res.result_trusted ?? null'), '成功返回携带 result_trusted')
ok(verifySrc.includes('result_warning: res.result_warning || []'), '成功返回携带 result_warning')
ok(verifySrc.includes('return=0 ≠ 结果可信'), 'notes 明示 return=0≠可信')
ok((verifySrc.match(/report: buildL2ReportField\(/g) || []).length === 3,
  '三失败分支（env_not_ready/fallback/error）均挂 report')
ok(verifySrc.includes('action: guide.action'), 'env-not-ready 回传 action（邮箱不再被丢弃）')

// ---------- 10) 注册接线 ----------
const idxSrc = readFileSync(join(here, 'index.mjs'), 'utf8')
ok(idxSrc.includes("from './tools/report-issue.mjs'"), 'index.mjs import report-issue')
ok(/await registerReportIssue\(ctx, config\)/.test(idxSrc), 'registerAll 调用 registerReportIssue')
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'))
ok(manifest.tools.includes('motor_report_issue'), 'manifest 声明 motor_report_issue')

// ---------- 汇总 ----------
console.log(`\n=== ${passed} passed, ${failed} failed ===`)
if (failed) {
  console.error('失败项:', failures.join(' | '))
  process.exit(1)
}
