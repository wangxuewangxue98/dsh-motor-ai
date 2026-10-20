## [1.0.0-rc.22] - 2026-10-20

### Fixed
- **修复 submit_resolved_case 致插件重启激活失败（严重）**：rc.20 起该工具
  `output.schema` 为裸 `{ type: 'object' }`，真实 dsh-tools 的 value schema 编译器
  对 object 分支硬要求显式 `additionalProperties`（"additionalProperties must be
  explicitly true or false"），`defineTool` 注册即抛 authorError → registerAll 抛 →
  cordis fiber FAILED → 「更新后的组合无法启动」。安装阶段只验 patch entry list
  结构、不 import 插件模块，故表现为「安装正确、重启报故障」。
  修复：schema 改回 `{ type: 'string' }`、execute 返回 JSON 字符串、render 直出
  （与全仓其余 13 工具一致，兼容各代 DSH 契约）。
- `scripts/verify.mjs` 新增「defineTool output schema 防线」：静态复检全部工具文件，
  `schema:` 指向的 object 缺 additionalProperties 即门禁失败（防回归）。

### Verified
- 客户端真实 dsh-tools（DSH 0.12.0 内置版）冒烟：修复前 THROW / 修复后 REGISTER OK
  （单变量对照）；execute 返回 string；verify 全量门禁通过

## [1.0.0-rc.21] - 2026-10-20

### Fixed
- **严重（rc.18 → rc.20 直升必现升级失败）**：`cordis.patch.yml` 中 `telemetryEndpoint`
  重复键致客户端判补丁无效、升级失败并自动回滚（报错「patch file is not a valid entry list」）。
  - 根因：rc.20（commit `052b8cb`）新增 receiver URL 键时未删除原空值键，同一 mapping 出现
    两个 `telemetryEndpoint`；YAML 规范禁止重复键，DSH 客户端插件管理器
    （dsh-plugin-manager）以 `yaml@2` 默认 `uniqueKeys` 严格模式解析补丁，抛
    "Map keys must be unique"，即上报补丁非法。
  - 修复：删除空值键，仅保留已接通官方 receiver 的 URL 值——与 rc.20 宽松解析下的实际
    生效值一致，运行行为零变化；l0 版补丁经同款解析器复检无重复键，未受影响。

### Added
- **防复发门禁**：`scripts/verify.mjs` 新增「YAML 严格解析（重复键防线）」一节，以客户端
  同款 `yaml@2` 解析器复检全部仓库 YAML：重复键硬失败，其余语法问题仅告警不拦截。
  `yaml` 加入 devDependencies。

### Tests
- `scripts/verify.mjs` 门禁全过（含新增重复键防线）。
- `yaml@2.9.1`（客户端 `yaml@^2.9.0` 同大版本）严格解析 `cordis.patch.yml` 通过。

## [1.0.0-rc.20] - 2026-10-20

### Added
- **P1-B 已解决问题回流（完整版）**：新增贡献型工具 `submit_resolved_case`（**不占免费额度**）。
  用户在插件里把问题解决后，可将「问题分类 / 症状 / 根因 / 改进措施 / 解决过程」回传接收端
  `/api/dsh/issue-resolved`，喂在线知识库。新增 `lib/issue-resolved.mjs`（字段白名单 +
  身份类字段硬排除 + fire-and-forget 不阻塞主流程）与 `tools/l0/issue-resolved-tool.mjs`；
  `index.mjs` 注册并新增配置 `issueResolvedEnabled`（**默认 false**，显式开启才外发）、
  `issueResolvedEndpoint`（空 = 由 `commerceBackendUrl` 自动派生）。
- **P1-C 在线知识库入口**：新增配置 `knowledgeBaseUrl`；配置后，免费额度用尽文案与
  `submit_resolved_case` 提示自动带「先查知识库」链接。`cordis.patch.yml` 已填入公开导航页
  `https://www.workbuddy.link/p/xWcD0qQyCUoGVl98S2LHei`（免登录可访问）。

