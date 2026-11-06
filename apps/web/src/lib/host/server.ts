import "server-only";
import { headers } from "next/headers";
import { hostKind, hostRoutingEnabled, type HostKind } from "./products";

const ROOT = process.env.MIXAI_ROOT_DOMAIN?.trim() || undefined;

/** Host of the current request (Cloud Run forwards the custom domain in `host`). */
export async function requestHost(): Promise<string | null> {
    const h = await headers();
    return h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host");
}

/** Product the current request is served as (`legacy` on run.app / localhost). */
export async function currentHostKind(): Promise<HostKind> {
    if (!hostRoutingEnabled()) return "legacy";
    return hostKind(await requestHost(), ROOT);
}

export function rootDomain(): string {
    return ROOT ?? "mixai.ro";
}
