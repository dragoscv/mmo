import { Music } from "lucide-react";

import { auth } from "@/auth";
import { ProcessingModeSwitch } from "@/components/settings/processing-mode-switch";
import { getProcessingMode } from "@/lib/processing-mode";

export const dynamic = "force-dynamic";

export default async function Page() {
    const session = await auth();
    if (!session?.user?.id) {
        return <main className="p-6"><p>Autentifică-te.</p></main>;
    }
    const mode = await getProcessingMode(session.user.id);
    return (
        <main className="p-4 sm:p-6 max-w-3xl space-y-6">
            <header className="flex items-center gap-3">
                <Music className="h-6 w-6" />
                <div>
                    <h1 className="text-2xl font-bold">Music</h1>
                    <p className="text-sm text-muted-foreground">
                        Preferințe pentru playere, BPM/key detection, generare audio.
                    </p>
                </div>
            </header>
            <ProcessingModeSwitch initial={mode} />
        </main>
    );
}
