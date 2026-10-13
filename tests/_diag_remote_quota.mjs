/**
 * 一次性诊断脚本：在「另一台电脑」上运行，定位 L0 工具点击后计数不入库的原因。
 *
 * 背景：本机 txdj-001 (device_id=b52d4c51acffcb59) 计数正常；
 * 另一台电脑（截图显示 test）点击 L0 工具后 dsh_free_usage 无新记录。
 *
 * 本脚本依次打印：
 *   1. 本机 device_id（验证 hostname|platform|arch 哈希，确认是否 hostname=test）
 *   2. 本地激活态（tier 是否为 free —— 若已激活/trial，quota 网关会短路不计数）
 *   3. 后端基址（看是否指向 tailscale 地址 / 127.0.0.1）
 *   4. checkFreeQuota 真实结果（reason 字段直接给出根因）
 *
 * ⚠ 注意：第 4 步是真实调用。若本机为 free 未激活且后端可达，会把今日计数 +1
 *   （这正是验证目标）；若已激活则短路不计；若后端不可达则 fail-open 不计。
 *
 * 用法（在那台电脑上）：
 *   node _diag_remote_quota.mjs [插件源码目录，缺省 D:/dsh-motor-ai]
 */
import { pathToFileURL } from 'node:url'

const base = process.argv[2] || 'D:/dsh-motor-ai'
const fileUrl = (p) => pathToFileURL(`${base}/${p}`).href

const { getDeviceId, queryActivation } = await import(fileUrl('lib/license.mjs'))
const { checkFreeQuota } = await import(fileUrl('lib/quota.mjs'))

console.log('=== 1. 设备指纹 ===')
console.log('device_id =', getDeviceId())

console.log('\n=== 2. 本地激活态 ===')
console.log('queryActivation() =', JSON.stringify(queryActivation()))

console.log('\n=== 3. 后端基址 ===')
console.log('DSH_BACKEND_URL =', process.env.DSH_BACKEND_URL || '(未设置，缺省 http://127.0.0.1:5000)')

console.log('\n=== 4. checkFreeQuota 真实调用 ===')
const r = await checkFreeQuota({})
console.log('result =', JSON.stringify(r))
console.log('\n--- reason 判读 ---')
if (r.reason === 'activated') {
  console.log('根因 = 已激活（tier 非 free）：quota.mjs:35 短路放行，不发请求、不计数 —— 设计行为')
} else if (r.reason === 'within-quota') {
  console.log(`根因 = 正常计数：used=${r.used}/${r.limit}，DB 应有本设备记录；若 DB 没有则插件用的不是这份 device_id`)
} else if (r.reason === 'quota-exhausted') {
  console.log(`根因 = 今日额度已用尽：used=${r.used}/${r.limit}，被拦截，不再计数`)
} else if (r.reason === 'backend-unreachable-fail-open') {
  console.log('根因 = 后端不可达：fetch 失败 → fail-open 放行，不计数（网络/tailscale 问题在这里才成立）')
} else if (r.reason === 'bad-response-fail-open') {
  console.log('根因 = 后端响应异常：fail-open 放行，不计数')
}
