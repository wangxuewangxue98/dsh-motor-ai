---
name: motor-design
description: 电机设计辅助技能，提供 L0 公式估算、L1 RMxprt 求解、L2 Motor-CAD 验证三档能力
metadata:
  author: Motor-AI
  version: 1.0.0-alpha
  level: l1
  tier: premium
---

# 电机设计完整版技能

## 概述

本技能提供完整的电机设计能力，包括：
- **L0 公式估算**：毫秒级，覆盖全候选池，免费可用
- **L1 RMxprt 求解**：秒级，TopN 精选，VIP 功能
- **L2 Motor-CAD 验证**：分钟级，Top3 精细，旗舰功能

## 使用前提

1. 确保已安装 `dsh-motor-ai` 完整版插件
2. 在 `cordis.patch.yml` 中配置：
   ```yaml
   plugins:
     dsh-motor-ai:
       level: l1
       l1Enabled: true
       l2Enabled: false
   ```

## 可用工具

### L0 公式通道（免费）
- `motor_param_matrix`：生成参数矩阵
- `motor_l0_estimate`：公式估算效率
- `motor_design_validate`：设计校验
- `motor_l0_pipeline`：完整 L0 流程

### L1 RMxprt（VIP）
- `motor_l1_estimate`：RMxprt 快速估算（开发中）
- `motor_l1_pipeline`：RMxprt 批量求解（开发中）
- `motor_rmxprt_solve`：单次精细求解（开发中）

### L2 Motor-CAD（旗舰）
- `motor_l2_validate`：几何一致性校验（开发中）
- `motor_motorcad_verify`：COM 精细验证（开发中）

## 升级指南

从免费版升级：
```bash
npm uninstall dsh-motor-ai-l0
npm install dsh-motor-ai
```

## 注意事项

- 完整版与免费版**互斥**，不能同时安装
- L1/L2 功能开发中，当前仅 L0 可用
