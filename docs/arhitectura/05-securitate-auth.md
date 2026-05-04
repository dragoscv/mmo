# 05 — Securitate & Auth

> [← 04](04-fluxuri-date.md) · [README arhitectură](README.md)

---

## 🔐 Autentificare

### Web App
- **Auth.js v5** (`next-auth@5.0.0-beta`) cu **Drizzle adapter**
- Sesiuni stocate în DB (tabela `session`), nu JWT-only — permite revocare instantanee
- Cookie `next-auth.session-token`:
  - `HttpOnly` ✓
  - `Secure` ✓ (în prod, peste HTTPS)
  - `SameSite=Lax`
  - Lifetime: 30 zile (configurabil în `auth.ts`)
- OAuth providers configurabili prin `.env`: Google, GitHub, etc.
- Rotation: refresh-token rotation gestionat de Auth.js

### Companion ↔ Web App
- La pornire, companion-ul cere un **device token** la `/api/companion-auth`
- Token-ul e signed JWT cu issuer = web app, audience = `companion`, lifetime 7 zile
- Companion-ul îl include în `Authorization: Bearer <token>` la fiecare cerere
- Web app validează prin middleware înainte de a apela orice endpoint companion-aware

### Extension ↔ Web App
- Extensia folosește **session cookie** existent (utilizatorul e deja logat în web app)
- Cererile sunt `credentials: 'include'`
- CORS în web app permite extensia: `chrome-extension://<id>` adăugat la `Access-Control-Allow-Origin`
- Pentru securitate suplimentară: extensia validează URL-ul web app (nu acceptă instalări lookalike)

---

## 🔑 Autorizare

- **Server Actions** verifică sesiunea înainte de orice mutație:
  ```typescript
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');
  ```
- Endpoints REST (sub `/api/*`) folosesc același pattern
- **Toate** input-urile validate cu **Zod** la marginea sistemului
- DB queries filtrate prin `WHERE userId = ?` (multi-tenancy by row-level)
- Companion endpoints au scope limitat (no admin actions)

---

## 🔒 Secrets management

| Secret | Unde se stochează | Cum se rotește |
|--------|------------------|----------------|
| `NEXTAUTH_SECRET` | `.env.local` (dev), GCP Secret Manager (prod) | Manual; invalid sesiuni existente |
| `DATABASE_URL` | `.env.local` / Secret Manager | În funcție de DB provider |
| `GOOGLE_CLIENT_SECRET` | `.env.local` / Secret Manager | Din Google Cloud Console |
| `TURN_SHARED_SECRET` | Output Terraform state (encrypted) → injectat în web app env | `terraform apply` cu `random_password` re-rolled |
| `GITHUB_TOKEN` (opțional) | `.env.local` — pentru `/api/companion/download` cu rate limit mai mare | Token cu scope `public_repo` |
| `COMPANION_DEVICE_TOKEN` | Companion local (`electron-store`, encrypted at rest pe macOS Keychain / Windows DPAPI / libsecret) | Re-emis de web app |

### `.gitignore` (verificat)
```
.env
.env.local
.env.*.local
*.pem
*.p12
.terraform/
terraform.tfstate*
```

> ⚠️ **TODO**: `app/.env.example` este momentan **lipsă**. Trebuie adăugat cu toate variabilele documentate.

---

## 🛡️ Headere de securitate

Configurate în `app/next.config.ts` și/sau `app/src/proxy.ts`:

```typescript
{
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  'Content-Security-Policy': "..."  // vezi mai jos
}
```

### CSP — particularități MMO
Web app-ul are nevoi speciale care impun reguli CSP atente:

| Necesitate | CSP directive |
|---|---|
| Audio worklets în `/worklets/` | `worker-src 'self'` |
| Embed YouTube (preview pentru download) | `frame-src https://www.youtube.com` |
| Imagini cover din MusicBrainz | `img-src 'self' https://coverartarchive.org data:` |
| WebRTC ICE | `connect-src 'self' wss: https://muzicai.ro stun: turn:` |
| Companion local | `connect-src http://127.0.0.1:17899` (DEV only; prod: doar prin postMessage iframe) |

