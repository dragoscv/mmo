<#
.SYNOPSIS
  Packages MixAI TV for LG webOS (.ipk) from the same build as the Tizen .wgt (WP17-23, ADR-0013 D46).
.DESCRIPTION
  webOS TV runs web apps from file:// on Chromium 53-120, exactly like Tizen, so the plugin-legacy `dist/` is reused:
    1. vite build (unless -SkipBuild)
    2. stage dist/ + webos/appinfo.json (version synced from package.json) + icons into webos-out/app
    3. ares-package (from @webos-tools/cli, run via pnpm dlx) -> webos-out/ro.mixai.tv_<ver>_all.ipk
  Install on a TV in Developer Mode: ares-setup-device, then ares-install --device <name> <ipk>.
#>
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
Set-Location $app
$ver = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $SkipBuild) { pnpm build; if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" } }
if (-not (Test-Path dist/index.html)) { throw 'dist/index.html missing' }

$out = Join-Path $app 'webos-out'
$stage = Join-Path $out 'app'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item dist/* $stage -Recurse

# Samsung's webapis loader would 404 on webOS (harmless) but keep the page clean.
$idx = Join-Path $stage 'index.html'
$html = [IO.File]::ReadAllText($idx) -replace '<script src="\$WEBAPIS/webapis/webapis.js"></script>', ''
[IO.File]::WriteAllText($idx, $html, [Text.UTF8Encoding]::new($false))

$info = Get-Content webos/appinfo.json -Raw | ConvertFrom-Json
$info.version = $ver
[IO.File]::WriteAllText((Join-Path $stage 'appinfo.json'), ($info | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
# LG wants 80x80 icon + 130x130 largeIcon; the Tizen icon.png is upscaled by the launcher if smaller.
Copy-Item icon.png (Join-Path $stage 'icon.png')
Copy-Item icon.png (Join-Path $stage 'largeIcon.png')

$ipk = Join-Path $out "ro.mixai.tv_${ver}_all.ipk"
if (Test-Path $ipk) { Remove-Item $ipk -Force }
# `pnpm dlx` refuses the CLI's optional native deps (ssh2/cpu-features, device install only; ERR_PNPM_IGNORED_BUILDS),
# so the pinned CLI runs through npx with install scripts off — packaging needs none of them.
$env:npm_config_ignore_scripts = 'true'
npx --yes -p @webos-tools/cli@3.2.6 ares-package $stage -o $out --no-minify
if ($LASTEXITCODE -ne 0) { throw "ares-package failed ($LASTEXITCODE)" }
if (-not (Test-Path $ipk)) { $ipk = (Get-ChildItem $out -Filter '*.ipk' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
"IPK=$ipk ($([math]::Round((Get-Item $ipk).Length / 1KB)) KB, version $ver)"
