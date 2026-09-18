import { auth } from "@/auth";
import { db } from "@/db";
import { devices, companionDevices } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { Page, PageHeader, PageSection } from "@mmo/ui";
import { notSignedInFor } from "@/components/empty-state-server";
import { CompanionsTable, CompanionConfigsTable, type CompanionRow, type CompanionConfigRow } from "@/components/settings/companions-table";

export const dynamic = "force-dynamic";

export default async function CompanionsSettingsPage() {
    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("settings");
    const userId = session.user.id;
    const t = await getTranslations("tables.companions");

    const [devRows, compRows] = await Promise.all([
        db.select().from(devices).where(eq(devices.userId, userId)).orderBy(desc(devices.lastSeenAt)),
        db.select().from(companionDevices).where(eq(companionDevices.userId, userId)),
    ]);

    const rows: CompanionRow[] = devRows.map((d) => ({
        id: d.id,
        name: d.name ?? d.id,
        platform: d.os,
        version: d.version,
        lanUrl: d.lanUrl,
        lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null,
        status: d.status,
    }));

    const configRows: CompanionConfigRow[] = compRows.map((c) => ({
        id: c.id,
        machineId: c.machineId,
        hostname: c.hostname,
        platform: c.platform,
        friendlyName: c.friendlyName,
        publicIp: c.publicIp,
        lastSeen: c.lastSeen ? new Date(c.lastSeen).toISOString() : null,
        capabilities: (c.capabilities ?? {}) as Record<string, unknown>,
    }));

    return (
        <Page width="lg" className="flex flex-col gap-8">
            <PageHeader title={t("title")} description={t("description")} className="mb-0" />
            <CompanionsTable rows={rows} />
            {configRows.length > 0 ? (
                <PageSection title={t("configTitle")}>
                    <CompanionConfigsTable rows={configRows} />
                </PageSection>
            ) : null}
        </Page>
    );
}
