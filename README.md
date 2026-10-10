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
```
