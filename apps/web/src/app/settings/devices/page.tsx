import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { getDevices } from "@/actions/devices";
import { notSignedInFor } from "@/components/empty-state-server";
import { DevicesSettingsPanel, type DeviceRow } from "@/components/settings/devices-settings-panel";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("nav");
    return { title: t("settings-devices") };
}

export default async function DevicesSettingsPage() {
    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("devices");
    const t = await getTranslations("settings.devices");
    const devices = await getDevices();
    const rows: DeviceRow[] = devices
        .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))
        .map((d) => ({
            id: d.id,
            name: d.name,
            os: d.os,
            hostname: d.hostname,
            lanUrl: d.lanUrl,
            lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
            status: d.status,
            version: d.version,
        }));
    return (
        <main className="space-y-6">
            <header>
                <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("title")}</h1>
                <p className="text-sm text-muted-foreground">{t("description")}</p>
            </header>
            <DevicesSettingsPanel rows={rows} />
        </main>
    );
}