---

## 🌐 CORS

| Sursa | Ce poate face | Configurare |
|-------|---------------|-------------|
| `https://muzicai.ro` (origin self) | Tot | implicit |
| `chrome-extension://<id>` | POST /api/download/* | allowlist explicit în web app |
| `http://localhost:17899` (companion) | Doar răspunde la cereri de la web app, nu invers | proxy.ts validează `Origin` header |
| Alți origini | Nimic | `Access-Control-Allow-Origin` nu e `*` |

---

## 🔥 Validare & sanitizare

### La marginea sistemului
- **Toate** Server Actions: Zod schema first thing
- **Toate** API routes: Zod schema first thing
- **Toate** body-uri JSON: parsare strict, fără `JSON.parse(req.body as any)`

### File path security
- Companion-ul **nu acceptă** path-uri cu `..` în orice request
- Path-urile sunt validate cu `path.normalize()` și verificate să fie sub root-ul configurat
- USB write operations: validare nume fișier (FAT32 reserved chars)

### SQL injection
- Drizzle ORM folosește prepared statements automat
- Niciodată nu construim SQL string concat — `eq()`, `and()`, `or()` din Drizzle

### XSS
- React JSX face escape automat
- `dangerouslySetInnerHTML` interzis prin lint rule
- User-generated content (numele playlistului, etc.) afișat doar prin `{value}`, nu prin innerHTML

---

## 🚦 Rate limiting

| Endpoint | Limită | Strategy |
|----------|--------|----------|
| `/api/auth/*` | 10 req / min / IP | edge middleware |
| `/api/download/*` | 30 req / min / user | per-user counter în DB |
| `/api/turn-credentials` | 60 req / oră / user | per-user counter |
| `/api/companion/download` | 60 req / oră / IP (GitHub limit) | in-memory cache + negative cache 10 min |

> Implementare: TBD — momentan nu e rate limiting strict; planificat cu `@upstash/ratelimit` sau implementare manuală cu Redis/SQLite counter.

---

## 🛂 OWASP Top 10 — checklist MMO

| # | Risc | Mitigare în MMO |
|---|------|-----------------|
| A01 | Broken Access Control | Server-side check sesiune + `WHERE userId` în toate query-urile |
| A02 | Cryptographic Failures | TLS 1.2+ obligatoriu; HMAC-SHA1 pentru TURN (acceptabil aici); secrets în Secret Manager |
| A03 | Injection | Drizzle prepared statements; Zod la border; React JSX escape |
| A04 | Insecure Design | Threat model documentat aici; review periodic |
| A05 | Security Misconfiguration | Headere CSP/HSTS; CORS allowlist; no debug în prod |
| A06 | Vulnerable Components | `pnpm audit` în CI; Dependabot pe GitHub |
| A07 | Identification & Auth Failures | Auth.js v5 (battle-tested); rotation; lockout post brute force |
| A08 | Software & Data Integrity | Companion auto-update verifică semnături (electron-updater); SBOM la TBD |
| A09 | Logging Failures | Structured logging (TBD: pino); no PII în loguri |
| A10 | SSRF | Download endpoints validează URL-ul (allow-list domain pe download) |

---

## 🧪 Testing securitate

- `pnpm audit` blocant în CI pentru vulnerabilități high/critical
- Pre-commit hook: secret scanning (`detect-secrets` sau `gitleaks`)
- Penetration test manual înainte de release `v1.0`

---

## 🔮 Plan viitor

- [ ] Adăugare `app/.env.example` cu toate variabilele documentate
- [ ] WebAuthn / Passkeys (când Auth.js v5 stabilizează adapter-ul)
- [ ] 2FA pentru utilizatori sensibili
- [ ] Audit logs pentru acțiuni admin
- [ ] Rate limiting strict cu Redis
- [ ] CSP report-uri colectate (`/api/csp-report`)
- [ ] Bug bounty program (după v1.0)

---

[← 04](04-fluxuri-date.md) · [README arhitectură](README.md) · [🏠 Home](../../README.md)
