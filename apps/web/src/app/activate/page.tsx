import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { lookupDeviceCode } from "@/actions/device-code";
import { isValidUserCode, normalizeUserCode } from "@/lib/device-code";
import { ActivateClient } from "./activate-client";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
    return (Array.isArray(v) ? v[0] : v) ?? "";
}

export default async function ActivatePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
    const sp = await searchParams;
    const code = normalizeUserCode(first(sp.code));

    const session = await auth();
    if (!session?.user) {
        const back = `/activate${code ? `?code=${code}` : ""}`;
        redirect(`/login?callbackUrl=${encodeURIComponent(back)}`);
    }

    const initial = code && isValidUserCode(code) ? await lookupDeviceCode(code) : null;

    return <ActivateClient initialCode={code} initialLookup={initial} />;
}
