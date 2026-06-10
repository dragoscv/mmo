/** Optional Trakt.tv scrobbler. Disabled (no-op) unless both
 *  `TRAKT_CLIENT_ID` and the user has stored an access token in
 *  `users.traktAccessToken` (column not added yet — feature flag).
 *
 *  Wire-up:
 *   1. Set env `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET`
 *   2. Implement OAuth in a follow-up: redirect user to
 *      `https://trakt.tv/oauth/authorize?response_type=code&client_id=...&redirect_uri=...`
 *   3. Store the returned access token per user
 *   4. Pass it into `traktScrobble` from saveProgress
 *
 *  This stub keeps the integration surface stable so wiring it later is one
 *  function call. */

export interface TraktScrobbleInput {
    accessToken?: string;
    action: "start" | "pause" | "stop";
    /** Progress percent 0–100. */
    progress: number;
    /** Either movie or episode identifiers (TMDB ids). */
    movie?: { tmdbId: number; title: string; year?: number };
    episode?: { showTmdbId: number; season: number; episode: number };
}

export async function traktScrobble(input: TraktScrobbleInput): Promise<{ ok: boolean; reason?: string }> {
    const clientId = process.env.TRAKT_CLIENT_ID;
    if (!clientId || !input.accessToken) return { ok: false, reason: "disabled" };

    const body: Record<string, unknown> = { progress: Math.max(0, Math.min(100, input.progress)) };
    if (input.movie) {
        body.movie = {
            title: input.movie.title,
            year: input.movie.year,
            ids: { tmdb: input.movie.tmdbId },
        };
    } else if (input.episode) {
        body.episode = {
            season: input.episode.season,
            number: input.episode.episode,
        };
        body.show = { ids: { tmdb: input.episode.showTmdbId } };
    } else {
        return { ok: false, reason: "no target" };
    }

    try {
        const resp = await fetch(`https://api.trakt.tv/scrobble/${input.action}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "trakt-api-version": "2",
                "trakt-api-key": clientId,
                Authorization: `Bearer ${input.accessToken}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(4000),
        });
        return { ok: resp.ok, reason: resp.ok ? undefined : `http ${resp.status}` };
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : "fetch failed" };
    }
}
