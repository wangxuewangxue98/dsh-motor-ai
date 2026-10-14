# -*- coding: utf-8 -*-
"""
motorcad_bridge.py — L2 本机 COM 直驱桥（方案 Y）

为什么用「Python 子进程 + pywin32」而不是 Node 原生 COM 模块：
  1. Node 侧 winax / node-win32ole 需要 node-gyp 本地编译，插件分发到用户机器上
     极易因缺 VS Build Tools 而安装失败 —— 商业分发不可接受。
  2. 本机已有成熟验证过的 COM 逻辑（MotorDesign/motorcad_auto），直接复用其
     「预启动 + HKCU 覆盖 + 等待 90s + 重试 Dispatch」套路，可绕开
     win32com Dispatch 内部 ~60s SCM 超时（Motor-CAD 需 80-120s 启动）。

协议（stdin/stdout，单行 JSON）：
  请求：{"action": "ping" | "verify", "mot_file": "...", "params": {...},
         "run_emag": true, "run_thermal": true, "save_to": "...",
         "exe_path": "...", "install_dir": "...", "progid": "MotorCAD.AppAutomation"}
  响应：{"ok": true, ...} 或 {"ok": false, "reason": "...", "error": "..."}
  进度/日志一律写 stderr（stdout 只允许出现一行 JSON，便于 Node 精确解析）。

已知坑（来自 MotorDesign/motorcad_auto 实测，务必保留）：
  - Dispatch 有 ~60s 内部超时 → 必须先手动启动 exe，等待窗口 + 90s 后再 Dispatch。
  - GetVariable 查询不存在的变量会**无限挂起**（OperatingSpeed / MaxTemperature /
    T_[Housing_Average] 已确认挂起）→ 只能查白名单。
  - GetVariable 返回 (code, value) 元组，code>=0 才是成功。
  - ActiveX "免注册" 模式 COM 不可用 → 需切换为「单客户端设置」(菜单 id=94)，
    可用 HKCU 写 LocalServer32 指向 .exe 规避（无需管理员权限）。
"""
import os
import sys
import json
import time
import ctypes
import logging
import subprocess

# stdout 只允许一行 JSON；日志走 stderr
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                    format='[motorcad-bridge] %(message)s')
logger = logging.getLogger('motorcad_bridge')

# ---- 常量（与 MotorDesign/motorcad_auto/config.py 保持一致）----
DEFAULT_PROGID = "MotorCAD.AppAutomation"
CLSID = "{4ACD06EB-5486-42AF-91DB-FB752E64C465}"
MAIN_FORM_CLASS = "TMainForm"
MENU_ID_SINGLE_CLIENT = 94
MENU_ID_NO_REGISTER = 95

# 白名单：只查这些变量，避免 GetVariable 无限挂起
READABLE_PARAMS = [
    "Program_Version", "Program_Module", "Pole_Number", "Slot_Number",
    "DCBusVoltage", "PeakCurrent", "WindingConnection",
]
THERMAL_RESULT_VARS = ["T_[Winding_Average]", "T_[Winding_Max]"]
EMAG_RESULT_VARS = [
    "Shaft_Torque_[pu]", "Shaft_Torque_[Required]", "TorqueRippleMsVw",
    "Loss_[Total]", "Loss_[Stator_Copper]", "Loss_[Rotor_Copper]",
    "Loss_[Stator_Back_Iron]", "Loss_[Stator_Tooth]", "Loss_[Stator_Tooth_Tip]",
    "Loss_[Rotor_Back_Iron]", "Loss_[Rotor_Tooth]", "Loss_[Magnet]",
    "Loss_[Windage]", "Loss_[Friction_-_F_Bearing]", "Loss_[Friction_-_R_Bearing]",
    "Loss_[Stray_Load]", "TotalLoss", "OutputPower", "InputPower",
    "ElectromagneticPower",
]


