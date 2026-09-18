import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { PairClient } from "./pair-client";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
    return Array.isArray(v) ? v[0] : v;
}

export default async function PairPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
    const sp = await searchParams;
    const host = first(sp.host) ?? "";
    const port = first(sp.port) ?? "";
    const code = first(sp.code) ?? "";

    const session = await auth();
    if (!session?.user) {
        const qs = new URLSearchParams();
        if (host) qs.set("host", host);
        if (port) qs.set("port", port);
        if (code) qs.set("code", code);
        const back = `/pair${qs.size ? `?${qs.toString()}` : ""}`;
        redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(back)}`);
    }

    return <PairClient initialHost={host} initialPort={port} initialCode={code} />;
}
