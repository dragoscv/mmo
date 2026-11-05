# MixAI TV (Tizen) 2.0 — foundation API (WP16-30/31)

Contract for the screen work (WP16-32..35). Screens are files under `src/screens/`; everything below is
already built and verified on the Odyssey G8 (2580×1080). Do not change these signatures without updating this file.

## Screen signature

```tsx
import type { ScreenProps } from "../nav/ctx";
export function Home({ ctx, params }: ScreenProps<"home">) { … }
```

`ScreenCtx` (`src/nav/ctx.ts`) — stable per connection/profile (the stack remounts when the profile changes):

| field | type | what |
|---|---|---|
| `client` | `MmoClient` (`lib/api.ts`) | `/video/*` (resolveVideo, hlsUrl, directUrl, subtitleUrl, tmdbImageUrl, stillUrl, pauseStream) + legacy Subsonic |
| `media` | `MediaClient` (`lib/media.ts`) | `/media/*` profile-scoped (see below) |
| `profiles` | `ProfilesClient` (`lib/profiles.ts`) | active profile, PIN unlock, CRUD |
| `music` | `MusicClient` (`lib/music.ts`) | `/media/music/*` + Subsonic cover/stream URLs |
| `livetv` | `LiveTvClient` (`lib/livetv.ts`) | `/livetv/*` |
| `hub` | `HubClient` (`lib/hub.ts`) | WS `/hub` (remote + Watch Together) |
| `cfg` | `ServerConfig` | `{baseUrl, token, userId}` |
| `nav` | `NavApi` | see Navigation |
| `lang` | `"ro" \| "en"` | current locale (tree re-keys on change) |
| `app` | `AppActions` | `disconnect()`, `signOut \| null`, `session`, `profileChanged()` |

Route params arrive as `params` (the narrowed route object). Routes (`src/nav/routes.ts`):

`welcome · signin · discover {preselected} · pair {server} · connect · profiles {manage?} ·
home · search {initial?} · library {kind: "movie"|"tv"} · music · livetv · settings {section?} ·
title {kind, tmdbId, seed?: TitleCard} · season {tmdbId, season, showTitle?} · show {show} (legacy scan) ·
artist {id} · album {id (Subsonic album id), seed?: AlbumCard} · guide · recordings · stats {year?} ·
together {roomId?} · nowPlaying · livePlay {channelId} · player {item: PlayItem, queue?, index?}`

`PlayItem = {kind:"video", video: ProbedVideo, ref?: TitleRef, resumeSec?} | {kind:"audio", song, album}` (Subsonic).

## Navigation (`src/nav/Nav.tsx`, `back.ts`, `Rail.tsx`)

- `useNav()` / `ctx.nav`: `push(route)`, `pop(): boolean`, `replace(route)`, `resetTo(route)` (reuses the live
  root when same screen+params), `current`, `depth`, `canPop` (live getters on a stable object).
- **Keep-alive**: the top 6 entries stay mounted (`.nav-entry`, hidden ones `display:none`); deeper ones keep only
  their route. Back restores scroll + focus instantly with no refetch. So: fetch in `useEffect` on mount, don't
  refetch on show. `useScreenActive()` → false while covered (pause timers / video / polling).
- Focus restoration: give every focusable a stable `data-focus-key`. Scroll restoration: the entry itself and any
  descendant with `data-scroll="<id>"` (`.tv-screen` uses `data-scroll="screen"`, `Grid` uses its `gridId`).
- First focus on a new screen: the Outlet focuses the first focusable once your content renders (retries ~1.2 s,
  then the rail). Focus something yourself to override (e.g. `autoFocus` or `focusByKey`).
- **Back**: overlays first (`useBackHandler(fn, enabled)` from `nav/back.ts`; Dialog/SidePanel/PinPad already
  register). Top-level routes (home/search/library/music/livetv/settings) at stack root: 1st Back → rail,
  2nd Back → exit dialog → `exitApp()`. Elsewhere: pop.
- Rail hidden on `welcome, signin, discover, pair, connect, profiles, player, livePlay, nowPlaying` (`NO_RAIL`).
  Rail order/visibility: prefs blob `mixai:prefs:v1` key `navOrder` (`lib/prefs.ts` `navOrder()/setNavOrder()`,
  ids `home search movies shows music livetv settings`; Settings always kept). Mini-player chip shows when
  `playerBus.nowPlaying().kind === "audio"` → pushes `nowPlaying`.

## Focus (`src/lib/focus.ts` v2) — attributes are the whole contract

