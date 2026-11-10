# Store review notes — MixAI (ro.mixai.app)

Text for the **App Review Information** (App Store Connect) and **App access** (Google Play Console)
fields. The apps need a MixAI media server; reviewers use the public demo server below (WP16-53, D39).
Server operations: `infra/demo/README.md`.

## Demo server

- URL: **https://demo.mixai.ro** (live with a Let's Encrypt cert since 2026-11-05 22:43Z; the same server also answers
  on `https://34-118-46-71.sslip.io` / `.nip.io`, which the submitted 1.1.0 notes still mention)
- Support contact: **support@mixai.ro** (Brivio Stalwart mailing list → owner inbox, 2026-11-06)
- No username, password or code to type: Quick Connect on the demo server is approved automatically.
- Content: Blender open movies (CC BY), a public-domain TV series (The Beverly Hillbillies, 1962), CC BY music
  (Kevin MacLeod, Tears of Steel and Elephants Dream soundtracks) and two looping demo "live" channels made
  from Big Buck Bunny and Sintel. Credits: `ATTRIBUTION.md` on the server and in `infra/demo/ATTRIBUTION.md`.
- Demo clients are read-only: they can browse, play, resume, add to My list and use Watch Together, but
  cannot change the server's library, sources or profiles.

## Steps for the reviewer (both stores)

1. Install and open MixAI. On the welcome screen choose **Connect to a server on this network**
  (iOS: **Connect to a server**).
2. Tap **Enter the address manually** and type `https://demo.mixai.ro`, then **Connect**.
3. The server is found. Tap **Pair with a code** (Quick Connect). A 6-digit code appears and is approved
  by the demo server within ~3 seconds; the app opens automatically.
4. Pick the profile **Reviewer** (no PIN). **Kids** shows the age-filtered view (max age 12).
  **Parent** is PIN-protected (PIN `1234`): it shows the lock on the profile and the PIN pad.
5. Try: Home → *Sintel* → Play (direct play, seeking, subtitles on *Tears of Steel*); Shows → *The Beverly
   Hillbillies* → Season 1/2 episodes; Music → *Kevin MacLeod* → play, queue, lyrics view (instrumental);
   Live TV → *MixAI Demo 1/2* (guide, zapping); Watch Together → create a room.
6. Sign-in with a MixAI account is optional and not required to review the app. Account deletion is in
   Settings → Account (WP16-51).

## App Store Connect — "Notes" field (paste)

```
MixAI plays the user's own media from their own MixAI server (self-hosted). For review we run a public
demo server with legally licensed content (Blender open movies CC BY, public-domain series, CC BY music).
Steps: Connect to a server > Enter the address manually > https://demo.mixai.ro > Connect > Pair with a
code (approved automatically within seconds) > profile "Reviewer". No login is required.
Live TV in the app only plays sources the user adds; the demo server includes two looping demo channels
generated from Big Buck Bunny and Sintel. Credits: https://demo.mixai.ro (ATTRIBUTION.md in the library).
```

Sign-in required: **No** (leave username/password empty).

Submitted text (2026-11-05, iOS 1.1.0) uses the sslip.io host because demo.mixai.ro does not resolve yet; the
exact notes are reproduced by `apps/ios/store/listing/*.json` + the App Store tracker row WP16-48.
Store URLs until mixai.ro is live: privacy `https://mixai-web-622082681070.europe-west1.run.app/privacy?lang=en|ro`,
support/marketing = the same origin's home, account deletion `/account/delete`. After the web moves to
`https://mixai.ro` the run.app origin keeps serving the same app (no redirect, owner 2026-11-06) so the 1.1.0
builds in review keep working; switch the listing URLs to mixai.ro at the next store update, not during review.

## Google Play — App access (paste)

- "All or some functionality is restricted": **Yes** → instructions:

```
Open MixAI > Connect to a server on this network > Enter the address manually > type
https://demo.mixai.ro > Connect > Pair with a code. The demo server approves the code automatically;
choose the profile "Reviewer".
No username or password is needed.
```

Submitted text (Play Console > App content > Sign in details, set "Demo server (no account needed)", 2026-11-05) uses
`https://34-118-46-71.sslip.io` (same server; `demo.mixai.ro` resolves only after the mixai.ro NS switch):

```
No username or password. The app needs a media server; use our public demo server. Open MixAI > "Connect to a
server on this network" > "Enter the address manually" > type https://34-118-46-71.sslip.io (same server:
https://demo.mixai.ro) > Connect > "Pair with a code". The demo server approves the code automatically in ~3 s.
Choose profile "Reviewer". All features (Home, titles, player, Music, Live TV, Watch Together) are then available.
Signing in to a MixAI account is optional.
```

Other Play declarations (2026-11-05): ads no; advertising ID no (merged manifest has no AD_ID); target audience
13+; IARC = PEGI 3 / ESRB Everyone / USK 0 with "Users interact" (chat moderated, block, report, invite-only rooms);
Data safety = collected, not shared: name, email, user IDs (account, optional), app interactions (watch history
cloud sync, optional), device IDs (push token); encrypted in transit; deletion URL `/account/delete`. Watch Together
chat is not declared: it is relayed only by the user's own MMO Server hub and never reaches MixAI cloud. Foreground
services: dataSync = "Other network processing" (offline downloads, video https://youtube.com/shorts/yD_RRplAiGQ),
mediaPlayback = media playback (https://youtube.com/shorts/PG5bqbNpINk); both unlisted, personal notifications
blurred. Store settings: Video Players & Editors, contact = developer account email, website = web origin.

## MixAI Music (ro.mixai.music) — Google Play (WP17-41i, 2026-11-07)

- Console app 4973783961074556020, phone + Wear OS in one listing (Wear opted in), Android Auto active.
- Sign in details: same demo server steps as above, app name "MixAI Music"; profile "Reviewer". Music (artists,
  albums, playlists, radio, downloads, Android Auto) is then available; MixAI account sign-in is optional.
- Data safety: name, email, user IDs only (optional MixAI account), collected, not shared, encrypted, deletion
  `https://mixai.ro/account/delete`. No push token and no cloud history sync in this app.
- Foreground services: dataSync = "Other network processing" (offline downloads,
  https://youtube.com/shorts/4O1Cke5C2rM), mediaPlayback (https://youtube.com/shorts/8txHuOnsSzU); recorded on an
  emulator, unlisted.
- IARC: All other app types, every answer No -> PEGI 3 / ESRB Everyone. Target audience 13+. Ads no, ad ID no.
- Testers: internal list "MixAI internal"; closed tracks "Alpha" (phone) + "Wear closed" with the Google Group
  mixai-music-testers@googlegroups.com (anyone can join), feedback support@mixai.ro.

## Content declarations (both stores)

- No user-generated public content except Watch Together room chat (moderated: word filter, report, block —
  server 3.9.0).
- Live TV: the app ships no channels and no "IPTV" wording or channel brands; users add their own sources.
  The demo server's channels are loops of CC BY films.
- Third-party streaming services only open their own apps via deep links (no embedded playback).