class BridgeError(Exception):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _find_exe(exe_path="", install_dir=""):
    """定位 Motor-CAD 可执行文件。

    优先级：入参 > 环境变量（MOTORCAD_PATH / MOTORCAD_EXE_PATH / MOTORCAD_INSTALL_DIR）
    > ProgramFiles 扫描（含版本子目录）。不内置任何绝对路径字面量。
    """
    exe_path = exe_path or os.environ.get("MOTORCAD_PATH") or os.environ.get("MOTORCAD_EXE_PATH") or ""
    install_dir = install_dir or os.environ.get("MOTORCAD_INSTALL_DIR") or ""
    if exe_path and os.path.exists(exe_path):
        return exe_path, install_dir or os.path.dirname(exe_path)
    if exe_path and os.path.isdir(exe_path):  # 传了目录而非 exe
        install_dir = install_dir or exe_path
        exe_path = ""
    pf = os.environ.get("ProgramFiles") or os.environ.get("PROGRAMFILES(X86)") or ""
    candidates = []
    if install_dir:
        candidates.append(os.path.join(install_dir, "Motor-CAD_11_1_5.exe"))
        candidates.append(os.path.join(install_dir, "Motor-CAD.exe"))
    if pf:
        candidates.append(os.path.join(pf, "Motor-CAD", "Motor-CAD.exe"))
        # 版本子目录（如 Motor-CAD\11_1_5\Motor-CAD_11_1_5.exe）——安装版常见布局
        try:
            base = os.path.join(pf, "Motor-CAD")
            if os.path.isdir(base):
                for entry in sorted(os.listdir(base), reverse=True):
                    sub = os.path.join(base, entry)
                    if not os.path.isdir(sub):
                        continue
                    for nm in ("Motor-CAD_11_1_5.exe", "Motor-CAD.exe"):
                        p = os.path.join(sub, nm)
                        if os.path.exists(p):
                            candidates.append(p)
        except Exception:
            pass
    for c in candidates:
        if os.path.exists(c):
            return c, os.path.dirname(c)
    return "", install_dir


def _apply_hkcu_override(exe_path, install_dir):
    """HKCU 级覆盖 COM LocalServer32 → 直接指向 .exe（无需管理员权限）。"""
    if not exe_path or not os.path.exists(exe_path):
        return False
    try:
        import winreg
        ok = False
        for base in (f"Software\\Classes\\CLSID\\{CLSID}",
                     f"Software\\Classes\\Wow6432Node\\CLSID\\{CLSID}"):
            try:
                ls = base + "\\LocalServer32"
                winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, ls, 0, winreg.KEY_SET_VALUE)
                k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, ls, 0, winreg.KEY_SET_VALUE)
                winreg.SetValueEx(k, None, 0, winreg.REG_SZ, exe_path)
                winreg.CloseKey(k)
                ad = base + "\\AppDirectory"
                winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, ad, 0, winreg.KEY_SET_VALUE)
                k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, ad, 0, winreg.KEY_SET_VALUE)
                winreg.SetValueEx(k, None, 0, winreg.REG_SZ, install_dir or os.path.dirname(exe_path))
                winreg.CloseKey(k)
                ok = True
            except Exception:
                pass
        logger.info(f"HKCU COM 覆盖{'成功' if ok else '失败'}")
        return ok
    except Exception as e:
        logger.warning(f"HKCU 覆盖异常: {e}")
        return False


def _find_main_window(timeout=10):
    try:
        import win32gui
    except Exception:
        return None
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = []

        def _enum(hwnd, _):
            try:
                if win32gui.GetClassName(hwnd) == MAIN_FORM_CLASS and win32gui.IsWindowVisible(hwnd):
                    found.append(hwnd)
            except Exception:
                pass
            return True

        try:
            win32gui.EnumWindows(_enum, None)
        except Exception:
            pass
        if found:
            return found[0]
        time.sleep(1)
    return None


