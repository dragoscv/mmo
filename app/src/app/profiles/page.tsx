import { auth } from "@/auth";
import { db } from "@/db";
import { watchProfiles } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { CreateProfileForm } from "./_create-form";
import { ProfileCard } from "@/components/profile-card";
import { getActiveProfileId } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

export default async function ProfilesPage() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return <main style={{ padding: "2rem" }}><p>Autentifică-te.</p></main>;
    const [rows, activeId] = await Promise.all([
        db.select().from(watchProfiles).where(eq(watchProfiles.userId, userId)).orderBy(asc(watchProfiles.sortOrder)),
        getActiveProfileId(),
    ]);

    return (
        <main style={{ padding: "2rem", maxWidth: 960, margin: "0 auto" }}>
            <h1 style={{ fontSize: "2rem", fontWeight: 800 }}>Profiluri de vizionare</h1>
            <p style={{ color: "var(--muted-foreground, #888)", marginTop: ".25rem" }}>
                Fiecare profil are propriul istoric, watch-list și recomandări. Apasă pe un profil pentru a-l face activ.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "1rem", marginTop: "2rem" }}>
                {rows.map((p) => (
                    <ProfileCard
                        key={p.id}
                        id={p.id}
                        name={p.name}
                        color={p.color}
                        isKid={!!p.isKid}
                        active={activeId === p.id}
                    />
                ))}
            </div>

            <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginTop: "3rem", marginBottom: "1rem" }}>Adaugă profil nou</h2>
            <CreateProfileForm />
        </main>
    );
}
