# 🤖 codai — provider AI implicit

> Decizie: [ADR-0006](../adr/0006-codai-as-default-ai-provider.md). Acest document descrie **cum** este implementată.

[🏠 Home](../../README.md) · [🏗️ Arhitectură](README.md)

---

## Ce este

[codai](https://ai.codai.ro) este un gateway OpenAI-compatible cu **un singur nume de model** (`codai`) și aliasuri
pe niveluri. MixAI îl folosește ca **prim candidat** pentru orice apel AI server-side; provider-ii existenți
(Gemini, Azure OpenAI, Anthropic, OpenAI, Copilot, BYO-key) rămân ca fallback.

| Alias | Rol | Endpoint |
|---|---|---|
| `codai` | chat implicit | `/chat/completions` |
| `codai-fast` | ieftin/rapid (intenții playlist, clasificări) | `/chat/completions` |
| `codai-smart` | calitate maximă | `/chat/completions` |
| `codai-vision` | imagini (coperți, capturi) | `/chat/completions` |
| `codai-embed` | embeddings (căutare semantică bibliotecă) | `/embeddings` |
| `codai-transcribe` | subtitrări / versuri | `/audio/transcriptions` |
| `codai-tts` | text-to-speech | `/audio/speech` |

Codul: `packages/ai/src/providers/codai.ts` (`codaiAdapter`, `codaiLanguageModel`, `codaiEmbeddings`,
`CODAI_MODELS`, `CODAI_TIER_MODEL`), construit pe `@ai-sdk/openai-compatible`.

## Flux

```mermaid
sequenceDiagram
    participant U as Utilizator (web/TV/Pi)
    participant W as apps/web (Server Action / route)
    participant R as model-resolver
    participant C as lib/codai/client
    participant M as api.codai.ro (mgmt)
    participant G as ai.codai.ro/v1 (inferență)

    U->>W: cerere AI (chat, căutare, playlist)
    W->>R: resolveModel(userId, role)
    R-->>W: aiModelChoices? → model explicit (câștigă întotdeauna)
    W->>R: altfel resolveServerDefaultForUser(userId)
    R->>C: getCodaiModel(userId, tier)
    C->>C: cheie stocată? (ai_provider_connections, provider=codai)
    alt fără cheie și CODAI_APP_TOKEN setat
        C->>M: POST /apps/keys {email, endUserExternalId, label, budgetEurPerDay}
        M-->>C: { ok: true, data: { id, key } }
        C->>C: encryptToken(key) → encApiKey; endpointsJson.keyId
    else fără CODAI_APP_TOKEN
        C->>C: folosește CODAI_API_KEY (cheia serverului)
    end
    C-->>R: LanguageModel (header x-codai-session-id = userId)
    W->>G: streamText → /chat/completions
    G-->>U: răspuns
```

## Ordinea de rezolvare

1. **`aiModelChoices`** al utilizatorului (rol → conexiune → model). Setat din `/settings/copilot`. Câștigă mereu.
2. **codai** — `resolveServerDefaultForUser(userId)`:
   1. cheie per utilizator (mintată la prima folosire, dacă `CODAI_APP_TOKEN` există);
   2. cheia serverului `CODAI_API_KEY`.
3. Gemini (`GOOGLE_GENERATIVE_AI_API_KEY`) → Azure OpenAI → Anthropic → OpenAI (neschimbat).
4. Fără nicio cheie: adaptorul codai rulează în **mock mode** (răspuns fix `[codai mock] …`) doar când e apelat
   explicit; `resolveServerDefault()` returnează `null` și ruta răspunde 400 ca înainte.

Un utilizator poate adăuga și manual o conexiune `codai` cu cheia lui (BYO-key) în `/settings/copilot`;
`buildLanguageModel` o tratează ca pe orice provider cu `encApiKey`.

## Variabile de mediu (`apps/web/.env.example`)

| Variabilă | Rol | Implicit |
|---|---|---|
| `CODAI_API_KEY` | cheia serverului (`codai_…`); activează codai ca prim default | — |
| `CODAI_APP_TOKEN` | token app (`codai_app_…`) pentru mgmt; activează mintarea per utilizator | — |
| `CODAI_BASE_URL` | baza de inferență | `https://ai.codai.ro/v1` |
| `CODAI_MGMT_URL` | baza mgmt | `https://api.codai.ro` |
| `CODAI_USER_BUDGET_EUR_PER_DAY` | plafon zilnic (EUR) per cheie mintată | `1` |

`AUTH_TOKEN_ENC_KEY` (deja existent) criptează cheile stocate.

## Mintarea cheilor per utilizator (`apps/web/src/lib/codai/mgmt.ts`)

- `mintUserKey({ userId, email })` → `POST /apps/keys` cu `label: mixai:<userId>`, `endUserExternalId: userId`,
  `budgetEurPerDay`. Răspunsul este un **envelope** `{ ok, data }`; `ok:false` sau HTTP ≠ 2xx aruncă `CodaiMgmtError`.
- `getOrMintUserKey(userId)` — citește rândul din `ai_provider_connections`
  (`provider="codai"`, `label="mixai:<userId>"`, `status="active"`); dacă lipsește, mintează și salvează
  `encApiKey` (AES-GCM via `lib/token-crypto`) + `endpointsJson.keyId`. **Nu există migrare nouă** — se reutilizează
  tabela conexiunilor BYO-key.
- `revokeStoredUserKey(userId)` → `DELETE /apps/keys/:id` + `status="revoked"` local.
- `listUserKeys(externalId)` → `GET /apps/keys?endUserExternalId=`.

Plaintext-ul cheii apare o singură dată (la mint) și nu este logat niciodată.

## Prompt caching

Fiecare model codai trimite `x-codai-session-id: <userId>`. Gateway-ul lipește cererile aceluiași utilizator de
același upstream, astfel încât prefixul de prompt (system prompt Maestro + tool definitions) rămâne în cache.
Nu schimba valoarea per cerere; pentru fire lungi de chat este acceptabil și `sessionId`-ul conversației.

## Token-uri efemere pentru browser / TV

`POST /api/ai/token` (sesiune obligatorie, 20 req/min/utilizator) cu body `{ scopes: ["audio"|"embeddings"|"realtime"], ttlSeconds? }`.
Serverul apelează `POST {CODAI_BASE_URL}/tokens` cu cheia utilizatorului și întoarce `{ token: "codai_eph_v1…", expiresAt, scopes }`.
Cheia lungă nu părăsește niciodată serverul.

## MMO Server pe Raspberry Pi

MMO Server (`server/`, headless pe Pi) **nu rulează ML local**. Orice funcție AI (căutare semantică, intenții
playlist, transcriere) trece prin acțiunile/rutele din `apps/web`, care rezolvă cheia și apelează codai conform
fluxului de mai sus. Pi-ul nu are nevoie de nicio variabilă `CODAI_*`; dacă web-ul nu e disponibil, se poate
delega către Companion-ul de pe PC (același contract).

## Testare

- `packages/ai/src/providers/codai.test.ts` — înregistrare în registry (primul), lista de modele, mock mode.
- `apps/web/src/lib/codai/mgmt.test.ts` — despachetarea envelope-ului și căile de eroare (fetch mock-uit).

```powershell
cd packages/ai; pnpm exec vitest run
cd apps/web; pnpm exec vitest run src/lib/codai
```
