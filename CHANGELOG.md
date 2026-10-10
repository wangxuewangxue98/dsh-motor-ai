## [1.0.0-rc.6] - 2026-10-11

### Fixed
- **修复"装得上、启用报故障"第三层**：入口 `pluginEntry`（async）`return` 普通对象，
  cordis 把插件 apply 的返回值当作 effect，只接受 disposer 函数或 null/undefined；
  async 入口 resolve 成对象会走 `effect.then(safeCollect)` ⇒
  `TypeError: Invalid effect at safeCollect`（界面：`1 entry did not activate dsh-motor-ai (dsh-motor-ai)`，
  同时提示"当前插件 v1.0.0-rc.5 已是 latest 或更高版本，仍阻挡启动"）。
  改为**不返回值**；需要 `registered/skipped/activation` 信息的外部脚本请用命名导出 `registerAll()`。
- `scripts/verify.mjs` 新增**门禁 F**：复刻 cordis `_execute`（lib/index.js:1135-1167）判定路径，
  运行时校验入口 apply 返回值必须是函数 / null / undefined（已用 rc.5 破坏样本反向验证：FAIL→PASS）。

## [1.0.0-rc.5] - 2026-10-11

### Fixed
- activate/L1/L2 五工具补 DSH 0.1.7 硬要求的 output { schema, render } 声明；
  execute 统一返回 JSON 字符串（与 l0 工具同形态）。修复启动报
  tool "..." must declare output { schema, render, presentationMeta? }。

# 变更日志

## [1.0.0-rc.3] - 2026-10-11 — 支持在 DSH 界面直接安装（补「组合包」声明）

### 修复
- **补 `dsh.bundle.patch` 组合包声明**：此前 `dsh-motor-ai` 的 `package.json` 没有 `dsh` 字段，
  DSH Desktop「添加和管理插件」会判为 `not-bundle`，报
  `installProblemNotBundle`（"这个包没有声明组合包，无法作为插件安装"），
  导致**无法在 DSH 界面一键安装**（只能绕过 UI 手工注入 generation）。
  - 新增 `cordis.patch.yml`（插件自带默认配置：`level: 'l2'`、`l1Enabled`/`l2Enabled: true`、
    `activationPublicKeyPem` 占位、L0 运行参数、遥测默认全关）
  - `package.json` 增 `dsh.bundle.patch` + `dsh.compatibility`（`dsh >=0.1.2 <0.2.0`、`node >=22`）
  - `exports` 暴露 `./cordis.patch.yml` 与 `./package.json`；`files` 白名单纳入 `cordis.patch.yml`

### 安装方式（DSH 界面直装，不走市场）
DSH Desktop →「添加和管理插件」→ 输入框填 **`dsh-motor-ai@1.0.0-rc.3`** → 安装。
- **必须带 `@版本`**：安装器用 `spec.lastIndexOf('@')` 切分包名与版本，纯包名会把版本算错。
- 也可填 GitHub 仓库地址（需仓库真实存在）或本地目录路径。
- full 与 `dsh-motor-ai-l0` 互斥，安装前请先卸载 l0。

## [1.0.0-rc.2] - 2026-10-10 — L1/L2 惰性门禁落地（激活码只锁 L1/L2，L0 永不锁）

### 变更（架构原则）
- **L1/L2 工具恒注册**：删除 `guideOnly` 注册门禁（`index.mjs` / `tools/l1/index.mjs` / `tools/l2/index.mjs`）。此前无激活码时 L1/L2 工具**根本不注册**，用户调不到也就看不到任何引导；现在恒注册，授权检查推迟到 `execute` 首行
- **`buildActivationGuide()` 返回体升级**：`error: 'LICENSE_REQUIRED'` + `message` + `action.contact`（联系邮箱 `13546196530@163.com`）；保留 `status` / `guide` 旧字段，`tools/activate.mjs` 读 `.guide` 不受影响
- `package.json` keywords 首位补 `dsh-plugin`（与 l0 对齐，供市场扫描器识别）
- README 新增「商业授权」章节：L0 永久免费、激活码只锁 L1/L2、商业授权联系邮箱

### 设计口径（诚实底线）
- 无码 / 码过期 / 码无效 ⇒ 插件照常加载、**L0 全部可用**、L1/L2 返回结构化引导而非崩溃（`level-gate.mjs:44` `l0` 恒 `true`）
- 门控为 honor-system 商业约定，非硬隔离

## [1.0.0-rc] - 2026-10-10 — 激活机制升级：非对称 Ed25519 验签

### 变更
- 激活码由对称 HMAC（v1）升级为**非对称 Ed25519（v2）**：公钥随包发布（`lib/activation-public.pem` + `lib/license.mjs` 内置常量），私钥作者自持（`.secrets/activation-private.pem`，绝不入库/不随包）
- 部署后的公开包**内置公钥即可验签**，外部买家可被真实放行（修复 beta 的「激活服务不可用」根因）
- `scripts/mint-activation-code.mjs` 改用 Ed25519 私钥签 v2 码
- `scripts/_activate_selftest.mjs` 适配 v2（私钥签码 + 伪造/篡改/过期断言）

### 修复
- 去除对 `ACTIVATION_HMAC_KEY` 环境变量的硬依赖（v2 无需任何外部密钥配置即可验签放行）
- `index.mjs` CONFIG_SCHEMA：`activationHmacKey` → `activationPublicKeyPem`（可选覆盖公钥，仅密钥轮换/测试用）

## [1.0.0-beta] - 2026-10-10 — 激活机制（收费轨 A）

### 新增
- **激活门控**：L1/L2 工具 execute 前经 `checkActivation()` 检查，未激活返回引导而非直接执行；L0 恒免费可用
- **`lib/license.mjs`**：HMAC-SHA256 离线签码/验码 + 本地持久化（`$DSH_HOME/storages/dsh-motor-ai/activation.json`），零运行时依赖
- **`tools/activate.mjs`**：`dsh_motor_ai_activate` 命令，用户在 DSH 对话中输码解锁 L1/L2
- **`scripts/mint-activation-code.mjs`**：离线签码基建（`--genkey` 生成密钥 / 按 type+issuer+buyer+valid-days 发码，支持 `--json` 批量）
- **`scripts/_activate_selftest.mjs`**：21 项端到端自检（临时 DSH_HOME 隔离，覆盖未激活拦截/签发激活/降档/错密钥/篡改/过期/格式容错）
- index.mjs 注册激活命令 + 导出 license API + CONFIG_SCHEMA 增 `activationHmacKey` + 启动打印激活状态

### 设计口径（诚实底线）
- 门控为 honor-system 商业约定，非硬隔离（插件运行于用户机器，可绕过）；商业约束靠 PolyForm-NC 许可 + 逆向威慑
- 激活码冒号安全编码：`v1:TYPE:ISSUER:BUYER_b64url:TS_SEC:EXP_SEC:HMAC`（buyer base64url、时间戳用 epoch 秒，规避 ISO 时间戳含冒号导致的 split 错位）

### 修复
- `lib/license.mjs`：Windows 跨平台路径（`dirname` 替代 `lastIndexOf('/')`）
- L1/L2：L2 的 `require('node:fs')` ESM 崩溃已在 alpha 修复，本次确认保持

### 状态
- 激活机制：✅ 自检 21/21 通过
- L0：✅ 完整（免费）；L1/L2：门控已接，底层求解仍为占位/COM 骨架

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