| attribute | meaning |
|---|---|
| `data-focusable` | D-pad target (buttons; give non-buttons `tabIndex={-1}`) |
| `data-focus-key="k"` | stable id for restoration (`focusByKey(k)`) |
| `data-focus-row="id"` | horizontal group; ↑/↓ into it restores its last focused child |
| `data-focus-wrap` | on a row: ←/→ wrap at the ends |
| `data-focus-scope` | trap container; register with `useFocusScope(ref, open)` (ui) or `pushFocusScope(el)` |
| `data-focus-noscroll` | ancestor scrolls itself (virtual Row) → no `scrollIntoView` |
| `data-focus-zone="rail"` | the rail (one) |

Exports: `moveFocus(dir)`, `focusFirst(root?)`, `focusByKey(key, root?)`, `focusRail()`, `focusContent()`,
`currentFocus()`, `focusables(root?)`, `isInRail()`, `pushFocusScope(el)`, `hasFocusScope()`, `contentRoot()`,
`invalidateRects()`, `installRowMemory()`, `focusEl(el, reveal?)`. Candidates = active scope (top dialog → active
nav entry → rail) within viewport ± 1 screen; rects cached per layout generation (scroll/resize/mutation).
← at the content's left edge enters the rail; → from the rail returns to the last content focus.
Enter = `click()` on the focused element (App). Digits: read with `digitFromEvent(e)` (`ui/PinPad`).

## UI kit (`src/ui`, CSS `ui/ui.css`, import from `"../ui"`)

- `<Icon name size? label?/>` — names: home search movie tv music livetv settings play pause back10 fwd10 subtitles
  audio speed aspect info next prev shuffle repeat repeatOne lock kids group record guide queue lyrics plus check star
  close mic backspace chevronRight chevronLeft user alert refresh server. Sprite mounted once by App.
- `useBackdrop().show(url|null)` / `.clear()` — debounced 120 ms, preloads, 300 ms crossfade, partial scrims.
- `<PosterCard|LandscapeCard focusKey title subtitle? image? progress? badges?[{label,icon?,tone?}] placeholderIcon?
  onSelect onFocus? alwaysShowTitle? overlay? square?(poster)/>`. Widths `CARD_REM` (poster/square 9.5rem,
  landscape 15rem, gap 1rem). Sized TMDB URL: `ctx.media.imageFor(path, remPx(CARD_REM.poster))` or
  `tmdbSize(px)` (`lib/image.ts`: w185/w342/w500/w780) + `preload(urls)`, `isLoaded`, `remPx(rem)`.
- `<Row rowId title? items itemKey renderItem kind? itemWidthRem? heightRem? wrap? onEndReached? onItemFocus?/>`
  — virtualised (visible ± 6), transform track.
- `<Grid gridId items itemKey renderItem kind? itemWidthRem? rowHeightRem? onEndReached? onItemFocus? header?/>`
  — virtualised by rows, own scroll container (fills the entry: `position:absolute; inset:0`).
- `<PrimaryButton|SecondaryButton|GhostButton label icon? onClick focusKey? sub? active? disabled?/>`,
  `<IconButton icon label onClick focusKey? active?/>`, `<Chips items[{id,label,icon?}] value onChange rowId? wrap?/>`.
- `<LoadingRows rows? kind? count?/>`, `<LoadingBlock lines?/>`, `<Empty icon? title? message? action? secondary?/>`,
  `<ErrorState message onRetry? title?/>`.
- `<Dialog open title message? confirmLabel? cancelLabel? onConfirm onCancel destructive? icon?/>` (focus lands on
  the safe action), `<SidePanel open title items[{id,label,sub?,icon?,disabled?}] value? onSelect onClose side? footer?/>`.
- `<PinPad title error? onComplete(pin) onCancel disabled? resetKey?/>` (bump `resetKey` → clear + shake).
- `<Keyboard value onChange onDone? maxLength? id?/>` (a–z 0–9, space, ⌫, clear, RO diacritics).
- `<ScreenHeader title sub? right?/>`, `<StubScreen …/>`. Rail screens: root `<div className="tv-screen" data-scroll="screen">`.
- `ProfileAvatar` is exported from `nav/Rail.tsx`.

## Data clients (field names = `server/openapi.yaml`; types in `lib/media-types.ts`)

- `media`: `homeCached()` (sync, per-profile localStorage `mixai-tv:home:<profile>`, ≤ 1.5 MB, memory fallback),
  `revalidateHome(force?)` (refetches only when `/media/etag` moved; resolves fresh `MediaHome` or `null` = cache
  current), `mediaHome()`, `mediaTitle(kind,id)` (memory, per profile, etag 5 min), `season(tmdbId,n)`,
  `mediaSearch(q)`, `mediaLibrary()`, `watchlist()`, `watchlistAdd/Remove(kind,id)`, `stats(year?)`,
  `recordPlay({trackKey,…})`, `getProgress/putProgress`, `image(path,size)`, `imageFor(path,px)`, `invalidate()`.
  Progress reporting for video stays in `lib/progress-sync.ts` (`reportProgress`, `markWatched`, `TitleRef`).
