#!/usr/bin/env python3
"""rc.15 sanity 门探针：_sanity_gate 的「关键损耗字段全 0」判据行为实证。

直接 import bridge 的 _sanity_gate（bridge 有 __main__ 守卫，可安全导入），
不依赖 Motor-CAD / COM / 网络，纯函数级验证。

用法：
    python scripts/sanity_gate_probe_rc15.py
全绿时末行打印 SANITY_GATE_PROBE_RC15_ALL_OK，否则打印失败项并 exit(1)。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from motorcad_bridge import _sanity_gate, CORE_LOSS_VARS, LOSS_ZERO_EPS  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    tag = "OK  " if cond else "FAIL"
    print(f"[{tag}] {name}" + (f"  -- {detail}" if detail else ""))
    if not cond:
        FAILS.append(name)


def has_zero_loss_warn(w):
    return any("关键损耗字段全 0" in x for x in w)


def has_missing_warn(w):
    return any("未回读任何关键损耗字段" in x for x in w)


print("=" * 68)
print("rc.15 sanity 门探针 · 关键损耗字段全 0 判定")
print("=" * 68)
print(f"CORE_LOSS_VARS = {CORE_LOSS_VARS}")
print(f"LOSS_ZERO_EPS  = {LOSS_ZERO_EPS}")
print()

# ---- 1) 正常损耗：不得触发任何判据 --------------------------------------
emag_ok = {
    "Loss_[Total]": 8200.0,
    "Loss_[Stator_Copper]": 5100.0,
    "Loss_[Stator_Back_Iron]": 1600.0,
    "Loss_[Stator_Tooth]": 1200.0,
    "OutputPower": 200000.0,
    "InputPower": 208200.0,
}
w = _sanity_gate(emag_ok, 200000.0)
check("1 正常损耗不告警（效率 ~96%、损耗非 0）", w == [], f"warnings={w}")

# ---- 2) 关键损耗全 0：必须触发（核心新增判据） ---------------------------
emag_zero = {
    "Loss_[Total]": 0.0,
    "Loss_[Stator_Copper]": 0.0,
    "Loss_[Stator_Back_Iron]": 0.0,
    "Loss_[Stator_Tooth]": 0.0,
    "Loss_[Rotor_Copper]": 0.0,
    "Loss_[Magnet]": 0.0,
    "OutputPower": 0.0,
    "InputPower": 0.0,
}
w = _sanity_gate(emag_zero, 200000.0)
check("2 关键损耗全 0 → 触发「关键损耗字段全 0」", has_zero_loss_warn(w), f"warnings={w}")
check("2b 全 0 场景既有判据 1/2 均不触发（证明新判据是唯一防线）",
      not any("计算效率" in x for x in w) and not any("InputPower" in x for x in w),
      f"warnings={w}")

# ---- 3) 部分为 0：不得误杀 ----------------------------------------------
emag_partial = {
    "Loss_[Total]": 7000.0,
    "Loss_[Stator_Copper]": 0.0,   # 例如纯磁钢/无绕组铜耗的理想化模型
    "Loss_[Stator_Back_Iron]": 0.0,
    "Loss_[Stator_Tooth]": 0.0,
}
w = _sanity_gate(emag_partial, 200000.0)
check("3 仅 Loss_[Total] 非 0 → 不判全 0（不误杀）", not has_zero_loss_warn(w), f"warnings={w}")

# ---- 4) PMSM 转子铜耗为 0 的合法工况：不得误杀 ---------------------------
emag_pmsm = {
    "Loss_[Total]": 8000.0,
    "Loss_[Stator_Copper]": 5000.0,
    "Loss_[Stator_Back_Iron]": 1500.0,
    "Loss_[Stator_Tooth]": 1200.0,
    "Loss_[Rotor_Copper]": 0.0,     # PMSM 合法
    "Loss_[Magnet]": 0.0,
    "Loss_[Windage]": 0.0,
}
w = _sanity_gate(emag_pmsm, 200000.0)
check("4 PMSM 转子铜耗/磁钢/风摩为 0 不误杀（CORE_LOSS_VARS 选择正确）",
      w == [], f"warnings={w}")

# ---- 5) 零读回（GetVariable 全失败）：走缺失告警，非"全 0"语义 ----------
w = _sanity_gate({"OutputPower": 1000.0, "InputPower": 1100.0}, 200000.0)
check("5 未读回任何关键损耗字段 → 触发缺失告警", has_missing_warn(w), f"warnings={w}")
check("5b 零读回不误判为「全 0」", not has_zero_loss_warn(w), f"warnings={w}")

# ---- 6) 非 dict 输入：静默返回空（保持原有契约） ------------------------
check("6 非 dict 输入返回空列表", _sanity_gate(None, 0) == [] and _sanity_gate("x", 0) == [])

# ---- 7) 浮点残值：容差内仍判为 0 ---------------------------------------
emag_eps = {k: 1e-12 for k in CORE_LOSS_VARS}
w = _sanity_gate(emag_eps, 200000.0)
check(f"7 残值 1e-12（< EPS={LOSS_ZERO_EPS}）仍判全 0", has_zero_loss_warn(w), f"warnings={w}")

# ---- 8) 字符串 '0'：非数值 → 不算读回 -----------------------------------
w = _sanity_gate({"Loss_[Total]": "0", "Loss_[Stator_Copper]": "0"}, 200000.0)
check("8 字符串 '0' 不算读回（走缺失分支，不误判全 0）",
      has_missing_warn(w) and not has_zero_loss_warn(w), f"warnings={w}")

# ---- 9) 仅一个关键字段被读回且为 0：仍应触发 -----------------------------
w = _sanity_gate({"Loss_[Total]": 0}, 200000.0)
check("9 只读回 Loss_[Total]=0 → 触发全 0", has_zero_loss_warn(w), f"warnings={w}")

# ---- 10) 与既有判据叠加：InputPower 超阈 + 损耗全 0 → 两条都在 ----------
emag_both = {"Loss_[Total]": 0.0, "OutputPower": 0.0, "InputPower": 2.5e7}
w = _sanity_gate(emag_both, 200000.0)
check("10 与既有判据 2 叠加共存（两条 warning 都在）",
      has_zero_loss_warn(w) and any("InputPower" in x for x in w), f"warnings={w}")

print()
if FAILS:
    print(f"❌ 失败 {len(FAILS)} 项: {FAILS}")
    sys.exit(1)
print("SANITY_GATE_PROBE_RC15_ALL_OK")
