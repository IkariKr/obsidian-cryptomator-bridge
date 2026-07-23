param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, [uint32]::MaxValue)]
    [uint32]$ProcessGroupId
)

$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class Phase0ConsoleControl
{
    [DllImport("Kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("Kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint processId);

    [DllImport("Kernel32.dll", SetLastError = true)]
    public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);
}
'@

Add-Type -TypeDefinition $source -ErrorAction Stop

# Detach from the caller console before attaching to the target CLI console.
[void][Phase0ConsoleControl]::FreeConsole()

try {
    if (-not [Phase0ConsoleControl]::AttachConsole($ProcessGroupId)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw [ComponentModel.Win32Exception]::new($code, "Unable to attach to the target CLI console (Win32 error $code)")
    }

    # CTRL_BREAK_EVENT (1) targets the dedicated process group without forced termination.
    if (-not [Phase0ConsoleControl]::GenerateConsoleCtrlEvent(1, $ProcessGroupId)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw [ComponentModel.Win32Exception]::new($code, "Unable to send CTRL_BREAK_EVENT to the target CLI process group (Win32 error $code)")
    }

    Write-Output 'CTRL_BREAK_SENT'
}
finally {
    [void][Phase0ConsoleControl]::FreeConsole()
}
