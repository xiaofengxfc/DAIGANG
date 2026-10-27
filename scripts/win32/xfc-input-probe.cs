using System;
using System.Runtime.InteropServices;

/**
 * 判断「本程序能不能把按键送到游戏窗口」。
 *
 * 背景（2026-10-27 实测）：鸣潮以管理员身份运行时是**高完整性**进程，
 * 而本程序是普通权限。这种情况下 SetForegroundWindow 照样成功（窗口能切到
 * 前台），但：
 *   · SendInput 返回成功，按键却被 UIPI 静默丢掉 —— 游戏根本没收到；
 *   · PostMessage 直接返回 False（拒绝）。
 * 用户看到的就是「窗口切过去了，但背包/地图没打开」。
 *
 * 这里用一次 PostMessage(WM_NULL) 去探：它不改任何状态，只问「能不能投递」。
 * 独立成文件（不并进 XfcWin32.cs），是为了不动已经跑通的按键/截图那条线。
 */
public class XfcInputProbe
{
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int cls, out int value, int len, out int returned);

    static bool Elevated(uint pid)
    {
        IntPtr hp = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (hp == IntPtr.Zero) return false;
        IntPtr tok;
        bool ok = OpenProcessToken(hp, 0x0008 /* TOKEN_QUERY */, out tok);
        int value = -1;
        int returned = 0;
        // TokenElevation = 20：返回一个 DWORD，1 表示这个进程是提权的
        bool got = ok && GetTokenInformation(tok, 20, out value, 4, out returned);
        CloseHandle(hp);
        return got && value == 1;
    }

    public static string Probe(ulong hwnd, uint pid)
    {
        bool postOk = PostMessage(new IntPtr((long)hwnd), 0 /* WM_NULL */, IntPtr.Zero, IntPtr.Zero);
        int postErr = Marshal.GetLastWin32Error();
        bool selfElevated = Elevated((uint)System.Diagnostics.Process.GetCurrentProcess().Id);
        bool targetElevated = Elevated(pid);
        // 判据只看双方完整性：UIPI 的规则是「低完整性不许向高完整性投递输入」，
        // 而 WM_NULL 恰好在它的放行名单里（实测 post_ok=true，但真实的 B 键投递是 False），
        // 所以 post_ok 只留作排查参考，不参与判断。
        bool inputOk = !(targetElevated && !selfElevated);
        return "{\"post_ok\":" + (postOk ? "true" : "false")
             + ",\"post_err\":" + postErr
             + ",\"self_elevated\":" + (selfElevated ? "true" : "false")
             + ",\"target_elevated\":" + (targetElevated ? "true" : "false")
             + ",\"input_ok\":" + (inputOk ? "true" : "false") + "}";
    }
}
