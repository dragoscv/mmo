<#
.SYNOPSIS
  Idempotently create the mixai.ro DNS records on Cloudflare.
  Token/zone come from a gitignored env file (never printed).
    apex + www → Cloud Run domain mappings of mixai-web (mmo-mw-prod/europe-west1; apex = the
    4 A + 4 AAAA Google frontends, www = CNAME ghs.googlehosted.com), demo → demo VM (WP16-53).
    All DNS-only (proxied=false) so Google can issue the managed certificate. Records of the
    same name+type that are not wanted are deleted (only for the names listed here).
    device-<id> records are created by the companion tunnel at runtime and are never touched.
#>
param([string]$EnvFile = "$PSScriptRoot\..\.copilot-tmp\cloudflare.env")
$ErrorActionPreference = "Stop"
$kv = @{}; Get-Content $EnvFile | ForEach-Object { $k,$v = $_ -split '=',2; $kv[$k.Trim()] = $v.Trim() }
$h = @{ Authorization = "Bearer $($kv.CLOUDFLARE_API_TOKEN)"; 'Content-Type' = 'application/json' }
$base = 'https://api.cloudflare.com/client/v4'
# CLOUDFLARE_ZONE may hold the zone id (32 hex) or the zone name
if ($kv.CLOUDFLARE_ZONE -match '^[0-9a-f]{32}$') { $zone = (Invoke-RestMethod "$base/zones/$($kv.CLOUDFLARE_ZONE)" -Headers $h).result }
else { $zone = (Invoke-RestMethod "$base/zones?name=$($kv.CLOUDFLARE_ZONE)" -Headers $h).result[0] }
if (-not $zone) { throw "zone $($kv.CLOUDFLARE_ZONE) not visible to this token" }
"zone $($zone.name) status=$($zone.status)"
$want = @()
foreach ($ip in '216.239.32.21','216.239.34.21','216.239.36.21','216.239.38.21') { $want += @{ type='A'; name='mixai.ro'; content=$ip } }
foreach ($ip in '2001:4860:4802:32::15','2001:4860:4802:34::15','2001:4860:4802:36::15','2001:4860:4802:38::15') { $want += @{ type='AAAA'; name='mixai.ro'; content=$ip } }
$want += @{ type='CNAME'; name='www.mixai.ro';  content='ghs.googlehosted.com' }
$want += @{ type='A';     name='demo.mixai.ro'; content='34.118.46.71' }
$existing = (Invoke-RestMethod "$base/zones/$($zone.id)/dns_records?per_page=200" -Headers $h).result
$managedNames = $want | ForEach-Object { $_.name } | Sort-Object -Unique
# a CNAME cannot coexist with other types on the same name: drop conflicting records first
foreach ($cur in $existing | Where-Object { $managedNames -contains $_.name -and $_.type -in 'A','AAAA','CNAME' }) {
    $keep = $want | Where-Object { $_.name -eq $cur.name -and $_.type -eq $cur.type -and $_.content -eq $cur.content }
    if (-not $keep) {
        Invoke-RestMethod "$base/zones/$($zone.id)/dns_records/$($cur.id)" -Method Delete -Headers $h | Out-Null
        "deleted $($cur.type) $($cur.name) -> $($cur.content)"
    }
}
foreach ($r in $want) {
    $cur = $existing | Where-Object { $_.name -eq $r.name -and $_.type -eq $r.type -and $_.content -eq $r.content } | Select-Object -First 1
    $body = ($r + @{ ttl = 1; proxied = $false }) | ConvertTo-Json -Compress
    if ($cur -and -not $cur.proxied) { "ok      $($r.type) $($r.name) -> $($r.content)" }
    elseif ($cur) { Invoke-RestMethod "$base/zones/$($zone.id)/dns_records/$($cur.id)" -Method Put -Headers $h -Body $body | Out-Null; "unproxied $($r.type) $($r.name) -> $($r.content)" }
    else {
        Invoke-RestMethod "$base/zones/$($zone.id)/dns_records" -Method Post -Headers $h -Body $body | Out-Null
        "created $($r.type) $($r.name) -> $($r.content)"
    }
}
"nameservers to set at the registrar: $($zone.name_servers -join ', ')"
