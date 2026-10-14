# dsh-motor-ai

电机设计完整版插件（L1/L2），基于 DeepSeek Harness (DSH) 框架。

## 架构

```
dsh-motor-ai-core      ← 共享核心（公式引擎、代理模型、经验回灌等）
├── dsh-motor-ai-l0    ← 免费版（L0 公式通道）
└── dsh-motor-ai       ← 完整版（L0 + L1 RMxprt + L2 Motor-CAD）
```

## 安装

**方式一：DSH 界面直装（不走市场）**

DSH Desktop →「添加和管理插件」→ 输入框填：

```
dsh-motor-ai@1.0.0-rc.7
```

> - **必须带 `@版本`**：安装器用 `spec.lastIndexOf('@')` 切分包名与版本，纯包名会把版本算错。
> - 也可填 GitHub 仓库地址（需仓库真实存在）或本地目录路径。
> - full 与 `dsh-motor-ai-l0` **互斥**，安装前请先在「已安装」里卸载 l0。
> - 本插件自带组合包配置（`package.json` 的 `dsh.bundle.patch` → `./cordis.patch.yml`），
>   这是 DSH 界面能识别并安装它的前提。

**方式二：命令行**

```bash
# 完整版（需先卸载免费版，两者互斥）
npm uninstall dsh-motor-ai-l0
npm install dsh-motor-ai@next
```

> **当前版本口径**：`latest` = `1.0.0-beta`；`1.0.0-rc.7` 为预发布，走 `next` 标签。
> 稳定版发布后 `@next` 可省略。

## 配置

插件**自带**的默认配置在包内 `cordis.patch.yml`（由 `package.json` 的 `dsh.bundle.patch` 声明）。
用户级覆盖写在 **profile 的** `cordis.patch.yml` 里，按 `id` 覆盖 `config`：

```yaml
- id: dsh-motor-ai
  config:
    level: l2        # l0 / l1 / l2
    l1Enabled: true  # 启用 RMxprt 求解
    l2Enabled: false # Motor-CAD 暂不启用
```

> 无论 `level` 如何设置，**L0 永久免费可用**；L1/L2 工具恒注册，**调用时**按激活码门控。

## 工具

| 层级 | 工具 | 描述 | 状态 |
|------|------|------|------|
| L0 | motor_param_matrix | 参数矩阵生成 | ✅ |
| L0 | motor_l0_estimate | 公式效率估算 | ✅ |
| L0 | motor_design_validate | 设计校验 | ✅ |
| L0 | motor_l0_pipeline | L0 全流程 | ✅ |
| L1 | motor_l1_estimate | RMxprt 估算 | ⚙️ 随包分发，需本机 AEDT |
| L1 | motor_l1_pipeline | RMxprt 批处理 | ⚙️ 随包分发，需本机 AEDT |
| L1 | motor_rmxprt_solve | RMxprt 单解 | ⚙️ 随包分发，需本机 AEDT |
| L2 | motor_l2_validate | 几何校验 | ⚙️ 随包分发，需本机 Motor-CAD |
| L2 | motor_motorcad_verify | COM 验证 | ⚙️ 随包分发，需本机 Motor-CAD |

> **求解器依赖说明（rc.11 起）**：L1/L2 的求解器脚本已随包分发（`scripts/_rmxprt_venv_worker.py` / `scripts/motorcad_bridge.py`），装完即可用；但**本机仍需安装对应商业求解器**：
> - **L1**：Ansys AEDT 2020.x（RMxprt）+ Python 3.10 环境装有 `pyaedt 0.6.x` 或 `pywin32`；解释器路径用 `PYTHON_BIN` 指定，worker 可用 `RMXPRT_WORKER_PATH` 覆盖（默认用包内副本）
> - **L2**：Motor-CAD v11.1.5（`MotorCAD.AppAutomation`）+ Python 3.10 环境装有 `pywin32`；路径用 `MOTORCAD_PATH` / `MOTORCAD_INSTALL_DIR` 指定
> 未装求解器时调用返回结构化错误引导，不影响 L0。

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
5. 未激活时调 L1/L2：返回 `LICENSE_REQUIRED` 结构化引导（含联系邮箱，不会崩，L0 照常可用）

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

## 商业授权

本插件按 **PolyForm Noncommercial 1.0** 许可分发：个人及非商业用途可免费使用；商业用途需获取商业授权。

- **L0（公式通道）对所有用户永久免费，无需激活码。**
- L1（RMxprt）/ L2（Motor-CAD）为完整版付费层，需激活码解锁。
- 激活码**只锁 L1/L2，绝不锁 L0**；无码、码过期或码无效时，插件照常加载、L0 全部可用，仅在调用 L1/L2 时返回引导。

商业授权报价与采购，请联系：**13546196530@163.com**
```