def _fix_activex_if_needed(hwnd):
    """若当前为「免注册」模式，发 WM_COMMAND 切到「单客户端设置」(id=94)。"""
    if not hwnd:
        return "unknown"
    try:
        import win32gui
        import win32con
        user32 = ctypes.windll.user32
        menu = win32gui.GetMenu(hwnd)
        if not menu:
            return "unknown"
        for i in range(user32.GetMenuItemCount(menu)):
            buf = ctypes.create_unicode_buffer(256)
            user32.GetMenuStringW(menu, i, buf, 256, 0x400)
            if "设置" not in buf.value:
                continue
            sub = user32.GetSubMenu(menu, i)
            if not sub:
                continue
            for j in range(user32.GetMenuItemCount(sub)):
                b2 = ctypes.create_unicode_buffer(256)
                user32.GetMenuStringW(sub, j, b2, 256, 0x400)
                if "注册" not in b2.value:
                    continue
                reg = user32.GetSubMenu(sub, j)
                if not reg:
                    continue
                for k in range(user32.GetMenuItemCount(reg)):
                    b3 = ctypes.create_unicode_buffer(256)
                    user32.GetMenuStringW(reg, k, b3, 256, 0x400)
                    wid = user32.GetMenuItemID(reg, k)
                    checked = bool(user32.GetMenuState(reg, k, 0x400) & 0x8)
                    if not checked:
                        continue
                    if wid == MENU_ID_NO_REGISTER or "免注册" in b3.value:
                        logger.warning("ActiveX 为「免注册」，切换到「单客户端设置」")
                        win32gui.SendMessage(hwnd, win32con.WM_COMMAND, MENU_ID_SINGLE_CLIENT, 0)
                        time.sleep(2)
                        return "fixed"
                    if wid == MENU_ID_SINGLE_CLIENT or "单客户端" in b3.value:
                        return "single"
                    return "multi"
    except Exception as e:
        logger.warning(f"ActiveX 模式检测失败: {e}")
    return "unknown"