### Fixed
- **额度账 plugin_id 错配**：`quotaPluginId` 默认由 `dsh-motor-ai-l0` 改为 `dsh-motor-ai-full`。
  此前完整版与免费版共用 l0 一本账，制作者侧无法区分用量来源；现分桶记账。
- **经验回传端点恒空（静默不回传）**：`lib/experience-upload.mjs` 新增
  `resolveExperienceEndpoint()`，未显式配置 `experienceEndpoint` 时由 `commerceBackendUrl`
  派生 `/api/dsh/experience`。

### Tests
- `scripts/verify.mjs` 门禁全过（14 工具 output 声明 / apply 契约 / 双通道激活闭环 / 额度闸门）。
- 新增 `tests/p1bc-issue-resolved.test.mjs` 与 `e2e_full_issue_resolved.mjs`（完整版端到端 8/8）。

## [1.0.0-rc.19] - 2026-10-17

### Changed
- **依赖 core 1.0.0 → 1.4.0**（P0 四项判定口径修正）：
  - 磁密口径统一（主指标与门禁 V08 同走实际匝口径）；
  - V08 补 1.7T 严重档（>1.9T 仍 failed，判据未放宽）；
  - 工程槽满率真实化（扣槽绝缘/槽楔/槽形系数、含漆膜），旧净/毛口径实测仅 0.17~0.42 ⇒ 系统性漏判；
  - 电流 pf/η 按功率分档（15kW 线电流 26.4A → 30.3A = Y160L-4 铭牌值，旧值系统性低 13~20%）。
  full 的 `tools/` 与 `index.mjs` 全部从 core 导入（含 `L0_NATIVE_FIELDS` 白名单），
  `lib/` 下同名文件为死副本不参与运行时 ⇒ 升依赖即生效，无需改 full 代码。
  三项行为变更均带 env 回退开关（默认新口径）：`DSH_L0_BG_CALIBER` / `DSH_L0_ENG_SLOT_FILL` / `DSH_L0_PF_ETA_BINS`。
- ⚠️ 数值会变：效率 −0.15~−0.36pp、温升 +0.5~+2.5K、峰值电流 +2.3~+19.9A、pf 0.92→0.84~0.88。
  这是向铭牌真值收敛的必然物理后果，非缺陷；`COPPER_LOSS_K` 不需重标定
  （`calibrate_losses_v3.mjs:53` 本就用 RMxprt 真值电流+真值匝数拟合）。

### Tests
- full 侧 `scripts/verify.mjs` 门禁全过（入口 apply 契约 / 双通道激活闭环 / 免费额度闸门）。

## [1.0.0-rc.18] - 2026-10-16

### Fixed
- **G2 门禁 · skills 版本三重一致**：`skills/motor-l0-estimate/SKILL.md`、`skills/motor-design/SKILL.md`
  的 `metadata.version` 在 rc.17 发版时漏 bump（仍 `1.0.0-rc.16`），`skills/SKILL.md` 更旧（`1.0.0-rc.7`）。
  本次统一对齐至 `1.0.0-rc.18`，恢复「package.json == CHANGELOG 顶 == 各 skill」三重一致
  （rc.17 的 G2 FAIL 即由此外泄）。
- **G4 门禁 · CONFIG_SCHEMA 补声明 `bootstrapVenvPath`**：`lib/env-probe.mjs:484` 读取该键用于
  env-bootstrap 自定义 venv 目标，但 `index.mjs` 的 `CONFIG_SCHEMA` 未声明 ⇒ DSH 裁键 ⇒ 恒 undefined，
  「自定义 venv 路径」参数实际不可用（rc.17 的 G4 FAIL）。现补声明，默认空 = 回退
  `{motorDesignRoot}/venv` 或 `~/.dsh-motor-ai/bootstrap-venv`。

## [1.0.0-rc.17] - 2026-10-16