- `profiles`: `profiles`, `active`, `profileId`, `token`, `headers()`, `query()`, `refresh()`, `restore()`,
  `needsPicker()`, `select(p)`, `unlock(p, pin?) → {ok:true}|{ok:false, reason:"wrong",triesLeft}|{reason:"locked",
  retryAfterMs}|{reason:"error",message}`, `create/update/remove`, `signOut()`, `changed` (emitter). Persisted
  `localStorage["mixai-tv:profile"] = {id, token, expiresAt}`. After switching call `ctx.app.profileChanged()`.
- `music`: `home() artists({letter,offset,limit}) artist(id) album(id) albums(…) genres() genre(name,…) search(q)
  playlist(id) random(size) queue() setQueue(input) lyrics(trackId)`, `coverUrl(card, size?)`, `streamUrl(track)`.
- `livetv`: `sources() createSource updateSource deleteSource testSource refreshSource channels({group,favourites,
  hidden,source}) updateChannel setFavourite(id,fav) groups() guide({from,to,channels}) now(channels?) recordings()
  record(input) deleteRecording(id) rules() createRule deleteRule`, `streamUrl(id)` = `/livetv/stream/{id}?proxy=1&t=`
  (server rewrites HLS → hls.js works), `catchupUrl(id, startMs, durationSec)`, `logoUrl(ch)`.
- `hub`: `status` + `statusChanged`, `devices` + `devicesChanged`, `room` + `roomChanged`, `chat`, `reactions`,
  `errors`, `commands` (App handles them), `clock` (ClockEstimator), `serverNowMs()`, `roomExpectedPosition()`,
  `ack`, `reportState`, `command(target, action, args)`, `createRoom/joinRoom/leave/load/play/pause/seek/ready/
  report/sendChat/react`, HTTP `listDevices() sendCommand() createRoomHttp() getRoom()`. Device id
  `localStorage["mixai-tv:device-id"]`; hello `platform:"tizen"`, `app:"mixai-tizen/<ver>"`.
- `lib/sync-math.ts`: 1:1 port of the server (ClockEstimator, expectedPosition, driftAction, leadTimeMs);
  tests `src/lib/sync-math.test.mjs` (in `pnpm test`).
- `lib/player-bus.ts`: `playerBus.subscribe(handler) → unsubscribe` (last subscriber wins; handler gets
  `{type: pause|resume|toggle|seek{positionSec}|seekBy{deltaSec}|stop|next|previous|rate{rate}|volume{level}}`),
  `send(cmd) → handled`, `setNowPlaying(np|null)`, `nowPlaying()`, `onNowPlaying(fn)`, `useNowPlaying()`.
  Any screen owning a media element must subscribe + publish (the Player does). The hub forwards now-playing (≤ 1/s).

## Hub commands handled by the App

`play {fileId, startSec, kind, tmdbId, season, episode}` → `client.resolveVideo` → push `player`;
`pause|resume|stop|next|previous|seek{positionSec}|volume{level}` → `playerBus` (ack `no_player` when none);
`text {value}` → push `search {initial}`; `navigate {to}` → `routeFromPath` (`home movies shows music livetv guide
recordings settings[/section] search[/q] profiles stats[/year] together[/room] title/<kind>/<id> season/<id>/<n>
artist/<id> album/<id> channel/<id>`). e2e hook (debug builds): `open:<kind>:<id>`, `play:<fileId>:<sec>`, `nav:<path>`.

## Rules

Tokens only (`var(--…)`; new token used in CSS → add its sRGB value to the `@supports not (color: oklch(0 0 0))`
block in `src/styles.css`); `node scripts/hex-gate.mjs` = 0. Strings in `src/i18n/messages.ts` RO + EN. No emoji
icons. rem/vw layout (viewport is 2580 wide on the Odyssey). Animate transform/opacity only; durations from
`--dur-*` (0 under user-chosen reduced motion; `lib/prefs.ts setMotion`). Avoid CSS newer than Chromium 76 without
a fallback: no `inset`, `aspect-ratio` (use padding-top boxes), `min()/max()/clamp()`. Flex `gap` needs Chromium 84
(Tizen ≥ 6.5); the app already relies on it, so Tizen 6.0 sets lose spacing, not layout.

## Verify

`.copilot-tmp/tz-verify.ps1` (typecheck, test, build, hex-gate). Device: package + install
`scripts/package-wgt.ps1 -Profile mixai-samsung -TvIp 192.168.100.135 -Install`; inspector:
`sdb -s 192.168.100.135:26101 shell 0 kill mXa1TvApp0` **then** `sdb … shell 0 debug mXa1TvApp0.MixAI` → `port: P`
(it hangs silently while the app is already running) → `sdb forward tcp:9333 tcp:P` (P is often in a Hyper-V
excluded range → map to 9333) → `was_execute` → `node .copilot-tmp/vt/cdp.mjs 9333 eval|shot`.
