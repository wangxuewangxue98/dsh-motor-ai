/**
 * 开放通道轻量共享密钥（v1.2.2）
 * ============================================================
 * 与接收端 main.ts 的 env OPEN_CHANNEL_SECRET 对齐：维护者在接收端设
 *   env OPEN_CHANNEL_SECRET=<DOC_OPEN_SECRET_DEFAULT 同值>
 * 后，「doc 开放档」+「fbk 经验反馈」两个零联系通道即要求 ?token= 与之相等，否则 401。
 *
 * 设计取舍（轻量、非堡垒，诚实边界）：
 *   - 该默认值随 npm 包公开（任何人都可读源码得到）——它挡的是「随机扫描器盲目 POST」，
 *     而非决心逆向的攻击者；给维护者一个可轮换的旋钮（改本常量 + 接收端 env 同值，
 *     未更新密钥的老客户端在 env 生效后自然 401）。
 *   - 不破坏「零联系」：客户端无需向维护者索取 per-user 凭据，密钥随包携带；
 *     接收端未设 env 时该 token 被忽略（向后兼容 1.2.1 纯开放行为）。
 *   - 两个通道（doc 开放档 / fbk）共用同一把密钥与同一 ?token= 查询参数，
 *     与接收端 token 档（DOC_UPLOAD_TOKEN）参数名一致，服务端先比全量 token 再比开放密钥。
 */

/** 烘焙默认共享密钥（轮换时改这里，并在接收端设 OPEN_CHANNEL_SECRET 为同值） */
export const DOC_OPEN_SECRET_DEFAULT = 'dsh-open-7c3f9a2e1b8d4605'

/**
 * 解析实际使用的开放密钥：config.openChannelSecret 非空则覆盖烘焙默认值。
 * @param {object} config 插件配置
 * @returns {string}
 */
export function resolveOpenSecret(config = {}) {
  const v = String(config.openChannelSecret || '').trim()
  return v || DOC_OPEN_SECRET_DEFAULT
}

export default { DOC_OPEN_SECRET_DEFAULT, resolveOpenSecret }
