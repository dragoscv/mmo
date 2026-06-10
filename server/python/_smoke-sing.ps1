#!/usr/bin/env pwsh
# Quick smoke test of tts.py "sing" mode end-to-end.
# Pipes one JSON job to the python script and prints the result.
$ErrorActionPreference = "Stop"
$out = Join-Path $env:TEMP "mmo-sing-smoke.wav"
$job = @{
    id     = [guid]::NewGuid().ToString()
    kind   = "sing"
    text   = "hello world testing"
    voice  = "female"
    tempo  = 120
    melody = @(
        @{ beat = 0;   durationBeats = 0.5; midiPitch = 60 },
        @{ beat = 0.5; durationBeats = 0.5; midiPitch = 62 },
        @{ beat = 1;   durationBeats = 0.5; midiPitch = 64 },
        @{ beat = 1.5; durationBeats = 1.0; midiPitch = 67 }
    )
    outPath = $out
} | ConvertTo-Json -Compress -Depth 5

Write-Host "[smoke] OUT=$out"
$job | python (Join-Path $PSScriptRoot tts.py) 2>&1 | ForEach-Object { Write-Host $_ }
if (Test-Path $out) { Write-Host "[smoke] wav size: $((Get-Item $out).Length) bytes" }
