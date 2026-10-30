"""反向破坏验证：dsh-motor-ai 1.2.3 的 P0-7 + VFD 排序方向门禁必须能抓获四类破坏。

纪律（记忆铁律）：取值路径类改动必须构造「只有该路径能区分」的断言；
开关类改动必须 env 与 opts 双通道分别断言；改完必须反向破坏，恢复后回绿。

场景：
  1 拆 l0-estimate 的 args.slot_tw ⇒ opts.slotTw 透传  ⇒ §2/§4/§7 变红
  2 拆 pipeline 白名单透传 slot_tw                      ⇒ §1/§7 变红（声明仍在但到不了估算）
  3 拆 ASCENDING_FIELDS 的 temp_rise_vfd                ⇒ §6 方向断言变红（关键区分力）
  4 拆 design-validate probeRow 内 slotTw 就地构造       ⇒ §5 变红
  0 基线（未破坏，须全绿） / 5 恢复（须回绿）
"""
import shutil, subprocess, sys, re, os

ROOT = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(ROOT, "scripts", "verify_slot_tw.mjs")
FILES = {
    "est": os.path.join(ROOT, "tools", "l0", "l0-estimate.mjs"),
    "pipe": os.path.join(ROOT, "tools", "l0", "pipeline.mjs"),
    "dv": os.path.join(ROOT, "tools", "l0", "design-validate.mjs"),
}
BAK = {k: v + ".bak_break123" for k, v in FILES.items()}
NODE = sys.executable  # 用当前 python 无法跑 node；改用 node 绝对路径


def run_gate():
    r = subprocess.run(["node", GATE], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", cwd=ROOT)
    out = (r.stdout or "") + (r.stderr or "")
    m = re.search(r"(\d+) 通过 / (\d+) 失败", out)
    p, f = (int(m.group(1)), int(m.group(2))) if m else (-1, -1)
    fails = [l.strip() for l in out.splitlines() if "[FAIL]" in l]
    return r.returncode, p, f, fails


def patch(key, old, new):
    p = FILES[key]
    s = open(p, encoding="utf-8").read()
    if old not in s:
        raise SystemExit(f"!! 破坏锚点未命中 {key}: {old[:60]}")
    open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))


def restore():
    """从备份还原产品代码。⚠ 备份**不能**在这里删除：多个场景都要用它还原，
    删了会导致第二次 restore 静默失效（实测：恢复后 23/5 不回绿）。备份统一在末尾清理。"""
    for k, p in FILES.items():
        if os.path.exists(BAK[k]):
            shutil.copy2(BAK[k], p)


def cleanup_bak():
    for k in FILES:
        if os.path.exists(BAK[k]):
            os.remove(BAK[k])


SCENARIOS = [
    ("1 拆 l0-estimate args.slot_tw 透传", "est",
     "...((args.slot_tw === true || args.slot_tw === 'true') ? { slotTw: true } : {}),",
     "// BREAK: 透传被拆"),
    ("2 拆 pipeline 白名单透传", "pipe",
     "...(args.slot_tw != null ? { slot_tw: args.slot_tw } : {}),",
     "// BREAK: 白名单透传被拆"),
    ("3 拆 ASCENDING 的 temp_rise_vfd", "est",
     "export const ASCENDING_FIELDS = new Set(['temp_rise', 'total_loss', 'temp_rise_vfd', 'total_loss_vfd'])",
     "export const ASCENDING_FIELDS = new Set(['temp_rise', 'total_loss'])"),
    ("4 拆 design-validate probeRow slotTw", "dv",
     "...(opts?.slotTw ? { slotTw: true } : {}),",
     "// BREAK: probeRow 接线被拆"),
]

print("=== 场景 0：基线（未破坏，期望全绿 exit=0）===")
for k, p in FILES.items():
    shutil.copy2(p, BAK[k])
rc, p_, f_, fails = run_gate()
print(f"  exit={rc} | {p_} 通过 / {f_} 失败")
if rc != 0:
    print("  !! 基线就不绿，先修再破坏验证"); restore(); sys.exit(1)

results = {}
try:
    for name, key, old, new in SCENARIOS:
        print(f"\n=== 场景 {name}（独立破坏：patch → 跑 → 立即恢复）===")
        patch(key, old, new)
        try:
            rc, p_, f_, fails = run_gate()
            results[name] = f_
            print(f"  exit={rc} | {p_} 通过 / {f_} 失败（期望 FAIL>0）")
            for l in fails[:6]:
                print("   ", l[:150])
        finally:
            # ⚠ 必须每个场景立即恢复：否则破坏累积 ⇒ 无法证明「单独拆这一处就变红」
            restore()
finally:
    print("\n=== 场景 5：恢复（最终校验）===")
    restore()
    rc, p_, f_, fails = run_gate()
    print(f"  exit={rc} | {p_} 通过 / {f_} 失败（期望 exit=0, FAIL=0）")

print("\n── 汇总 ──")
bad = [n for n, f in results.items() if f <= 0]
for n, f in results.items():
    print(f"  {'OK ' if f > 0 else '!! '}{n}: FAIL={f}")
if bad:
    print("\n!! 以下场景未变红（门禁抓不住该破坏）:", bad)
if rc != 0 or f_ != 0:
    print("!! 恢复后未回绿")
cleanup_bak()
assert not bad and rc == 0 and f_ == 0, "反向破坏验证未通过"
print("\n反向破坏验证通过：四场景独立变红 + 恢复回绿（备份已清理）")
