/**
 * One set of MMO Server clients per connection (same shape as tv-tizen `makeClients`).
 * Browser-only: the clients use `fetch`, `WebSocket` and `localStorage`.
 */
import type { ServerConfig } from "./config";
import { HubClient } from "./hub";
import { LiveTvClient } from "./livetv";
import { MediaClient } from "./media";
import { MusicClient } from "./music";
import { ProfilesClient } from "./profiles";

export interface MmoClients {
    cfg: ServerConfig;
    profiles: ProfilesClient;
    media: MediaClient;
    music: MusicClient;
    livetv: LiveTvClient;
    hub: HubClient;
}

export function makeClients(cfg: ServerConfig, appVersion: string): MmoClients {
    const profiles = new ProfilesClient(cfg);
    return {
        cfg,
        profiles,
        media: new MediaClient(cfg, profiles),
        music: new MusicClient(cfg, profiles),
        livetv: new LiveTvClient(cfg, profiles),
        hub: new HubClient(cfg, () => profiles.profileId, appVersion),
    };
}
