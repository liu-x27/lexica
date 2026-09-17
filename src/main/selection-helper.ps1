#requires -version 5
<#
  Lexica 划词取词辅助进程。

  由主进程常驻拉起，通过 stdin 收命令、stdout 回 JSON（每行一条）。
  之所以要常驻：powershell.exe 冷启动实测 256ms，每次取词都拉一个根本没法用。

  取词两条路：
    1. UI Automation —— 读焦点元素的 TextPattern 选区。不碰剪贴板、无副作用，
       但只有实现了 Text 模式的程序才支持（浏览器、Office、WPF/Electron 应用）。
    2. 模拟 Ctrl+C —— 兜底。几乎所有程序都支持复制，代价是会动剪贴板，
       所以取词前后要备份并还原。

  鼠标划词用 GetAsyncKeyState 轮询按键状态，不装全局钩子：
  WH_MOUSE_LL 的回调要在带消息循环的线程里跑，跨进程回调 JS 极易出问题，
  而 40ms 一次的轮询 CPU 占用可以忽略。

  注意：本文件含中文，必须以 UTF-8 BOM 保存，
  否则 PowerShell 5.1 会按 GBK 解码导致字符串解析出错（scripts/check-bom.mjs 会校验）。
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LexNative {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  /* INPUT 是个联合体，大小由最大成员 MOUSEINPUT 决定（x64 上 40 字节）。
     只声明 KEYBDINPUT 会让 Marshal.SizeOf 算成 32，cbSize 不对时
     SendInput 直接返回 0 并报 ERROR_INVALID_PARAMETER(87)——这个坑踩过。 */
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT {
    public uint uMsg; public ushort wParamL; public ushort wParamH;
  }
  [StructLayout(LayoutKind.Explicit)] public struct UNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }

  /* 依次按下再逆序抬起。用 SendInput 而不是 SendKeys：
     SendKeys 走的是更高层的封装，遇到某些程序会静默失效。 */
  public static uint SendCombo(ushort[] vks) {
    var list = new List<INPUT>();
    foreach (var v in vks) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = v; list.Add(i); }
    for (int k = vks.Length - 1; k >= 0; k--) {
      var i = new INPUT(); i.type = 1; i.u.ki.wVk = vks[k]; i.u.ki.dwFlags = 2; list.Add(i);
    }
    var arr = list.ToArray();
    return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

$VK_LBUTTON = 0x01

function Write-Msg($obj) {
  # ConvertTo-Json 默认会把长字符串折行，-Compress 保证一条消息一行
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

function Get-CursorInfo {
  $p = New-Object LexNative+POINT
  [void][LexNative]::GetCursorPos([ref]$p)
  $hwnd = [LexNative]::GetForegroundWindow()
  # 不能用 $pid：那是 PowerShell 的只读自动变量（当前进程 ID），赋值会直接报错
  $procId = 0
  [void][LexNative]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  return @{ x = $p.X; y = $p.Y; pid = $procId }
}

<# 路线一：UI Automation 直接读选区，无副作用 #>
function Get-SelectionViaUia {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $el) { return $null }
    $pat = $null
    if (-not $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) {
      return $null
    }
    $ranges = $pat.GetSelection()
    if (-not $ranges -or $ranges.Count -eq 0) { return $null }
    $sb = New-Object System.Text.StringBuilder
    foreach ($r in $ranges) { [void]$sb.Append($r.GetText(400)) }
    $t = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($t)) { return $null }
    return $t
  } catch {
    return $null
  }
}

<#
  路线二：模拟 Ctrl+C 并还原剪贴板。
  先清空剪贴板再复制，这样「没选中任何东西」时读到的是空，
  而不是把上一次的剪贴板内容误当成选区。
#>
function Get-SelectionViaCopy {
  # 备份要把各格式的「值」取出来存着。
  # 直接留住 GetDataObject() 返回的那个 IDataObject 是不行的：
  # 它只是指向系统剪贴板的活引用，清空剪贴板后再拿去 SetDataObject 会失败，
  # 结果就是用户原来的剪贴板内容被我们弄丢（实测踩过）。
  $backup = @{}
  try {
    $data = [System.Windows.Forms.Clipboard]::GetDataObject()
    if ($null -ne $data) {
      foreach ($fmt in $data.GetFormats()) {
        try {
          $v = $data.GetData($fmt)
          if ($null -ne $v) { $backup[$fmt] = $v }
        } catch { }
      }
    }
  } catch { }

  $text = $null
  try {
    # 先清空：这样「什么都没选中」时读到的是空，
    # 而不是把上一次的剪贴板内容误当成本次选区
    try { [System.Windows.Forms.Clipboard]::Clear() } catch { }
    [void][LexNative]::SendCombo(@([uint16]0x11, [uint16]0x43))   # Ctrl + C
    # 给目标程序时间把内容放进剪贴板
    Start-Sleep -Milliseconds 160
    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
      $text = [System.Windows.Forms.Clipboard]::GetText()
    }
  } catch {
    $text = $null
  } finally {
    try {
      if ($backup.Count -gt 0) {
        $restore = New-Object System.Windows.Forms.DataObject
        foreach ($fmt in $backup.Keys) {
          try { $restore.SetData($fmt, $backup[$fmt]) } catch { }
        }
        [System.Windows.Forms.Clipboard]::SetDataObject($restore, $true)
      }
    } catch { }
  }

  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return $text
}