### Fixed
- **F 跨对话重新注册/激活（根因）**：`lib/license.mjs` 的 `getActivationFilePath` /
  `getRevocationFilePath` 原先只用 `DSH_HOME || ~/.dsh`，漏掉 DSH Desktop 真实数据目录
  `%APPDATA%/dsh-desktop/harness`（`tests/_diag_remote_quota_standalone.mjs` 已证实）。
  现在改为三重候选解析 `DSH_HOME → APPDATA/dsh-desktop/harness → ~/.dsh`：优先读已存在文件、
  新写落 harness；`lib/quota.mjs` 经 `dirname` 自动对齐（一改双效）。根治「换对话需重激活」。
- **A L2 几何校验「铁芯长度必须 > 0」误报（400kW 必现）**：`tools/l2/motorcad-verify.mjs`
  抽出可单测纯函数 `validateL2Geometry`，几何校验兼容双口径（`stator_od`/`core_length` 等
  L0 输出字段 + `Stator_Lam_Dia` 等 Motor-CAD 原名），消除 L0→L2 字段名不一致导致的恒失败。
- **B 大机座外径误警**：同文件新增 `adaptiveStatorOdLimit`（400kW→800 / 450kW→875 /
  未知→1000mm），外径上限随额定功率自适应，不再硬编码 500mm 误杀大机座。

### Added
- **D L1/L2 环境一键自助配置**：新增 `tools/env-bootstrap.mjs`（工具名 `motor_env_bootstrap`）
  并在 `index.mjs` 注册；`lib/env-probe.mjs` 新增 `bootstrapEnv`（一键建 venv + pip
  pyaedt/pywin32 + 探测缓存 AEDT/Motor-CAD 路径）。L1/L2 从「装齐才能用」→「点一下基本能用」。
  诚实边界：`bootstrapEnv` 不安装基础 Python / AEDT / Motor-CAD 本体（需管理员+大体积）。

### Changed
- **E L0 候选极数硬约束**：`tools/l0/param-matrix.mjs` 在 `spec.poles` 显式给定时
  `poleList=[poles]`，剔除异极数候选污染（如 400kW 误混入 V16 失败组）。
- **C motor_type 跨层一致**：L0 默认口径回退 `config.defaultMotorType`，新增
  `inferMotorTypeFromSpec`（含 magnet / slip=0 自动判 PMSM），与 L1 默认 `pmsm` 对齐，
  消除「生成按异步、推理按 OD 误判」的口径分裂。

## [1.0.0-rc.16] - 2026-10-15

### Fixed
- **P0-2 `maxMatrixSize` 静默截断**（跨 rc.9~rc.15 未修）：`buildParamMatrix` 原先
  `count = Math.min(maxMatrixSize, ...)` 截断后仅置 `truncated=true` 布尔位，
  无告警、无报错 ⇒ 调用方无从得知采样密度被改变，Top1 效率与「达标」判定随 `count`
  漂移（实测 20→91.56 / 2000→92.06 / 10000→92.09）。现在：
  ① 新增 `MATRIX_TRUNCATED` 结构化告警（`requested_count` / `max_matrix_size` /
     `returned` / `suggested_max_matrix_size` / `hard_cap`）；
  ② 新增 `config.strictMaxMatrixSize`（默认 false，行为不变）——为 true 时
     `count > maxMatrixSize` 直接抛错而非静默截断；
  ③ 新增矩阵硬上限 `MATRIX_HARD_CAP=50000`，即使 `maxMatrixSize` 传再大也钳制
     （对齐 l0 v0.4.0 既有保护，full 此前反而落后）。
- **P1-1 冷却 `water` 静默回退 `forced_air`**：`cooling` 不在合法值内时不再静默回退，
  写 `COOLING_FALLBACK` 告警（含合法值列表）。回退行为不变、可见性补齐。
