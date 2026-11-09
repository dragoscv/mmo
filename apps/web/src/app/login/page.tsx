import { appleWebEnabled, auth } from "@/auth";
import { redirect } from "next/navigation";
import { LoginPageClient } from "./login-client";
import { centralLoginUrl, safeCallback } from "@/lib/host/login";
import { currentHostKind, rootDomain } from "@/lib/host/server";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
    const sp = await searchParams;
    // Same-origin paths everywhere; absolute https://*.mixai.ro callbacks only on product hosts (WP17-10).
    const kind = await currentHostKind();
    const callbackUrl = safeCallback(sp.callbackUrl ?? sp.from, kind, rootDomain());
    const session = await auth();
    if (session?.user) {
        redirect(callbackUrl);
    }
    // OAuth redirect URIs are registered for the apex: tv./music./app./decks. sign in there.
    const central = centralLoginUrl(kind, callbackUrl, rootDomain());
    if (central) redirect(central);

    return <LoginPageClient callbackUrl={callbackUrl} appleEnabled={appleWebEnabled} />;
}
