/**
 * motor_env_bootstrap —— L1/L2 运行环境一键自助配置
 * ============================================================
 * 在 motor_env_check 体检之后，本工具尝试自动补齐环境缺口：
 *
 *   1. 用已探测到的「基础 Python」创建 managed venv（已存在则复用）；
 *   2. 自动 pip install pyaedt==0.6.* + pywin32（解决 90% 的 L1/L2 环境缺口）；
 *   3. 探测并缓存 AEDT / Motor-CAD 路径；
 *   4. 把 venv python 写入 env-cache，后续 motor_env_check / 解算自动选用。
 *
 * 设计决策（对齐 motor_env_check）：
 *   1. 不占每日配额——自救工具，环境损坏用户必须还能自助配置。
 *   2. 无授权要求（L0 级常驻）——未激活用户同样需要配环境。
 *   3. 诚实边界：无法安装「基础 Python」与「AEDT / Motor-CAD 本体」（需管理员+大体积），
 *      仅自动化「有 Python 后装 pyaedt/pywin32」这一步，引导文案如实说明剩余手工步骤。
 */

import { bootstrapEnv, probeAll, formatProbeReport, buildEnvGuide } from '../lib/env-probe.mjs'
import { scheduleTelemetry } from '../lib/telemetry.mjs'

export const ENV_BOOTSTRAP_TOOL_NAME = 'motor_env_bootstrap'

export async function registerEnvBootstrap(ctx, config = {}) {
  ctx.tools.register({
    name: ENV_BOOTSTRAP_TOOL_NAME,
    description: `L1/L2 运行环境一键自助配置（免费、不占配额、随时可调）。
自动执行：① 用基础 Python 创建 managed venv；② pip install pyaedt==0.6.* + pywin32；
③ 探测并缓存 AEDT / Motor-CAD 路径；④ 写 env-cache 供后续自动选用。
执行后自动复检并给出体检报告 + 仍缺项的手工修复指引。

诚实边界：无法自行安装「基础 Python 解释器」与「AEDT / Motor-CAD 本体」
（需管理员权限 + 大体积下载），这两步仍须用户按引导手动完成。

适用场景：
- motor_env_check 报缺 pyaedt / pywin32 时一键补齐
- 换机器 / 重装后重建托管 venv
- 想让插件自动选用正确解释器（免去手动配 l1Python / motorcadPython）

参数: 无

返回: 自助配置结果（venv 路径 / 已装包 / 缓存路径）+ 复检体检报告`,
    parameters: {
      type: 'object',
      properties: {},
    },
    // DSH 0.1.7 硬要求：output { schema, render }，execute 必须返回 string
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      try {
        const boot = await bootstrapEnv(config)
        // 复检：bootstrap 后再跑一次体检，确认是否就绪
        const all = await probeAll(config)
        const report = formatProbeReport(all)
        const payload = {
          tool: ENV_BOOTSTRAP_TOOL_NAME,
          bootstrap: boot,
          ready: { l1: all.l1.ready, l2: all.l2.ready },
          probeReport: report,
        }
        if (!boot.ok) {
          payload.status = 'partial'
          payload.hint =
            '自助配置未完全成功。若仍缺基础 Python 或 AEDT/Motor-CAD 本体，请按下方引导手工补齐：'
          payload.guide = buildEnvGuide('all', [
            ...all.l1.missing,
            ...all.l2.missing,
          ].filter((m, i, arr) => arr.findIndex((x) => x.key === m.key) === i))
        } else {
          payload.status = 'ok'
        }
        scheduleTelemetry(config)
        return JSON.stringify(payload, null, 2)
      } catch (err) {
        scheduleTelemetry(config)
        return JSON.stringify({
          status: 'error',
          tool: ENV_BOOTSTRAP_TOOL_NAME,
          error: String(err?.message ?? err),
          hint: '自助配置自身失败（罕见）：请确认 DSH 进程有权限创建目录与启动 Python。',
        }, null, 2)
      }
    },
  })
}

export default { registerEnvBootstrap, ENV_BOOTSTRAP_TOOL_NAME }