- **P0-1 verdict 密度敏感（缓解，非根治）**：新增 `density_check`（args 传
  `density_check=true` 或 env `L0_DENSITY_CHECK=1`，默认 OFF 零回归），
  以 20 与当前 count 双密度跑 pipeline 比对 Top1 效率，`|Δ| < 0.1pp` 判已收敛，
  handoff 落 `density_check` 块（含 `converged` / `delta_pp` / 提示文案）。
- **P0-4 默认 8 极静默假达标（用户建议：不改默认逻辑，改输出侧提示）**：
  未显式传 `poles` 且默认极数下可行组为 0 时，`runL0Pipeline` 输出
  `pole_suggestion`（默认极数 / 建议补算极数 / 理由），引导用户「可尝试更多极数」；
  默认行为不变。

### Added
- `scripts/l0_fixes_probe_rc16.mjs`（新，随包）：20 断言行为探针，含
  默认 OFF 零回归对照、密度收敛趋势实证（delta_pp≈0.06，与用户报告吻合）。
- `scripts/verify.mjs` 门禁：静态断言（告警码/合法值/strict/硬上限/令牌透传）
  + 运行时强断言（门内 spawn L0 探针）。

### Notes
- 两轮反向验证：破坏冷却判据（`if (false)`）后静态断言仍绿、运行时探针抓 2 项
  失败 ⇒ 门禁红；均已还原复跑全绿。
- l0 同款修复随 **dsh-motor-ai-l0 0.5.3** 发布（l0 侧 P0-2 此前已有 v0.4.0 部分修复，
  本轮补齐其余三项并统一告警字段）。

## [1.0.0-rc.15] - 2026-10-15

### Fixed
- **P0（L2）sanity 门补「关键损耗字段全 0」判定**：`scripts/motorcad_bridge.py` 的
  `_sanity_gate` 原先只有两条判据（计算效率 < 10% / InputPower > 额定×10）。EMag
  **求解空转**时功率同样读回 0 ⇒ `OutputPower/InputPower = 0/0` 算不出效率、`InputPower`
  也不超阈 ⇒ **两条判据双双失效，垃圾损耗/效率被静默采信**（`return=0 ≠ 结果可信` 的
  历史 v3 事故同类形态）。
  新增判据 3：关键损耗字段（`Loss_[Total]` / `Loss_[Stator_Copper]` /
  `Loss_[Stator_Back_Iron]` / `Loss_[Stator_Tooth]`，常量 `CORE_LOSS_VARS`，
  零容差 `LOSS_ZERO_EPS=1e-9`）**读回后全部为 0** ⇒ 判定 EMag 未真正求解，
  写 `result_warning` + `result_trusted=False`。
  刻意**不**纳入 `Loss_[Rotor_Copper]`（PMSM 本就≈0）、`Loss_[Magnet]`、
  `Loss_[Windage]`/`Loss_[Friction_*]`（低速可极小）、`Loss_[Stray_Load]`（可不计），
  否则合法工况会被误杀。另：一个关键字段都没读回时走「未回读任何关键损耗字段」告警，
  不与"全 0"混为一谈。

### Gates & Tests
- 新增 `scripts/sanity_gate_probe_rc15.py`（随包发布）：12 项行为断言，直连 import
  `_sanity_gate`，覆盖 正常不告警 / **全 0 触发** / 部分为 0 不误杀 / **PMSM 转子铜耗为 0
  不误杀** / 零读回走缺失分支 / 非 dict 静默 / 1e-12 残值仍判 0 / 字符串 '0' 不算读回 /
  与既有判据叠加共存。用例 2b 坐实：全 0 场景下既有两条判据**均不触发**。
- `scripts/verify.mjs` 门禁 6h：新增 `CORE_LOSS_VARS` / 「关键损耗字段全 0」/
  `LOSS_ZERO_EPS` 静态断言 + **误纳黑名单**（四个可为 0 的分量）+ **运行时强断言**
  （门内 spawn 跑 Python 探针，要求输出 `SANITY_GATE_PROBE_RC15_ALL_OK`，
  可用 `DSH_PYTHON` 指定解释器，无 python 时降级提示）。
