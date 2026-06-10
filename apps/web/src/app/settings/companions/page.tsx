import { auth } from "@/auth";
import { db } from "@/db";
import { devices, companionDevices } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function CompanionsSettingsPage() {
    const session = await auth();
    if (!session?.user?.id) return <main className="p-6"><p>Autentifică-te.</p></main>;
    const userId = session.user.id;

    const [devRows, compRows] = await Promise.all([
        db.select().from(devices).where(eq(devices.userId, userId)).orderBy(desc(devices.lastSeenAt)),
        db.select().from(companionDevices).where(eq(companionDevices.userId, userId)),
    ]);

    return (
        <main className="p-4 sm:p-6 max-w-4xl space-y-6">
            <header>
                <h1 className="text-2xl font-bold">Companions</h1>
                <p className="text-sm text-muted-foreground">Aplicații desktop companion pereche cu acest cont.</p>
            </header>

            <section className="rounded-lg border border-border bg-card overflow-hidden">
                <table className="w-full text-sm">
                    <thead className="bg-muted/40">
                        <tr>
                            <th className="text-left p-2">Nume</th>
                            <th className="text-left p-2">Platform</th>
                            <th className="text-left p-2">Last seen</th>
                            <th className="text-left p-2">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {devRows.length === 0 && (
                            <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">Niciun dispozitiv pereche.</td></tr>
                        )}
                        {devRows.map(d => (
                            <tr key={d.id} className="border-t border-border">
                                <td className="p-2 font-medium">{d.name ?? d.id}</td>
                                <td className="p-2">{d.os ?? "—"}</td>
                                <td className="p-2 text-xs text-muted-foreground">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "—"}</td>
                                <td className="p-2">{d.status === "online" ? <span className="text-green-600">online</span> : <span className="text-muted-foreground">{d.status}</span>}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>

            {compRows.length > 0 && (
                <section className="rounded-lg border border-border bg-card p-4">
                    <h2 className="font-semibold mb-3">Configurări companion</h2>
                    <pre className="text-xs overflow-auto bg-muted/30 p-3 rounded">{JSON.stringify(compRows, null, 2)}</pre>
                </section>
            )}
        </main>
    );
}
