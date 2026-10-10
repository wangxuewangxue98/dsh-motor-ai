# 变更日志

## [1.0.0-alpha] - 2026-10-10 — 骨架版本

### 新增
- 创建 `dsh-motor-ai` 完整版包骨架
- 支持 L0/L1/L2 三层架构
- 实现互斥检测机制（与免费版 dsh-motor-ai-l0）
- 注册 L1/L2 占位工具（带引导错误）
- 提供完整的 Config Schema

### 依赖
- `@wangxue98/dsh-motor-ai-core`: ^1.0.0（共享核心）
- `@deepseek-ai/dsh`: >=0.1.2 <0.2.0

### 状态
- L0 工具：✅ 完整实现（从 l0 包迁移）
- L1 工具：⏳ 占位符，开发中
- L2 工具：⏳ 占位符，开发中

### 升级指南
```bash
npm uninstall dsh-motor-ai-l0
npm install dsh-motor-ai
```

## [1.0.0-beta] - 待定
- [ ] 实现 L1 RMxprt 求解器
- [ ] 实现 L2 Motor-CAD COM 集成
- [ ] 完善文档和测试