- `tests/motorcad-p0-bundles.test.mjs` 第 8 项同步补 7 条断言（45 passed / 0 failed）。
- **两轮反向验证**：① 保留文案但把判据改成 `elif False:` ⇒ 静态断言仍绿、
  **运行时探针抓到 4 项失败 ⇒ 门禁红**（证明静态字符串断言不足以防回退）；
  ② 把 `Loss_[Rotor_Copper]` 加入 `CORE_LOSS_VARS` ⇒ 误纳断言双路变红。
- 坑（第 4 次同类）：`CORE_LOSS_VARS` 提取正则若写成非贪婪 `\[[\s\S]*?\]`，会被字段名
  自带的 `]`（`Loss_[Total]`）提前截断 ⇒ 误纳检查**恒真 = 假绿灯**；已改为锚定
  "行首的 `]`"，并加一条"块必须含总损耗/定子铜耗"的自检。

## [1.0.0-rc.14] - 2026-10-15

### Fixed
- **P0-门1'（对齐 l0 v0.5.2）同步批量脱闸**：rc.13 的「同链只扣 1 次」用
  「`_consumed` WeakSet（key = config 对象）+ `queueMicrotask` 复位」实现 —— 同步 for
  循环复用同一 config 引用时微任务不穿插执行，第 2~N 次 `alreadyConsumed()` 恒为 true，
  **整批只扣 1 次、12 次全部放行**（CI 脚本 / 压测循环正是这种写法，门禁形同虚设）。
  判据改为**显式调用链令牌**：新增 `newQuotaChain()` / `withQuotaChain(config, token)`，
  聚合入口 `runL0Pipeline` 每次调用新建唯一令牌并派生带令牌的 `chainCfg` 透传给三个子
  纯函数 ⇒ 整链仍只扣 1 次，而循环调用因令牌唯一 ⇒ **各计一次**、第 11 次起拦截。
  注：rc.13 探针 [A] 组传同一 config 对象，恰好依赖该缺陷 ⇒ 假绿灯（与 l0 同款教训）。

### Gates & Tests
- `scripts/verify.mjs` 门禁 H 升级：新增静态块 6a（必须导出 `newQuotaChain` /
  `withQuotaChain`；禁止 `function alreadyConsumed(config)` / `markConsumed(config)` 的
  config 引用形态；pipeline 必须把带令牌配置透传给三个子纯函数）+ 运行时用例 3b 扩展
  （同令牌不重扣 / 跨链独立计数 / **同一 config 引用 + 同步循环 ×3 = +3** / bypass 不计数）。
- 新增 `scripts/quota_probe_rc14.mjs`（随包发布）：20 断言，新增 [A-same] 组
  （同一 config 引用 + 同步循环各计一次，且 limit=2 时第 3 次触顶被拦 —— rc.13 该形态
  永不触顶），[G] 组新增调用链令牌静态回归。

## [1.0.0-rc.13] - 2026-10-15

### Fixed
- **P0-门1（对齐 l0 v0.5.1）多重计数**：L0 四个纯函数（runL0Pipeline / buildParamMatrix /
  runDesignValidate / runL0Estimate）入口过闸并传同一 config 引用 —— 修复
  motor_l0_pipeline 一次调用扣 3 次（execute enforceQuota 1 次 + 纯函数无 config 各扣
  1 次）的缺陷；execute 改为捕获 QuotaExceededError 回引导文案，不再 await enforceQuota
  （await 边界会放跑一次性消费标记导致双重扣次）。
- `assertFreeQuota` 尊重 `freeQuotaEnabled:false` 运维开关；experience-hub capture 与
  case-feedback 聚合的离线批量调用显式 bypass，不再消耗用户每日免费额度。

