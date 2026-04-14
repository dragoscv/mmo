import { DrivesClient } from "./drives-client";

export const dynamic = "force-dynamic";

export default function DrivesPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold">Drive Manager</h1>
                <p className="text-[var(--muted-foreground)]">
                    Gestionează drive-urile conectate
                </p>
            </div>

            <DrivesClient />
        </div>
    );
}
