# ADR-0005 — MMO Server implements the OpenSubsonic API

- Status: Accepted · 2026-09-17

## Context
Navidrome's moat is Subsonic compatibility: 50+ mature music clients (Symfonium,
Feishin, Supersonic, Amperfy, DSub, Music Assistant…). Jellyfin has none.

## Decision
Expose `/rest/*` (Subsonic 1.16.1 + OpenSubsonic extensions) from MMO Server core:
`ping`, `getLicense`, `getOpenSubsonicExtensions`, `getArtists`, `getArtist`,
`getAlbum`, `getSong`, `getAlbumList2`, `search3`, `stream`, `getCoverArt`,
`getPlaylists`/`createPlaylist`/`updatePlaylist`/`deletePlaylist`, `scrobble`,
`star`/`unstar`, `getStarred2`, `getLyricsBySongId`, `getRandomSongs`, `getGenres`.
Extensions: `apiKeyAuthentication`, `formPost`, `songLyrics`, `transcodeOffset`.
IDs are strings prefixed by type (`tr_`, `al_`, `ar_`, `pl_`). Plays are counted
only on `scrobble?submission=true`.

## Consequences
- Requires album/artist aggregation views over the existing `tracks` table.
- Token auth (`t`/`s` MD5 salt) needs a stored plaintext-equivalent secret → use the
  device token as the Subsonic password and prefer `apiKey`.