def connect(exe_path, install_dir, progid=DEFAULT_PROGID, full_wait=90):
    """建立 COM 连接：快速路径 → 预启动 → 等待 → 重试。返回 COM 对象。"""
    try:
        import pythoncom
        import win32com.client
    except Exception as e:
        raise BridgeError("pywin32_missing",
                          f"缺少 pywin32（pythoncom/win32com）：{e}。请 pip install pywin32")

    pythoncom.CoInitialize()
    _apply_hkcu_override(exe_path, install_dir)

    # 1) 快速路径：Motor-CAD 已在运行
    try:
        mc = win32com.client.Dispatch(progid)
        logger.info("Dispatch 快速路径成功")
        time.sleep(10)
        return mc
    except Exception as e:
        logger.warning(f"Dispatch 快速路径失败: {e}")

    # 2) 预启动：手动拉起 exe（绕开 Dispatch 内部 60s 超时）
    if not exe_path:
        raise BridgeError("motorcad_not_found",
                          "未找到 Motor-CAD 可执行文件，请设置 MOTORCAD_PATH 或 install_dir")
    hwnd = _find_main_window(timeout=5)
    if not hwnd:
        logger.info(f"手动启动 Motor-CAD: {exe_path}")
        try:
            subprocess.Popen([exe_path], cwd=install_dir or os.path.dirname(exe_path),
                             creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        except Exception as e:
            raise BridgeError("launch_failed", f"启动 Motor-CAD 失败: {e}")
        hwnd = _find_main_window(timeout=30)

    mode = _fix_activex_if_needed(hwnd)
    if mode == "fixed":
        logger.info("ActiveX 模式已修复，重启 Motor-CAD 生效")
        subprocess.run(["taskkill", "/F", "/IM", "Motor-CAD.exe"],
                       capture_output=True, timeout=15)
        time.sleep(3)
        subprocess.Popen([exe_path], cwd=install_dir or os.path.dirname(exe_path),
                         creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        _find_main_window(timeout=30)

    # 3) 等待 COM class factory 注册完成（Motor-CAD v11.1.5 需 60-90s）
    logger.info(f"等待 Motor-CAD 完全加载（{full_wait}s）…")
    for waited in range(0, full_wait, 10):
        time.sleep(10)
        logger.info(f"  加载中 {waited + 10}/{full_wait}s")

    for attempt in (1, 2):
        try:
            mc = win32com.client.Dispatch(progid)
            logger.info(f"Dispatch 成功（第 {attempt} 次重试）")
            time.sleep(10)
            return mc
        except Exception as e:
            logger.warning(f"Dispatch 第 {attempt} 次失败: {e}")
            if attempt == 1:
                time.sleep(30)

    raise BridgeError(
        "com_connect_failed",
        "Motor-CAD COM 连接失败。已尝试：HKCU 覆盖 / Dispatch 直连 / 预启动+等待+重试。"
        "常见原因：① ActiveX 模式为「免注册」→ 请切换为「单客户端设置」；"
        "② 32 位 Motor-CAD 与 64 位 Python 的 COM 兼容问题；③ 授权/加密狗异常。")


def _parse_ret(ret):
    if isinstance(ret, tuple) and len(ret) >= 2:
        return (ret[0] >= 0, ret[1])
    if ret is not None:
        return (True, ret)
    return (False, None)


def _get(mc, name, allowed):
    if name not in allowed:
        return None
    try:
        ok, val = _parse_ret(mc.GetVariable(name))
        return val if ok else None
    except Exception:
        return None


def action_ping(req):
    exe, inst = _find_exe(req.get("exe_path", ""), req.get("install_dir", ""))
    pywin32 = True
    try:
        import pythoncom  # noqa: F401
        import win32com.client  # noqa: F401
    except Exception as e:
        pywin32 = False
        logger.warning(f"pywin32 不可用: {e}")
    _emit({
        "ok": True,
        "python": sys.executable,
        "pywin32": pywin32,
        "exe_path": exe,
        "install_dir": inst,
        "exe_exists": bool(exe),
        "progid": req.get("progid") or DEFAULT_PROGID,
        "ready": bool(exe) and pywin32,
    })


def _sanity_gate(emag, rated_w):
    """解算结果 sanity 门（历史 v3 事故防线）。

    背景：450kW 实机 L2 曾出现电流/电压路径未同步时 DoMagneticCalculation
    仍 return=0，但读回 InputPower=24.9MW / 效率 0.51% 的垃圾值——
    **return=0 ≠ 结果可信**。本门在读回功率后与额定功率比对：
      1. 计算效率 < 10%  → 判定数值不可信；
      2. InputPower > 额定×10 → 判定电流路径未同步。
    异常时写 result_warning + result_trusted=False，上层不得静默采信。
    """
    warnings = []
    if not isinstance(emag, dict):
        return warnings
    inp = emag.get("InputPower")
    out = emag.get("OutputPower")
    eff = None
    if (isinstance(inp, (int, float)) and inp > 0
            and isinstance(out, (int, float)) and out >= 0):
        eff = out / inp * 100
        emag["Efficiency_Calculated"] = eff
    if eff is not None and eff < 10.0:
        warnings.append(
            f"计算效率 {eff:.2f}% < 10%：电流/电压路径可能未同步"
            f"（return=0≠结果可信），本次功率/效率数值不可信"
        )
    if (rated_w and isinstance(inp, (int, float)) and inp > rated_w * 10):
        warnings.append(
            f"InputPower {inp:.4g}W 超过额定 {rated_w:.4g}W 的 10 倍："
            f"电流路径可能未同步，本次数值不可信"
        )
    return warnings


def action_verify(req):
    exe, inst = _find_exe(req.get("exe_path", ""), req.get("install_dir", ""))
    if not exe:
        raise BridgeError("motorcad_not_found", "未找到 Motor-CAD，请设置 MOTORCAD_PATH")

    # 先校验 mot 文件（快速失败：避免为一个不存在的模型白等 90s COM 启动）
    mot = req.get("mot_file") or ""
    if mot and not os.path.exists(mot):
        raise BridgeError("mot_not_found", f".mot 文件不存在: {mot}")

    progid = req.get("progid") or DEFAULT_PROGID
    mc = connect(exe, inst, progid, int(req.get("full_load_wait", 90)))
    result = {"ok": True, "method": "motorcad-com-fea", "progid": progid,
              "exe_path": exe, "model": {}, "thermal": {}, "emag": {}}
    started = time.time()
    try:
        if mot:
            logger.info(f"加载 {mot}")
            try:
                mc.LoadFromFile(mot)
            except Exception as e:
                raise BridgeError("load_failed", f"LoadFromFile 失败: {e}")
            time.sleep(8)

        # 设置设计参数（逐个 try，失败不中断）
        applied = {}
        for k, v in (req.get("params") or {}).items():
            try:
                mc.SetVariable(k, v)
                applied[k] = True
            except Exception as e:
                applied[k] = False
                logger.warning(f"SetVariable({k}) 失败: {e}")
        result["applied_params"] = applied

        for name in READABLE_PARAMS:
            v = _get(mc, name, set(READABLE_PARAMS))
            if v is not None:
                result["model"][name] = v

        if req.get("run_thermal", True):
            t0 = time.time()
            try:
                ret = mc.DoSteadyStateAnalysis()
                result["thermal_return"] = ret if isinstance(ret, int) else 0
                result["thermal_elapsed"] = round(time.time() - t0, 1)
                for name in THERMAL_RESULT_VARS:
                    v = _get(mc, name, set(THERMAL_RESULT_VARS))
                    if v is not None:
                        result["thermal"][name] = v
            except Exception as e:
                result["thermal_error"] = str(e)

        if req.get("run_emag", True):
            t0 = time.time()
            try:
                mc.ShowMagneticContext()
                time.sleep(3)
                ret = mc.DoMagneticCalculation()
                result["emag_return"] = ret if isinstance(ret, int) else 0
                result["emag_elapsed"] = round(time.time() - t0, 1)
                for name in EMAG_RESULT_VARS:
                    v = _get(mc, name, set(EMAG_RESULT_VARS))
                    if v is not None:
                        result["emag"][name] = v
                # 效率 + sanity 门（return=0≠可信；异常时 result_warning/result_trusted=False）
                try:
                    sw = _sanity_gate(result.get("emag") or {},
                                      float(req.get("rated_power_w") or 0))
                    if sw:
                        result["result_warning"] = sw
                        result["result_trusted"] = False
                    else:
                        result["result_trusted"] = True
                except Exception as _se:
                    logger.warning(f"sanity gate 自身异常(忽略): {_se}")
                    result["result_trusted"] = None
            except Exception as e:
                result["emag_error"] = str(e)

        save_to = req.get("save_to")
        if save_to:
            try:
                mc.SaveToFile(save_to)
                result["saved_to"] = save_to
            except Exception as e:
                result["save_error"] = str(e)

        result["solve_time"] = round(time.time() - started, 1)
        _emit(result)
    finally:
        try:
            mc = None
            import pythoncom
            pythoncom.CoUninitialize()
        except Exception:
            pass


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        _emit({"ok": False, "reason": "bad_request", "error": f"请求 JSON 解析失败: {e}"})
        return 1

    action = req.get("action", "verify")
    try:
        if action == "ping":
            action_ping(req)
        elif action == "verify":
            action_verify(req)
        else:
            _emit({"ok": False, "reason": "bad_request", "error": f"未知 action: {action}"})
            return 1
        return 0
    except BridgeError as e:
        _emit({"ok": False, "reason": e.reason, "error": str(e)})
        return 2
    except Exception as e:
        _emit({"ok": False, "reason": "unexpected", "error": f"{type(e).__name__}: {e}"})
        return 3


if __name__ == "__main__":
    sys.exit(main())
