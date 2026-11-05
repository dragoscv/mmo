/**
 * Screen context: everything a screen needs, passed as `ctx` (stable object per connection/profile).
 * Screens are `(props: ScreenProps<"name">) => JSX` and receive the narrowed route as `params`.
 */
import type { MmoClient } from "../lib/api";
import type { ServerConfig, Session } from "../lib/config";
import type { HubClient } from "../lib/hub";
import type { LiveTvClient } from "../lib/livetv";
import type { MediaClient } from "../lib/media";
import type { MusicClient } from "../lib/music";
import type { ProfilesClient } from "../lib/profiles";
import type { Locale } from "../i18n/messages";
import type { NavApi } from "./Nav";
import type { RouteName, RouteOf } from "./routes";

/** App-level actions screens may trigger (Settings, Profiles). */
export interface AppActions {
    /** Forget the server and go to discovery. */
    disconnect(): void;
    /** Sign out of the MixAI account (null when not signed in with an account). */
    signOut: (() => void) | null;
    /** Signed-in MixAI account (device-code flow) or null. */
    session: Session | null;
    /** Call after the active profile changed (re-hello on the hub, Home revalidates). */
    profileChanged(): void;
}

export interface ScreenCtx {
    client: MmoClient;
    media: MediaClient;
    profiles: ProfilesClient;
    music: MusicClient;
    livetv: LiveTvClient;
    hub: HubClient;
    cfg: ServerConfig;
    nav: NavApi;
    lang: Locale;
    app: AppActions;
}

export interface ScreenProps<N extends RouteName> {
    ctx: ScreenCtx;
    params: RouteOf<N>;
}
