#Requires -Version 7
<#
.SYNOPSIS
  Generate the MixAI Decks UniFFI bindings (Swift + Kotlin) from the host decks-ffi library.

.DESCRIPTION
  1. cargo build -p decks-ffi (debug, host target) -> decks_ffi.dll / libdecks_ffi.so / .dylib
  2. uniffi-bindgen (decks-ffi, feature `cli`) generate --library <host lib>
     -> apps/mixai/bindings/swift  (DecksFFI.swift, decks_ffiFFI.h, decks_ffiFFI.modulemap)
     -> apps/mixai/bindings/kotlin (ro/mixai/decks/ffi/decks_ffi.kt)
  The output folder is gitignored; native apps regenerate it in their build.
  Honours CARGO_TARGET_DIR. Exit code != 0 on any failure.

.EXAMPLE
  pwsh -NoProfile -File apps/mixai/scripts/gen-decks-bindings.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('swift', 'kotlin', 'all')]
    [string]$Language = 'all'
)
$ErrorActionPreference = 'Stop'

$mixai = Split-Path -Parent $PSScriptRoot
$workspace = Join-Path $mixai 'src-tauri'
$manifest = Join-Path $workspace 'Cargo.toml'
$outRoot = Join-Path $mixai 'bindings'

function Invoke-Cargo([string[]]$CargoArgs) {
    Write-Host "> cargo $($CargoArgs -join ' ')"
    & cargo @CargoArgs
    if ($LASTEXITCODE -ne 0) { throw "cargo $($CargoArgs[0]) failed with exit code $LASTEXITCODE" }
}

# Library-mode uniffi-bindgen runs `cargo metadata` in the current directory (to find
# uniffi.toml), so every cargo call runs from the workspace root.
Push-Location -LiteralPath $workspace
try {
  Invoke-Cargo @('build', '--manifest-path', $manifest, '-p', 'decks-ffi', '--lib')

  $targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $workspace 'target' }
  $libName = if ($IsWindows) { 'decks_ffi.dll' } elseif ($IsMacOS) { 'libdecks_ffi.dylib' } else { 'libdecks_ffi.so' }
  $lib = Join-Path $targetDir (Join-Path 'debug' $libName)
  if (-not (Test-Path -LiteralPath $lib)) { throw "host library not found: $lib" }

  $languages = if ($Language -eq 'all') { @('swift', 'kotlin') } else { @($Language) }
  foreach ($lang in $languages) {
    $out = Join-Path $outRoot $lang
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
    New-Item -ItemType Directory -Path $out -Force | Out-Null
    Invoke-Cargo @(
      'run', '--manifest-path', $manifest, '-p', 'decks-ffi', '--features', 'cli',
      '--bin', 'uniffi-bindgen', '--', 'generate', '--library', $lib,
      '--language', $lang, '--out-dir', $out
    )
  }
}
finally {
  Pop-Location
}

Write-Host ''
Write-Host 'Generated bindings:'
Get-ChildItem -LiteralPath $outRoot -Recurse -File |
    ForEach-Object { '{0,10:N0}  {1}' -f $_.Length, [IO.Path]::GetRelativePath($mixai, $_.FullName) }
