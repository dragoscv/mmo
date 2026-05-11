# Telemetrie & monitorizare erori

> Status: opt-in. Implicit dezactivat pentru a respecta deployment-urile self-hosted care nu vor să trimită date către un serviciu extern.

## De ce Sentry

Pentru un produs care rulează atât în browser cât și pe Node.js (Cloud Run + companion local), avem nevoie de:

- urmărirea erorilor de render React (Server / Client / RSC)
- urmărirea excepțiilor din Server Actions și Route Handlers
- corelarea unui crash cu request-ul / user-ul / build-ul exact
- payload mic (<5k erori/lună intră în planul gratuit Sentry)

Alternative considerate:

| Soluție               | Pro                              | Contra                                              |
| --------------------- | -------------------------------- | --------------------------------------------------- |
| Sentry (free tier)    | SDK matur Next.js, source maps   | Vendor extern                                       |
| Self-hosted GlitchTip | API compatibil Sentry, gratuit   | Operare suplimentară (DB, scheduler)                |
| Doar `console.error`  | Zero dependențe                  | Fără agregare, fără source maps, fără notificări    |
| Logflare / Highlight  | Combină loguri + erori           | Cost crescător, lock-in                             |

**Decizie:** integrăm Sentry ca _peer dependency opțional_. Tot codul e scris în jurul unui shim leneș (`app/src/lib/sentry.ts`) care evită rezolvarea pachetului la build dacă `SENTRY_DSN` lipsește.

## Activare în producție

1. Creează un proiect pe https://sentry.io/signup/ (planul `Developer` e gratuit, 5.000 erori/lună).
2. În folderul `app/`:
    ```sh
    pnpm add @sentry/nextjs
    ```
3. Setează variabilele de mediu (`.env.local` în dev, secretele platformei în prod):
    ```env
    SENTRY_DSN=https://abc...@oXXX.ingest.sentry.io/YYY
    NEXT_PUBLIC_SENTRY_DSN=https://abc...@oXXX.ingest.sentry.io/YYY
    SENTRY_ENVIRONMENT=production           # opțional, default: NODE_ENV
    SENTRY_RELEASE=mmo@$(git rev-parse --short HEAD)
    SENTRY_SEND_PII=                        # "1" pentru IP/cookies; off implicit
    NEXT_PUBLIC_SENTRY_FEEDBACK=            # "1" pentru widget-ul de feedback
    ```
4. Re-deploy. Inițializarea se face o singură dată per cold-start, în `app/src/instrumentation.ts` (server + edge) și `app/src/instrumentation-client.ts` (browser).

## Ce se raportează automat

| Sursă                                       | Mecanism                                      |
| ------------------------------------------- | --------------------------------------------- |
| `log.error(msg, fields, err)`               | `lib/logger.ts` apelează `captureException`   |
| Erori din Route Handlers / Server Actions   | `onRequestError` în `instrumentation.ts`      |
| Render error inside layout children         | `app/src/app/error.tsx`                       |
| Crash în root layout / RSC tree             | `app/src/app/global-error.tsx`                |
| Erori client (`window.onerror`)             | SDK `@sentry/nextjs` (browser init)           |

## Sample rate-uri

- **Erori:** 100% (toate sunt trimise).
- **Performance traces:** 10% server, 10% edge (configurabil în `instrumentation.ts`).
- **Replay:** dezactivat. Dacă îl activezi, fii atent la planul Sentry — replay-urile consumă cota mai repede decât evenimentele simple.

## PII și conformitate

- `sendDefaultPii` e **off** implicit. Nu trimitem IP, cookies sau body-uri de request decât dacă administratorul setează explicit `SENTRY_SEND_PII=1`.
- Header-ele cu token-uri (cookie de sesiune, Authorization) sunt scrubbed default de SDK-ul Sentry.
- Logger-ul are deja un filtru pentru `password`, `token`, `secret` în `lib/logger.ts` care se aplică înainte de orice forward.

## Cost & cota free tier

Plan `Developer` (gratuit, fără card):

- 5.000 erori / lună
- 10.000 performance units / lună
- 50 replays / lună
- 1 GB attachments

Pentru un trafic <100 utilizatori activi/zi, asta e suficient. Dacă depășim, alertele se opresc fără să spargă aplicația — instrumentarea e best-effort.

## Dezactivare completă

Pentru a opri telemetria într-un mediu altfel configurat:

```sh
unset SENTRY_DSN
unset NEXT_PUBLIC_SENTRY_DSN
```

Sau (dacă pachetul e instalat dar nu vrei să îl folosești):

```sh
pnpm remove @sentry/nextjs
```

Shim-ul tot funcționează — toate apelurile devin no-op și nu se face nicio rezolvare de modul.
