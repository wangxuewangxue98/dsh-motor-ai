# DSH Motor-CAD 模板目录

## 目录结构

```
models/templates/
├── README.txt                  ← 本文件
├── default/                    # 开箱默认模板（通用，适用于任意尺寸范围）
│   ├── induction.mot           # 三相异步电机（通用）
│   └── pmsm.mot                # 永磁同步电机（通用）
├── 15kW/                       # 15kW 实机口径模板
│   └── induction.mot           # 15kW/1460rpm/380V 异步（公众号系列基线算例）
└── 300kW/                      # 300kW 实机口径模板
    └── induction.mot           # 300kW/985rpm 异步（L2 真机耦合解产物）
```

## 版权说明

所有 `.mot` 模板均为 DSH 自制，**不包含任何 Ansys / Motor-CAD 商业示例工程**。
- `default/` 模板：通用参数化起点，不含特定电机设计。
- `15kW/` 模板：提取自公众号系列第二篇基线算例（OD278-310/4极异步），几何参数为 DSH 自算。
- `300kW/` 模板：从真机 `l2_rated_I312.mot` 提取关键字段（仅 Magnetic/Thermal/Winding 段），
  不携带原文件的 License / Key_Number / 热网络节点等敏感数据。

原 `.mot` 文件（含完整 License）仍保存在：
- `D:/MotorDesign/Scripts/_l2_300kW_opt/l2_rated_I312.mot`
- `D:/MotorDesign/Scripts/_l2_300kW_opt/l2_opt_L478.mot`

## 使用方式

L2 `motor_motorcad_verify` 工具的模板优先级链（由 `resolveDefaultMotFile` 实现）：

1. **显式 template 参数**（调用方传入）
2. **config.motFile**（DSH 配置）
3. **env MOTORCAD_DEFAULT_MOT**（环境变量）
4. **按 motorType 解析包内默认模板**（`models/templates/default/<type>.mot`）
5. **空串**（用 Motor-CAD 当前打开的模型）

若需使用实机口径模板（15kW / 300kW），通过显式 template 参数指定路径：
```
template: "D:/.../dsh-motor-ai/models/templates/15kW/induction.mot"
```

## 变量名兼容性

模板变量名与 `tools/l2/motorcad-verify.mjs:MOTORCAD_PARAM_CANDIDATES` 中的候选表对齐：
- `Stator_Lam_Dia` / `Stator_Lamination_Dia` → stator_od
- `Stator_Bore` → stator_bore
- `Stator_Lam_Length` / `Motor_Length` → core_length
- `Slot_Number` / `Slots` → slots
- `Pole_Number` / `Poles` → poles
- `Tooth_Width` → tooth_width（关键！历史 BUG11 防线）
- `Turns_per_Coil` → turns_per_coil

Bridge 侧逐个 SetVariable，失败的自动跳过（applied_params 会记录哪些成功）。
