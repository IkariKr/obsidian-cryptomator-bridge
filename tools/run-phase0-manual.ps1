$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$cli = 'C:\Users\41382\AppData\Local\Programs\Cryptomator CLI\0.6.2\cryptomator-cli.exe'
$vault = 'C:\Users\41382\Desktop\Temp\Test'
$mount = 'C:\Users\41382\AppData\Local\Temp\obsidian-cryptomator-bridge-phase0-mount'
$mounter = 'org.cryptomator.frontend.fuse.mount.WinFspMountProvider'

Set-Location -LiteralPath $root
& node 'tools\phase0-cli-harness.mjs' `
  --cli $cli `
  --vault $vault `
  --mount $mount `
  --mounter $mounter `
  --stop-mode manual `
  --timeout-ms 30000