### Gates & Tests
- `scripts/verify.mjs` 门禁 H 升级：静态断言新接线形态（assertFreeQuota/QuotaExceededError
  import + 纯函数入口过闸 + execute 捕获 + 禁 `await enforceQuota(config)` 旧写法）+
  运行时语义用例（同一调用链不重扣 / 跨链独立计数 / bypass 不计数）。
- 新增 `scripts/quota_probe_rc13.mjs`（随包发布）：15 断言可复现探针，覆盖同链不重扣 /
  跨链独立 / bypass / pipeline 整链只扣 1 次（修复前 +3）/ 直调脱闸防护 / 用尽抛错与
  引导文案 / 静态回归，发布后从 tarball 复跑。

## [1.0.0-rc.12] - 2026-10-14

### Added
- **L1/L2 环境自动搜寻 + 引导（env-probe）**：授权通过后、真解算前自动体检五项
  （Python 候选链 / pyaedt / pywin32 / Ansys AEDT / Motor-CAD）——新增
  `lib/env-probe.mjs`（探测矩阵 + 全盘常见布局扫描，含 D/E 盘工业软件惯例位置）
  与 `motor_env_check` 一键体检工具（免费、不占配额、随时可调，输出人话修复指引：
  下载页 / pip install / 环境变量 / DSH 配置键）。L1 三 execute 与 L2
  `motor_motorcad_verify` 在 license 闸后、配额消耗前预检：缺项直接返回
  `ENV_NOT_READY` 结构化引导，**不白耗 60-120s AEDT/COM 启动、不扣当日配额**
  （环境损坏 + 配额用尽的用户仍可用 motor_env_check 自救）。
- **worker `--preflight` 死参数实现**：`scripts/_rmxprt_venv_worker.py` 的
  `--preflight` 此前声明未消费（argparse required 三件套还会误拦）；现为秒级
  预检模式（探测 pyaedt/pywin32/AEDT exe，输出 JSON + hints），不启动 Desktop；
  正常求解模式仍校验三件套（防呆文案同时提示两种模式）。

### Fixed
- `buildEnvGuide` nextSteps 编号：多缺失项拼接后重编号为连续序号（原 1./2./3. × N 重复）。
- worker `--params/--output/--var-map` 由 argparse required 改为模式内校验，preflight 免检。

### Changed
- `manifest.json` tools 声明补 `motor_env_check`（11 个）；README 工具表补一行 +
  rc.12 环境自动搜寻说明段。
- `CONFIG_SCHEMA` 补声明 `l1Python`（env-probe 候选链读取，与 `motorcadPython` 并列）。

### Gates & Tests
- `scripts/verify.mjs` 新门禁 **6g**：env-probe 导出 / env-check 工具名与遥测 /
  index 注册 / manifest 声明 / L1×3+L2×1 接线数 / worker preflight 消费 / l1Python
  声明 / probeAll 矩阵与 guide 结构功能验证。
- `tests/env-probe.test.mjs` 30 用例全过（候选链 / guide 编号 / mock 文件系统探测 /
  真实解释器模块探测 / probeAll 结构 / worker preflight spawn 冒烟 / 缺参防呆）；
  既有 7 套回归全绿。

## [1.0.0-rc.11] - 2026-10-14

### Added
- **L1 RMxprt 求解器随包分发（README ⏳ 真相修复）**：`scripts/_rmxprt_venv_worker.py`
  （3674 行，源自 `MotorDesign/Scripts`，v3 防弹版 + P0-2 绕组接法注入）正式入库并随包
  分发；`tools/l1/rmxprt-solve.mjs` 路径解析改为**包内副本优先**（`bundledWorkerPath`），
  `RMXPRT_WORKER_PATH` 环境变量仍可覆盖、`MOTORDESIGN_ROOT` 次选。此前 worker 只存在于
  后端仓，分发版完整版 L1 恒报「未配置 RMXPRT_WORKER_PATH」——README 的 ⏳ 不是没写代码，
  是求解器资产未随包。注意：仍需本机装有 Ansys AEDT 2020.x（RMxprt）+ Python 3.10
  （pyaedt 0.6.x / pywin32），解释器用 `PYTHON_BIN` 指定；未装时返回结构化错误引导，
  不影响 L0。
