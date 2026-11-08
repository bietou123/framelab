param(
  [switch]$SoftwareRenderer,
  [switch]$Diagnostic,
  [switch]$Packaged
)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace FrameLabTest -Name ErrorMode -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);'
[FrameLabTest.ErrorMode]::SetErrorMode(0x0001 -bor 0x0002 -bor 0x8000) | Out-Null
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$arguments = @('tests/e2e.ts')
if ($SoftwareRenderer) { $arguments += '--software-renderer' }
if ($Diagnostic) { $arguments += '--diagnostic' }
if ($Packaged) {
  $env:FRAMELAB_E2E_EXECUTABLE = Join-Path $root 'release\win-unpacked\FrameLab.exe'
  if (-not (Test-Path -LiteralPath $env:FRAMELAB_E2E_EXECUTABLE -PathType Leaf)) { throw 'Build the Windows directory package first.' }
}
& node (Join-Path $root 'node_modules\tsx\dist\cli.mjs') @arguments
exit $LASTEXITCODE
