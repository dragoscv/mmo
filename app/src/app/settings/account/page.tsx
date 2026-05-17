import { auth } from "@/auth";
import { getSubscription } from "@/lib/stripe";
import { BillingPanel } from "@/components/settings/billing-panel";
import { AccountPanel } from "@/components/settings/account-panel";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
    const session = await auth();
    if (!session?.user?.id) {
        return <main className="p-6"><p>Autentifică-te.</p></main>;
    }
    const sub = await getSubscription(session.user.id);
    return (
        <main className="p-4 sm:p-6 max-w-3xl space-y-6">
            <header>
                <h1 className="text-2xl font-bold">Cont &amp; facturare</h1>
                <p className="text-sm text-muted-foreground">Date cont, abonament, sesiune.</p>
            </header>
            {sub && (
                <BillingPanel
                    plan={sub.plan}
                    isPro={sub.isPro}
                    status={sub.status}
                    currentPeriodEnd={sub.currentPeriodEnd}
                    cancelAtPeriodEnd={sub.cancelAtPeriodEnd}
                />
            )}
            <AccountPanel />
        </main>
    );
}