- **CONFIG_SCHEMA 补声明 32 键（P0-②，治「改配置不生效」）**：`backendUrl` /
  `commerceBackendUrl` / `telemetryIntervalSec` / L0 运行 6 键（l0Mode、surrogatePath、
  surrogateConfidenceThreshold、maxMatrixSize、defaultMotorType、line_freq_hz）/ 物理口径
  5 键（efficiencyCap、tempRiseRange、airGapFluxT、insulationClass、bgCaliber）/ L2 8 键
  （motorcadMode、motorcadProgid、motorcadPython、motorcadTimeoutMs、motFile、runEmag、
  runThermal、fallbackToEquivalent）/ 配额经验 6 键 / 工程回归 4 键。schema 8 → **40 键**，
  所有 default 与代码内默认逐键对齐（防声明后行为漂移）。背景：DSH 会裁掉 schema 未声明键
  → cordis.patch.yml 里写的 30+ 项配置此前**只有 8 项真正生效**，后端通道被裁直接卡死
  遥测端点与公网后端方案（该类问题第二次复发）。
- 测试 `tests/config-schema-coverage.test.mjs`（21 用例）+ `scripts/verify.mjs` 门禁 **6f**：
  静态比对「代码读取的 config 键 ⊆ schema 声明键」（漏一个即 fail）+ worker 在包断言 +
  L1 包内解析断言。门禁首跑即抓到漏网键 `bgCaliber`，已补声明。

### Fixed
- `line_freq_hz` 为 0 时被 `Number.isFinite` 误判为有效值注入 `lineFreqHz: 0`（工频不可能
  ≤0）→ 两处判断改为 `> 0` 防护（`tools/l0/l0-estimate.mjs` / `tools/l0/design-validate.mjs`）。

## [1.0.0-rc.10] - 2026-10-14

### Added
- **完整版插件端遥测使用聚合（方案 B 接线）**：此前 `lib/telemetry.mjs` 聚合模块
  在仓库中但无任何工具调用（管理端「插件遥测聚合报表」恒暂无上报）。本次：
  - `index.mjs` CONFIG_SCHEMA 补声明 `telemetryEnabled`（默认 **true**，opt-out 语义，
    2026-10-14 决策）/ `telemetryEndpoint` / `telemetryBatchSize` / `telemetryMinIntervalMs`——
    未声明键会被 DSH 裁掉恒 undefined（backendUrl 前车之鉴）；
  - 新增 `scheduleTelemetry()`（fire-and-forget + 默认 60s 节流，兼容旧键
    `telemetryIntervalSec` 秒语义）；L0 四工具 + L1 三 execute + L2 两 execute
    全部接线（L1/L2 同时补本地 usage.jsonl 落盘，配额/授权闸放行后才计入）；
  - `reportTelemetry()` endpoint 空时回退 `{后端}/api/dsh/dsh-plugins/dsh-motor-ai/usage-report`
    （优先级 config.commerceBackendUrl > backendUrl > DSH_BACKEND_URL > 127.0.0.1:5000）；
  - 聚合身份修正：payload `plugin: 'dsh-motor-ai'` / `kind: 'usage-aggregate'`
    （原为从 l0 抄来的 `dsh-motor-ai-l0` 残留）；
  - 合规底线不变：只上报按工具聚合的白名单统计量（次数/成败/耗时/规模/错误类别），
    逐条明细与设计参数绝不外发；用户可置 `telemetryEnabled: false` 显式退出。
- 测试 `tests/telemetry-aggregate.test.mjs`（42 用例）+ `scripts/verify.mjs` 门禁 6e
  （scheduleTelemetry 导出 / 聚合身份 / CONFIG_SCHEMA 声明 / 6 工具文件接线 / opt-out 功能验证）。

