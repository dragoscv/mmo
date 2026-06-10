import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { RekordboxImportCard } from "@/components/library/rekordbox-import-card";

export const dynamic = "force-dynamic";

export default async function LibraryImportPage() {
    const session = await auth();
    if (!session?.user?.id) redirect("/auth/signin?next=/library/import");

    return (
        <div className="px-3 sm:px-4 md:px-6 py-4 sm:py-5 md:py-6 max-w-2xl mx-auto space-y-6">
            <header>
                <h1 className="text-3xl font-bold">Import library</h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Bootstrap your cloud library from a rekordbox export. Tracks land in the cloud
                    Postgres mirror; the companion will pick them up and reconcile against the
                    on-disk files when you next launch it.
                </p>
            </header>

            <RekordboxImportCard />
        </div>
    );
}
