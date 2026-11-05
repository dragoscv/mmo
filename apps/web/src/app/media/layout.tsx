import "./media-home.css";
import "./mx.css";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getMmoConnections } from "@/actions/mmo";
import { MmoProvider } from "@/components/mmo/mmo-provider";
import { MediaShell } from "@/components/mmo/media-shell";

/**
 * `/media/*` — WP16 cinematic media surface (D31): one connection to the user's MMO Server
 * (profiles, hub, music, Live TV) resolved here once, then client screens read through `useMmo()`.
 */
export default async function MediaLayout({ children }: { children: ReactNode }) {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/media");
    const { servers } = await getMmoConnections();
    return (
        <MmoProvider servers={servers}>
            <MediaShell>{children}</MediaShell>
        </MmoProvider>
    );
}