function Get-Selection([bool]$allowCopy) {
  $t = Get-SelectionViaUia
  if ($t) { return @{ text = $t; via = 'uia' } }
  if ($allowCopy) {
    $t = Get-SelectionViaCopy
    if ($t) { return @{ text = $t; via = 'clipboard' } }
  }
  return $null
}

<# ---------------------------------------------------------------- 主循环 #>

$watch = $false
$allowCopy = $true
$minDrag = 6          # 拖动距离小于这个像素数就当成普通点击，不算划词
$downPos = $null
$wasDown = $false

$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
$pending = $stdin.ReadLineAsync()

<#
  本进程跑在 STA（剪贴板 API 要求），而 UIA 是跨进程 COM 调用，
  STA 线程必须泵消息才能完成封送——只 Start-Sleep 不泵消息的话，
  FocusedElement / GetSelection 会读不到东西（实测就是一直返回空）。
  所以每个循环间隔都拆成若干小片，中间穿插 DoEvents。
#>
function Wait-Pumped([int]$ms) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)
  while ([DateTime]::UtcNow -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 10
  }
}

Write-Msg @{ event = 'ready'; pid = $PID }

while ($true) {
  # 非阻塞地取一行命令：ReadLineAsync 返回 Task，轮询它的完成状态
  if ($pending.IsCompleted) {
    $line = $pending.Result
    if ($null -eq $line) { break }   # stdin 关闭，主进程退出了
    $pending = $stdin.ReadLineAsync()

    $parts = $line.Trim() -split '\s+', 2
    switch ($parts[0]) {
      'quit' { break }
      'ping' { Write-Msg @{ event = 'pong' } }
      'watch' {
        $watch = ($parts.Count -gt 1 -and $parts[1] -eq 'on')
        $wasDown = $false
        Write-Msg @{ event = 'watch'; on = $watch }
      }
      'copyfallback' {
        $allowCopy = ($parts.Count -gt 1 -and $parts[1] -eq 'on')
        Write-Msg @{ event = 'copyfallback'; on = $allowCopy }
      }
      'diag' {
        # 排查用：报告本进程视角下的焦点元素，取不到词时先看这个
        $info = Get-CursorInfo
        $d = @{ event = 'diag'; fgPid = $info.pid }
        try {
          $el = [System.Windows.Automation.AutomationElement]::FocusedElement
          if ($el) {
            $d.name = $el.Current.Name
            $d.className = $el.Current.ClassName
            $d.controlType = $el.Current.ControlType.ProgrammaticName
            $d.elementPid = $el.Current.ProcessId
            $d.framework = $el.Current.FrameworkId
            $pats = @()
            foreach ($p in $el.GetSupportedPatterns()) { $pats += $p.ProgrammaticName }
            $d.patterns = $pats
            $tp = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
              $s = $tp.GetSelection()
              $d.selCount = $s.Count
              if ($s.Count -gt 0) { $d.selText = $s[0].GetText(120) }
            }
          } else { $d.focused = 'null' }
        } catch { $d.error = $_.Exception.Message }
        Write-Msg $d
      }
      'get' {
        $info = Get-CursorInfo
        $r = Get-Selection $allowCopy
        if ($r) {
          Write-Msg @{ event = 'selection'; text = $r.text; via = $r.via; x = $info.x; y = $info.y; pid = $info.pid; requested = $true }
        } else {
          Write-Msg @{ event = 'selection'; text = ''; via = 'none'; requested = $true }
        }
      }
      default { }
    }
  }

  if ($watch) {
    # 最高位为 1 表示当前按下
    $down = ([LexNative]::GetAsyncKeyState($VK_LBUTTON) -band 0x8000) -ne 0
    if ($down -and -not $wasDown) {
      $downPos = Get-CursorInfo
      $wasDown = $true
    } elseif (-not $down -and $wasDown) {
      $wasDown = $false
      $up = Get-CursorInfo
      if ($downPos) {
        $dx = [Math]::Abs($up.x - $downPos.x)
        $dy = [Math]::Abs($up.y - $downPos.y)
        # 只有「按下后拖了一段再松开」才算划词，单纯点击不触发
        if ($dx -ge $minDrag -or $dy -ge $minDrag) {
          # 等一下让目标程序把选区状态更新好
          Start-Sleep -Milliseconds 90
          $r = Get-Selection $allowCopy
          if ($r) {
            Write-Msg @{ event = 'selection'; text = $r.text; via = $r.via; x = $up.x; y = $up.y; pid = $up.pid; requested = $false }
          }
        }
      }
      $downPos = $null
    }
  }

  Wait-Pumped 40
}
