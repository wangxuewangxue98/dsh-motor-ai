/**
 * 工具：motor_upload_doc —— 整篇文档分块回传（doc 通道，v1.2.1）
 * ===========================================================
 * 定位：客户端「收集的资料 / 整理的文件」需要**完整原样**回传时，用本工具把
 * 整篇文档（md/txt/代码/JSON/图片/PDF）分块发回接收端（/api/dsh/doc-upload），
 * 落 ['doc']，维护者经 export 拉取重组还原原文件。
 *
 * 与 motor_submit_experience 的分工（勿混用）：
 *   - motor_submit_experience：**蒸馏后的经验条目**（一条一个知识点；进 ['fbk'] →
 *     策展 → ['kb']，design-assist 可检索注入）
 *   - 本工具：**完整原文件传输**（进 ['doc']，字节级还原留档，不进检索库）
 *
 * 设计要点：
 *   - 贡献型工具，不调用任何估算 / 校验函数，**不消耗免费额度**。
 *   - fire-and-forget：上传失败只返回友好提示，绝不阻断用户主流程。
 *   - 默认需 docUploadEnabled=true 才真正外发；否则仅提示开启开关。
 *   - 无需 token 即可上传（接收端开放档，单文档 ≤32 块 ≈1.1MB；配置 docUploadToken
 *     可解锁 512 块）——**零联系自主回传**。
 *   - ⚠️ 文件内容原样传输、不做脱敏扫描：调用前请自行确认文档不含不宜外发的
 *     敏感内容（本工具定位就是「完整原样」）。
 */

import { uploadDocument } from '../lib/doc-upload.mjs'
import { getUsageSink, logUsage } from '@wangxue98/dsh-motor-ai-core'

export const DOC_UPLOAD_TOOL_NAME = 'motor_upload_doc'

/** 工具入参声明 */
export const TOOL_PARAMS = {
  file_path: {
    type: 'string',
    description: '要回传的本地文件绝对路径（必填）：md/txt/代码/JSON 走文本通道，图片/PDF 等自动 base64',
  },
  doc_id: {
    type: 'string',
    description: '文档 ID（可选，6~64 位字母数字-_；缺省自动生成）。同一文档补传/分批时用相同 ID',
  },
  source_ref: {
    type: 'string',
    description: '来源说明（可选，仅记录在结果消息里供会话留存）：如「收集的某技术手册第 3 章」',
  },
}

/**
 * 纯函数：组装上传调用（不触额度）。
 * @returns {Promise<{ status: 'uploaded'|'skipped'|'error', message: string, doc_id?: string }>}
 */
export async function runUploadDocument(args, config = {}) {
  const t0 = Date.now()
  const filePath = String(args?.file_path || '').trim()
  if (!filePath) {
    return { status: 'error', message: '缺少 file_path 参数：请提供要回传的本地文件绝对路径。' }
  }
  const res = await uploadDocument(config, filePath, { docId: args?.doc_id })
  if (res.uploaded) {
    logUsage(getUsageSink(config), {
      tool: 'motor_upload_doc', ok: true, elapsed_ms: Date.now() - t0, n: 1,
    })
    return {
      status: 'uploaded',
      doc_id: res.doc_id,
      message: `文档已完整回传（${res.bytes} 字节，${res.chunks} 块，doc_id=${res.doc_id}）。`
        + '维护者取回重组后即为原文件。'
        + (args?.source_ref ? ` 来源：${args.source_ref}` : ''),
    }
  }
  if (res.reason === 'disabled' || res.reason === 'no-endpoint') {
    return {
      status: 'skipped',
      message:
        '文档回传通道当前未启用：请在插件配置中设置 docUploadEnabled: true'
        + '（并保留 commerceBackendUrl 或显式填 docUploadEndpoint）。开启后可自主回传，无需联系维护者。\n'
        + '文件未受影响，可开启后重新上传。',
    }
  }
  if (res.reason === 'too-large') {
    return {
      status: 'error',
      message: `文件过大：${res.message ?? ''}（当前分块 ${res.chunks}）`,
    }
  }
  if (res.reason === 'file-unreadable') {
    return { status: 'error', message: `文件不可读：请确认路径存在且有读取权限（${filePath}）。` }
  }
  return {
    status: 'error',
    message: `上传未成功（${res.reason ?? 'unknown'}）。文件未受影响，可在网络恢复后重试。`,
  }
}

/**
 * 工具注册（薄封装，动态 import 保证离线可加载）
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export async function registerDocUploadTool(ctx, config = {}) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  ctx.tools.register(defineTool({
    name: DOC_UPLOAD_TOOL_NAME,
    description:
      '把整篇文档（md/txt/代码/JSON/图片/PDF）**完整原样**回传到 dsh-motor-ai 维护端（doc 通道）。\n'
      + '当你为用户收集 / 整理出了成篇的资料或报告文件，且用户希望这些文件完整回到维护者手里时，\n'
      + '用本工具逐个上传（自动分块，文本/二进制通吃，无需任何 token，零联系自主回传）。\n'
      + '分工：蒸馏后的经验教训请用 motor_submit_experience（进知识库可检索）；\n'
      + '本工具传完整原文件（留档还原，不进检索库）。\n'
      + '贡献型工具，不消耗免费额度。⚠️ 文件原样传输不做脱敏——上传前请确认内容可外发。\n'
      + '⚠️ 需先在插件配置开启 docUploadEnabled: true（默认关闭，opt-in）才真正外发。',
    parameters: TOOL_PARAMS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        return JSON.stringify(await runUploadDocument(args, config), null, 2)
      } catch (err) {
        return JSON.stringify({ status: 'error', message: String(err?.message ?? err) }, null, 2)
      }
    },
  }))
}

export default { runUploadDocument, registerDocUploadTool, TOOL_PARAMS, DOC_UPLOAD_TOOL_NAME }
