<#
.SYNOPSIS
  MixAI Music desktop — Microsoft Store MSIX (WP17-43). Wraps the shared scripts/package-msix.ps1.
.DESCRIPTION
  Product 9PC31TGKW4FP. -IdentityName must be the Partner Center "Package/Identity/Name" (Product identity page).
  Needs `pnpm tauri build --no-bundle` first (release exe) and `pnpm tauri:icon` (icons are gitignored).
  The mixai-music: protocol is declared through -Protocol (uap:Protocol extension) so links open the Store app.
#>
param(
    [string]$IdentityName = 'DragosCatalin.MixAIMusic',
    [string]$TargetDir = '',
    [switch]$TestSign
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$args2 = @{
    App = 'apps/music-desktop'; Exe = 'mixai-music.exe'; IdentityName = $IdentityName
    DisplayName = 'MixAI Music'; Description = 'Your MixAI Server music on the desktop'
    FilePrefix = 'MixAIMusic'; AppId = 'MixAIMusic'; Protocol = 'mixai-music'
}
if ($TargetDir) { $args2.TargetDir = $TargetDir }
if ($TestSign) { $args2.TestSign = $true }
& (Join-Path $repo 'scripts\package-msix.ps1') @args2
