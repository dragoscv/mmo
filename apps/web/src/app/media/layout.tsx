import "./media-home.css";
import "./mx.css";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import { getMmoConnections } from "@/actions/mmo";
import { MmoProvider } from "@/components/mmo/mmo-provider";
import { MediaShell } from "@/components/mmo/media-shell";
import { centralLoginUrl } from "@/lib/host/login";
import { currentHostKind, rootDomain } from "@/lib/host/server";

/**
 * `/media/*` — WP16 cinematic media surface (D31): one connection to the user's MMO Server
 * (profiles, hub, music, Live TV) resolved here once, then client screens read through `useMmo()`.
 * No account needed (D59): without a session the shell offers "Connect to a server" (Quick Connect from the
 * browser, kept in localStorage) next to "Sign in"; account servers come from the session as before.
 */
export default async function MediaLayout({ children }: { children: ReactNode }) {
    const session = await auth();
    const signedIn = Boolean(session?.user?.id);
    const kind = await currentHostKind();
    // The layout has no pathname: send each product host back to its own home (music.mixai.ro → Music, not TV).
    const home = kind === "music" ? "/media/music" : "/media";
    const loginHref = signedIn ? null : centralLoginUrl(kind, home, rootDomain()) ?? `/login?from=${home}`;
    const { servers } = signedIn ? await getMmoConnections() : { servers: [] };
    return (
        <MmoProvider servers={servers} signedIn={signedIn}>
            <MediaShell loginHref={loginHref}>{children}</MediaShell>
        </MmoProvider>
    );
}
