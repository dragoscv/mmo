<#
.SYNOPSIS
  Idempotently create the mixai.ro DNS records on Cloudflare.
  Token/zone come from a gitignored env file (never printed).
  apex + www → Vercel (76.76.21.21 / cname.vercel-dns.com), api → Cloud Run gateway
  (CNAME ghs.googlehosted.com — requires a Cloud Run domain mapping for api.mixai.ro),
  staging → Vercel. device-<id> records are created by the companion tunnel at runtime.
#>
param([string]$EnvFile = "$PSScriptRoot\..\.copilot-tmp\cloudflare.env")
$ErrorActionPreference = "Stop"
$kv = @{}; Get-Content $EnvFile | ForEach-Object { $k,$v = $_ -split '=',2; $kv[$k.Trim()] = $v.Trim() }
$h = @{ Authorization = "Bearer $($kv.CLOUDFLARE_API_TOKEN)"; 'Content-Type' = 'application/json' }
$base = 'https://api.cloudflare.com/client/v4'
$zone = (Invoke-RestMethod "$base/zones?name=$($kv.CLOUDFLARE_ZONE)" -Headers $h).result[0]
"zone $($zone.name) status=$($zone.status)"
$want = @(
    @{ type='A';     name='mixai.ro';         content='76.76.21.21';           proxied=$false },
    @{ type='CNAME'; name='www.mixai.ro';     content='cname.vercel-dns.com';  proxied=$false },
    @{ type='CNAME'; name='staging.mixai.ro'; content='cname.vercel-dns.com';  proxied=$false },
    @{ type='CNAME'; name='api.mixai.ro';     content='ghs.googlehosted.com';  proxied=$false }
)
$existing = (Invoke-RestMethod "$base/zones/$($zone.id)/dns_records?per_page=200" -Headers $h).result
foreach ($r in $want) {
    $cur = $existing | Where-Object { $_.name -eq $r.name -and $_.type -eq $r.type }
    $body = ($r + @{ ttl = 1 }) | ConvertTo-Json -Compress
    if ($cur) {
        if ($cur.content -ne $r.content) { Invoke-RestMethod "$base/zones/$($zone.id)/dns_records/$($cur.id)" -Method Put -Headers $h -Body $body | Out-Null; "updated $($r.type) $($r.name) -> $($r.content)" }
        else { "ok      $($r.type) $($r.name) -> $($r.content)" }
    } else {
        Invoke-RestMethod "$base/zones/$($zone.id)/dns_records" -Method Post -Headers $h -Body $body | Out-Null
        "created $($r.type) $($r.name) -> $($r.content)"
    }
}
"nameservers to set at the registrar: $($zone.name_servers -join ', ')"
