/**
 * 激活命令工具
 * ============================================================
 * 注册 `/dsh-motor-ai-activate` 命令，供用户在 DSH 对话中输入激活码。
 * 这是收费轨 A 的用户入口：私域收款 → 发放激活码 → 用户在插件中输入 → 激活 L1/L2。
 *
 * 验签机制：v2 非对称（Ed25519），插件内置公钥（lib/license.mjs 常量 + lib/activation-public.pem），
 * 无需任何外部密钥配置即可验签放行。
 */

import { activate, queryActivation, buildActivationGuide } from '../lib/license.mjs'

export const ACTIVATE_TOOL_NAME = 'dsh_motor_ai_activate'

/**
 * 注册激活命令
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export async function registerActivateCommand(ctx, config = {}) {
  // 可选：用配置的公钥覆盖内置公钥（密钥轮换 / 测试用）
  if (config.activationPublicKeyPem) {
    process.env.ACTIVATION_PUBLIC_KEY_PEM = config.activationPublicKeyPem
  }

  ctx.tools.register({
    name: ACTIVATE_TOOL_NAME,
    description: `激活 dsh-motor-ai 完整版（L1/L2）。
接收私域发放的激活码并写入本地状态。
激活后 motor_l1_* / motor_l2_* 工具即可使用。

参数:
  - code: 激活码（形如 v2:full:issuer:buyer:ts:exp:sig，Ed25519 签名）
  - buyer: 购买者标识（可选，覆盖激活码中的 buyer 字段）

返回:
  - success: 是否激活成功
  - tier: 激活后的层级（free/l1/l2/full）
  - guide: 未激活时的下一步指引`,
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '激活码（从作者处获取）' },
        buyer: { type: 'string', description: '购买者标识（可选）' },
      },
      required: ['code'],
    },
    async execute(params) {
      const { code, buyer } = params
      if (!code || typeof code !== 'string') {
        return {
          success: false,
          error: '请提供激活码',
          guide: buildActivationGuide('l1').guide,
        }
      }

      const result = activate(code)
      if (result.success) {
        const state = queryActivation()
        return {
          success: true,
          tier: result.tier,
          buyer: result.buyer || state.buyer,
          message: `✅ 激活成功！当前层级: ${result.tier.toUpperCase()}`,
        }
      }

      return {
        success: false,
        error: result.reason,
        guide: buildActivationGuide('l1').guide,
      }
    },
  })

  console.log(`[dsh-motor-ai] 注册激活命令: ${ACTIVATE_TOOL_NAME}`)
}

export default { registerActivateCommand, ACTIVATE_TOOL_NAME }