## [1.0.0-rc.9] - 2026-10-12

### Fixed
- **版本三重一致性补全（rc.8 发布物缺陷修复）**：rc.8 bump 时漏改
  `skills/motor-design/SKILL.md` 与 `skills/motor-l0-estimate/SKILL.md` 的
  `metadata.version`（仍为 rc.7），导致管理端 `_run_gate_full` 的 **G2 版本三重**
  不一致、台账无法写回 rc.8。本版将 package.json / manifest.json（顶层 + 2 skill）
  / CHANGELOG / 2 个 SKILL.md 全部对齐到 rc.9。
- **npm 已发布物一致性**：npm 包发布后不可覆盖，rc.8 的 tarball 内 skill 元数据
  停留在 rc.7（纯元数据、不影响运行）。为使「源码 = 已发布物 = 台账」三方一致，
  发布本 rc.9；发布物内所有版本标记统一为 rc.9。

### 说明
- 无运行时功能变化（rc.8 的免费额度闸门 / 双通道激活 / manifest.json 上架清单均不变）。
- 关联：l0 免费层配额闸门已随 `dsh-motor-ai-l0@0.3.3` 落地（`lib/quota.mjs` +
  四 L0 工具接入 + `lib/` 进 files 白名单），full 与 l0 的 `getDeviceId` 算法一致，
  同一设备共用同一本免费额度账。

## [1.0.0-rc.8] - 2026-10-12

### Added
- **dshhub 口令市场上架清单**：仓库根新增 `manifest.json`（dshhub v2 规范）——
  `manifestVersion:2` / `id:cn.motorai.dsh-motor-ai`（反域名）/ `kind:plugin` / `entry:{}` /
  `license:PolyForm-Noncommercial-1.0.0`；声明 2 个 skill 与 10 个 tool，并标注依赖共享核心 `dsh-motor-ai-l0`。
  此前仓库无清单 ⇒ dshhub「我的仓库」扫描时判为不可上架而自动隐藏。

### Fixed
- **npm 包缺失上架清单**：`package.json` 的 `files` 白名单补入 `manifest.json`
  （此前发布物内无清单，`unpkg.com/dsh-motor-ai@*/manifest.json` 恒 404，市场按 npm 装取不到元数据）。
- **npm dist-tag 与仓库版本脱节**：`latest` 停在旧的 `1.0.0-beta`，实际开发线已到 rc 系列；
  本次发布 rc.8 并置为 `latest`，与 manifest/package.json 版本三者一致。

## [1.0.0-rc.7] - 2026-10-11

### Added
- **双通道激活闭环（C 端到端）**：
  - `lib/license.mjs` 新增 `isOnlinePasscode` / `getDeviceId` / `activateOnline` / `activateFlex`；
    `DM-XXXX-XXXX` 服务端口令走后端 `POST /api/dsh/verify` 在线校验，成功即落盘 `tier=full` + 到期时间，
    设备绑定 / 解绑 / 吊销 / 收入统计全部生效（此前 DM 码因插件端纯离线分支 + 正则不识别而激活必败）。
  - `tools/activate.mjs` 自动按码形态分流：DM 在线校验、v2 离线非对称码本地验签。
  - `scripts/verify.mjs` 新增**门禁 G**：mock fetch 覆盖 DM 在线校验 / 绑定 / device_mismatch / 离线分流四分支。

### Changed
- 后端 `app/admin_dsh.py`：`_run_gate` 按 `plugin_id` 定位仓库根（`PLUGIN_ROOTS` 映射，支持 `DSH_FULL_PLUGIN_ROOT` 覆盖），
  新增 `_run_gate_full` 专属判据（G1 仓库完整性 / G2 版本三重一致 / G3 双通道激活代码在场 / G4 verify.mjs A–G 全过），
  full 从此能「真」跑门禁并置 `published`（此前硬编码 l0 镜像，full 拿的是别人的合格证）。

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
