# popup.ps1 - Top-most modal message box for pending-invoice-checker scheduled task.
#
# Usage (direct, ASCII only):
#   powershell -NoProfile -File popup.ps1 -Title "Title" -Message "Body" -Icon Information
#
# Usage (UTF-8 JSON file, recommended for Chinese text):
#   powershell -NoProfile -File popup.ps1 -MsgFile "C:\path\to\msg.json"
#   where msg.json = {"title":"...","message":"...","icon":"Information"}
#
# icon: Information | Warning | Error

param(
    [string]$Title   = "Notice",
    [string]$Message = "",
    [string]$Icon    = "Information",
    [string]$MsgFile = ""
)

if ($MsgFile -ne "" -and (Test-Path -LiteralPath $MsgFile)) {
    try {
        $raw  = [System.IO.File]::ReadAllText($MsgFile, [System.Text.Encoding]::UTF8)
        $data = $raw | ConvertFrom-Json
        if ($data.title)   { $Title   = [string]$data.title }
        if ($data.message) { $Message = [string]$data.message }
        if ($data.icon)    { $Icon    = [string]$data.icon }
    } catch {
        $Message = "Failed to read popup message file: $MsgFile"
    }
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeMsgBox {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);
}
"@

$MB_OK              = 0x00000000
$MB_SETFOREGROUND   = 0x00010000
$MB_TOPMOST         = 0x00040000
$MB_ICONINFORMATION = 0x00000040
$MB_ICONWARNING     = 0x00000030
$MB_ICONERROR       = 0x00000010

switch ($Icon) {
    "Warning" { $flags = $MB_OK -bor $MB_ICONWARNING }
    "Error"   { $flags = $MB_OK -bor $MB_ICONERROR }
    default   { $flags = $MB_OK -bor $MB_ICONINFORMATION }
}
$flags = $flags -bor $MB_SETFOREGROUND -bor $MB_TOPMOST

[void][NativeMsgBox]::MessageBoxW([IntPtr]::Zero, $Message, $Title, $flags)
