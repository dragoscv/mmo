import type { Metadata } from "next";
import { auth } from "@/auth";
import { centralLoginUrl } from "@/lib/host/login";
import { currentHostKind, rootDomain } from "@/lib/host/server";
import { ConnectClient } from "./connect-client";

export const metadata: Metadata = { title: "Connect · MixAI" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/connect` (D59, WP17-96) — connect this browser to an MMO Server WITHOUT a MixAI account: type an address (or
 * "Try the demo"), approve the Quick Connect code on the server or phone, and the device token stays in this
 * browser. Renders on every product host; `?server=` pre-fills, `?demo=1` starts the demo right away.
 */
export default async function ConnectPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
    const sp = await searchParams;
    const session = await auth();
    const kind = await currentHostKind();
    const home = kind === "music" ? "/media/music" : "/media";
    const loginHref = session?.user?.id ? null : centralLoginUrl(kind, home, rootDomain()) ?? `/login?from=${home}`;
    return (
        <ConnectClient
            home={home}
            loginHref={loginHref}
            initialServer={first(sp.server) ?? ""}
            autoDemo={first(sp.demo) === "1"}
        />
    );
}
