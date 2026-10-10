# dsh-motor-ai

电机设计完整版插件（L1/L2），基于 DeepSeek Harness (DSH) 框架。

## 架构

```
dsh-motor-ai-core      ← 共享核心（公式引擎、代理模型、经验回灌等）
├── dsh-motor-ai-l0    ← 免费版（L0 公式通道）
└── dsh-motor-ai       ← 完整版（L0 + L1 RMxprt + L2 Motor-CAD）
```

## 安装

```bash
# 完整版（需先卸载免费版）
npm uninstall dsh-motor-ai-l0
npm install dsh-motor-ai
```

## 配置

在 `cordis.patch.yml` 中：

```yaml
plugins:
  dsh-motor-ai:
    level: l1        # l0 / l1 / l2
    l1Enabled: true  # 启用 RMxprt 求解
    l2Enabled: false # Motor-CAD 暂不启用
```

## 工具

| 层级 | 工具 | 描述 | 状态 |
|------|------|------|------|
| L0 | motor_param_matrix | 参数矩阵生成 | ✅ |
| L0 | motor_l0_estimate | 公式效率估算 | ✅ |
| L0 | motor_design_validate | 设计校验 | ✅ |
| L0 | motor_l0_pipeline | L0 全流程 | ✅ |
| L1 | motor_l1_estimate | RMxprt 估算 | ⏳ |
| L1 | motor_l1_pipeline | RMxprt 批处理 | ⏳ |
| L1 | motor_rmxprt_solve | RMxprt 单解 | ⏳ |
| L2 | motor_l2_validate | 几何校验 | ⏳ |
| L2 | motor_motorcad_verify | COM 验证 | ⏳ |

## 互斥规则

- 完整版与免费版**不能同时安装**
- 升级时需先 `npm uninstall dsh-motor-ai-l0`

## 开发

```bash
# 运行验证
npm run verify

# 运行测试
npm test

## 激活（L1/L2 解锁）

`dsh-motor-ai` 按 **PolyForm-Noncommercial-1.0** 分发：非商业免费装；商业使用需激活码（收费墙是许可约束，不是代码锁）。

### 分层与状态

| 层 | 工具 | 状态 |
|----|------|------|
| L0 | `motor_param_matrix` / `motor_l0_estimate` / `motor_design_validate` / `motor_l0_pipeline` | ✅ 免费即用 |
| L1 | `motor_l1_estimate` / `motor_l1_pipeline` / `motor_rmxprt_solve` | 🔒 需激活 |
| L2 | `motor_l2_validate` / `motor_motorcad_verify` | 🔒 需激活 |

### 分级启用

在 `cordis.patch.yml`（DSH profile）中：

```yaml
plugins:
  dsh-motor-ai:
    level: l1          # l0 / l1 / l2
    l1Enabled: true    # 启用 RMxprt 求解
    l2Enabled: false   # Motor-CAD 暂不启用
```

默认 `level: l0`，仅 L0 免费工具可用。

### 激活流程

1. 向作者获取激活码（私域渠道，形如 `v2:full:wangxue98:<buyer_b64>:<ts>:<exp>:<sig128>`）
2. 在 DSH 对话中运行命令：`/dsh-motor-ai-activate <code>`
3. 回显 `✅ 激活成功！当前层级: FULL`，`motor_l1_*` / `motor_l2_*` 即解锁
4. 激活状态落盘 `$DSH_HOME/storages/dsh-motor-ai/activation.json`
5. 未激活时调 L1/L2：返回 `requires_activation` 引导（不会崩）

### 作者自测签码（非对称 Ed25519）

激活码用 **Ed25519 非对称签名**：公钥随包发布，私钥作者自持。

```bash
# 1) 生成密钥对：公钥写 lib/activation-public.pem（随包），私钥写 .secrets/activation-private.pem（绝不入库/不随包）
node scripts/mint-activation-code.mjs --genkey --write-secret

# 2) 签发 full 测试码（私钥来源：--key > ACTIVATION_PRIVATE_KEY 环境变量 > .secrets/activation-private.pem）
node scripts/mint-activation-code.mjs --type full --issuer wangxue98 --buyer 15389089358@163.com
# 输出形如 v2:full:wangxue98:<b64>:<ts>:<exp>:<128hex-sig>
```

把上一步的码在 DSH 对话里 `/dsh-motor-ai-activate <code>` 即可解锁。

### 非对称验签机制

- **v2（默认）**：Ed25519。发布包内置公钥（`lib/license.mjs` 常量 + `lib/activation-public.pem`），部署出去即可验签，**外部买家可被真实放行**；私钥仅作者持有，用于签码。
- **密钥隔离**：私钥在 `.secrets/`（`.gitignore` 排除，且不在 `package.json` 的 `files` 白名单），**不会进入 npm 发布包**；公钥公开，随包无泄露风险。
- **v1（兼容）**：旧的 HMAC 对称码（`ACTIVATION_HMAC_KEY`）仍可验，但已废弃，新签码一律 v2。

### 端到端自检

```bash
node scripts/_activate_selftest.mjs   # 临时 DSH_HOME 隔离，覆盖未激活拦截/签发激活/降档/伪造/篡改/过期/格式容错
```
```
