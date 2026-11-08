param([string]$Name)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root 'release'
$source = Join-Path $release 'win-unpacked'
if (-not (Test-Path -LiteralPath (Join-Path $source 'FrameLab.exe') -PathType Leaf)) { throw 'Run npm.cmd run package:dir first.' }
if (-not $Name) {
  $package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $Name = "FrameLab-$($package.version)-win-x64.zip"
}
if ($Name -notmatch '^[A-Za-z0-9._-]+\.zip$') { throw 'Name must be a ZIP filename, not a path.' }
$output = Join-Path $release $Name
if (Test-Path -LiteralPath $output) { throw "Refusing to overwrite $output. Select a new -Name." }
$temporary = Join-Path $release ("framelab-" + [guid]::NewGuid().ToString() + '.tmp')
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
try {
  $sourcePrefix = [System.IO.Path]::GetFullPath($source).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $archive = [System.IO.Compression.ZipFile]::Open($temporary, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in Get-ChildItem -LiteralPath $source -File -Recurse -Force) {
      if (-not $file.FullName.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "File is outside package root: $($file.FullName)" }
      # Windows PowerShell's CreateFromDirectory can write nonstandard backslash entries.
      $entryName = $file.FullName.Substring($sourcePrefix.Length).Replace([System.IO.Path]::DirectorySeparatorChar, [char]'/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    }
  } finally { $archive.Dispose() }
  $archive = [System.IO.Compression.ZipFile]::OpenRead($temporary)
  try {
    foreach ($entry in @('FrameLab.exe', 'resources/app.asar', 'resources/native/ffmpeg.exe', 'resources/native/ffprobe.exe', 'resources/native/FFmpeg-LICENSE.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html')) {
      if (-not $archive.GetEntry($entry)) { throw "ZIP is missing $entry" }
    }
  } finally { $archive.Dispose() }
  Move-Item -LiteralPath $temporary -Destination $output
  $hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
  [System.IO.File]::WriteAllText("$output.sha256", "$hash  $Name`n", [System.Text.UTF8Encoding]::new($false))
  Write-Output "ZIP: $output"
  Write-Output "Bytes: $((Get-Item -LiteralPath $output).Length)"
  Write-Output "SHA256: $hash"
} finally {
  if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary }
}
