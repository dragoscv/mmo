# ⚡ Performanța build-urilor — măsurători și reguli

> Toate build-urile din monorepo se măsoară cu `scripts/measure-builds.ps1`.
> Numerele de mai jos sunt **măsurate** (2026-09-18, Windows 11, RTX 3060 Ti PC,
> Node 22, pnpm 10), nu estimate. Re-măsoară după orice schimbare de tooling.

[🏠 Home](../../README.md) · [🏗️ Arhitectură](README.md)

---

## 1. Rezumat

| Țintă | Cold ÎNAINTE | Cold DUPĂ | Warm ÎNAINTE | Warm DUPĂ | Output | Ce s-a schimbat |
|---|---:|---:|---:|---:|---:|---|
| web (Next 16.3, Turbopack) | — | — | 191,6 s (compile 48 s) | 88,3 s (compile 5,6 s) | 941 MB `.next` | alias Turbopack relativ (fix Windows); cache Turbopack persistent |
| server (tsc) | 11,0 s | 9,4 s | 9,5 s | **4,7 s** | 1,1 MB | `incremental` + `tsBuildInfoFile` |
| gateway (tsup) | 4,1 s | 4,1 s | 2,4 s | 8,0 s* | 0,4 MB | `splitting:false`, `minify:false`, `treeshake:true`, sourcemap doar non-prod |
| mixai (tsc + vite) | 10,7 s | 12,3 s | 16,2 s | **7,0 s** | 0,3 MB | `incremental`, `reportCompressedSize:false` |
| tv-tizen (tsc + vite legacy) | 17,6 s | 19,3 s | 19,6 s | **14,5 s** | 0,9 MB | `incremental`, `sourcemap:false`, `reportCompressedSize:false` |
| tv-android (Gradle) | 10,0 s | 18,2 s** | 6,9 s | 7,5 s | 14,5 MB APK | `parallel`, `kotlin.incremental`, in-process, `-Xmx3g -XX:+UseParallelGC` |
| pkg-ai (tsc --noEmit) | 1,5 s | 1,5 s | 1,7 s | 1,5 s | — | `incremental` |
| pkg-db | skipped | skipped | — | — | — | nu are `tsconfig.json`; e verificat prin `apps/web` |

\* gateway warm: zgomot de mașină (rulări succesive 2,4 / 4,3 / 8,0 s; bundle-ul
e 122 KB, tsup termină sub 1 s — restul e pornirea pnpm/node). Nicio regresie
atribuibilă configului.
\*\* tv-android „cold” șterge doar `app/build` + `.gradle`; prima rulare după
schimbarea `gradle.properties` a repornit daemon-ul Gradle („1 incompatible
Daemon could not be reused”) → 37,7 s, apoi 18,2 s. Warm-ul (cel relevant zi
de zi) e neschimbat: ~7 s, 21/37 task-uri din cache.

Web nu are „cold” în tabel: `.next` are 0,9 GB și un cold via wrapper durează
~2,5 min; s-a măsurat o singură dată per etapă cu `-NoCold`. Diferența 191 →
88 s vine în principal din cache-ul Turbopack deja umplut de rularea anterioară
(compile 48 s → 5,6 s); configul web NU a fost schimbat pentru viteză.

## 2. Ce s-a schimbat, per țintă

### Turbopack pentru `apps/web`
`next build` rulează deja pe Turbopack (commit `e837d87`, WP1); `build:webpack`
rămâne doar ca escape hatch. Nu există niciun blocker documentat, deci nu a fost
nevoie de nicio schimbare de bundler.

Un fix a fost totuși necesar: `turbopack.resolveAlias` folosea căi absolute
(`resolve(__dirname, "node_modules", p)`), iar pe Windows Turbopack răspunde
`Module not found ... windows imports are not implemented yet`. Aliasurile sunt
acum relative (`./node_modules/<pkg>`). Build-ul a fost verificat: exit 0, toate
rutele compilate.

### `incremental` + `tsBuildInfoFile` (server, packages/ai, mixai, tv-tizen)
`node_modules/.cache/tsbuildinfo` — în `node_modules`, deci gitignored implicit
(`git check-ignore` confirmă). Câștig real la warm: server 9,5 → 4,7 s, mixai
16,2 → 7,0 s, tv-tizen 19,6 → 14,5 s.

### tsup (gateway)
Un singur entry pentru Cloud Run → `splitting:false`; `minify:false` păstrează
stack trace-uri lizibile; `treeshake:true`; sourcemap doar când
`NODE_ENV !== "production"` (imaginea Docker nu mai cară `.map`).

### Vite (mixai, tv-tizen)
`build.reportCompressedSize:false` sare peste pasul gzip folosit doar pentru
raport; `sourcemap:false` explicit. Target-urile (es2022 / chrome ≥ 76 prin
plugin-legacy) au rămas neschimbate.

### Gradle (tv-android)
`org.gradle.parallel=true`, `kotlin.incremental=true`,
`kotlin.compiler.execution.strategy=in-process`, `-Xmx3g -XX:+UseParallelGC`
(pe lângă `caching` și `configuration-cache` care existau deja).

## 3. Imaginea Docker MMO Server (Raspberry Pi)

Măsurat în 2026-09-17 (`scripts/build-mmo-server-image.ps1` — buildx local,
QEMU pentru arm64, cache în `.copilot-tmp/buildx-cache`):

| Metrică | Înainte | După |
|---|---:|---:|
| Dimensiune imagine | 2,13 GB | 495 MB (amd64) / 682 MB (arm64) |
| Build arm64 cold | 21 min | 145 s |
| Build arm64 cached | — | 5 s |
| Deploy pe Pi (`scripts/deploy-mmo-server-pi.ps1`: scp tar → `docker load` → compose) | — | 62 s |

Capcane cunoscute: nu seta `npm_config_build_from_source` (better-sqlite3 și
audify au prebuild-uri arm64; compilarea sub QEMU a costat 15 min); folosește
`--output type=docker,dest=` (nu `oci`, care pierde tag-ul).

## 4. Regula: **niciodată build pe Pi**

Toate build-urile se fac local (buildx `--platform linux/arm64` cu QEMU, sau
WSL), apoi se livrează imaginea (`docker save | ssh homepi docker load` sau
GHCR). Pi-ul (5, alimentare la limită) doar rulează containerul.

## 5. Cum re-măsori

```powershell
# tot, fără web (web ocupă wrapper-ul serializat ~2,5 min)
pwsh -NoProfile -File scripts/measure-builds.ps1 -Label before -Skip web
# web o singură dată, warm
pwsh -NoProfile -File scripts/measure-builds.ps1 -Label before-web -Only web -NoCold
# ... aplică schimbarea ...
pwsh -NoProfile -File scripts/measure-builds.ps1 -Label after -Skip web
```

Rezultatele se acumulează în `.copilot-tmp/build-metrics.json` (cheie = label),
log-urile per țintă/fază în `.copilot-tmp/build-metrics-logs/`. Rulează
scriptul cu `-File` dintr-un `.ps1` care redirecționează output-ul într-un log —
terminalul pwsh implicit e partajat cu alți agenți.

Zgomot de așteptat pe această mașină: ±3 s pe orice țintă sub 20 s (alți agenți
rulează build-uri/teste în paralel). Repetă de două ori înainte de a declara o
regresie.
