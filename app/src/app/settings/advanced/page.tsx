import { auth } from "@/auth";
import { listAiKeys } from "@/actions/ai-keys";
import { getPreferredAiProvider } from "@/actions/ai-tag";
import { AiKeysPanel } from "@/components/settings/ai-keys-panel";

export const dynamic = "force-dynamic";

export default async function AdvancedSettingsPage() {
    const session = await auth();
    if (!session?.user?.id) return <main className="p-6"><p>Autentifică-te.</p></main>;
    const [aiKeys, preferred] = await Promise.all([listAiKeys(), getPreferredAiProvider()]);
    return (
        <main className="p-4 sm:p-6 max-w-3xl space-y-6">
            <header>
                <h1 className="text-2xl font-bold">Avansat</h1>
                <p className="text-sm text-muted-foreground">Chei AI, debug, flag-uri experimentale.</p>
            </header>
            <AiKeysPanel keys={aiKeys} preferredProvider={preferred} />
        </main>
    );
}
