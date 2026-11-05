/**
 * Kids screen-time gate for playback starts (WP16-50). `/video/*` is mounted before the media module
 * exists, so server.ts installs the checker here once media.sqlite is open (same pattern as
 * `library-hooks.ts`). Clients identify the viewer with `?profile=` / `x-profile-id`, or with a
 * profile token (`x-profile-token` / `?pt=`), which wins when valid.
 */

import type express from "express";

export type CapCheck = (profileId: string) => { overCap: boolean; dailyCapMin: number | null; watchMin: number } | null;
export type TokenProfile = (token: string) => string | null;

let check: CapCheck | null = null;
let tokenProfile: TokenProfile | null = null;

export function setPlaybackGate(c: CapCheck | null, t: TokenProfile | null = null): void {
    check = c;
    tokenProfile = t;
}

export function profileIdOfRequest(req: express.Request): string | null {
    const tok = req.header("x-profile-token") ?? (typeof req.query.pt === "string" ? req.query.pt : undefined);
    if (tok && tokenProfile) {
        const id = tokenProfile(tok);
        if (id) return id;
    }
    const p = req.header("x-profile-id") ?? (typeof req.query.profile === "string" ? req.query.profile : undefined);
    return p ? p.slice(0, 64) : null;
}

/** Express guard: 403 `{error:"daily_cap"}` when the request's kid profile is over its daily cap. */
export const playbackGate: express.RequestHandler<Record<string, string>> = (req, res, next) => {
    const id = check ? profileIdOfRequest(req as unknown as express.Request) : null;
    const st = id && check ? check(id) : null;
    if (st?.overCap) {
        res.status(403).json({ error: "daily_cap", profileId: id, dailyCapMin: st.dailyCapMin, watchMin: st.watchMin });
        return;
    }
    next();
};
