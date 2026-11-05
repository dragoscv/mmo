# Store review notes — MixAI (ro.mixai.app)

Text for the **App Review Information** (App Store Connect) and **App access** (Google Play Console)
fields. The apps need a MixAI media server; reviewers use the public demo server below (WP16-53, D39).
Server operations: `infra/demo/README.md`.

## Demo server

- URL: **https://demo.mixai.ro** (fallback while DNS propagates: **https://34-118-46-71.sslip.io**)
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

## Google Play — App access (paste)

- "All or some functionality is restricted": **Yes** → instructions:

```
Open MixAI > Connect to a server on this network > Enter the address manually > type
https://demo.mixai.ro > Connect > Pair with a code. The demo server approves the code automatically;
choose the profile "Reviewer".
No username or password is needed.
```

## Content declarations (both stores)

- No user-generated public content except Watch Together room chat (moderated: word filter, report, block —
  server 3.9.0).
- Live TV: the app ships no channels and no "IPTV" wording or channel brands; users add their own sources.
  The demo server's channels are loops of CC BY films.
- Third-party streaming services only open their own apps via deep links (no embedded playback).
