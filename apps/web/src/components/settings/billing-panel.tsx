"use client";

import { useTransition, useState } from "react";
import { CreditCard, Crown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BillingPanelProps {
    plan: "free" | "pro_monthly" | "pro_yearly";
    isPro: boolean;
    status: string;
    currentPeriodEnd: Date | string | null;
    cancelAtPeriodEnd: boolean;
}

const PLAN_LABEL: Record<BillingPanelProps["plan"], string> = {
    free: "Free",
    pro_monthly: "Pro · monthly",
    pro_yearly: "Pro · yearly",
};

export function BillingPanel({ plan, isPro, status, currentPeriodEnd, cancelAtPeriodEnd }: BillingPanelProps) {
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const openPortal = () => {
        setError(null);
        startTransition(async () => {
            try {
                const res = await fetch("/api/billing/portal", { method: "POST" });
                if (!res.ok) {
                    const body = (await res.json().catch(() => ({}))) as { error?: string };
                    throw new Error(body.error ?? `HTTP ${res.status}`);
                }
                const { url } = (await res.json()) as { url: string };
                window.location.href = url;
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        });
    };

    const renewLabel = currentPeriodEnd
        ? new Date(currentPeriodEnd).toLocaleDateString(undefined, { dateStyle: "medium" })
        : null;

    return (
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
            <header className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-base font-semibold">
                    <CreditCard className="h-4 w-4 text-muted-foreground" />
                    Billing
                </h2>
                <span
                    className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border",
                        isPro
                            ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
                            : "border-border bg-muted text-muted-foreground",
                    )}
                >
                    {isPro && <Crown className="h-3 w-3" />}
                    {PLAN_LABEL[plan]}
                </span>
            </header>

            <dl className="grid grid-cols-2 gap-3 text-sm">
                <dt className="text-muted-foreground">Status</dt>
                <dd className="font-mono">{status}</dd>
                {renewLabel && (
                    <>
                        <dt className="text-muted-foreground">{cancelAtPeriodEnd ? "Cancels on" : "Renews on"}</dt>
                        <dd>{renewLabel}</dd>
                    </>
                )}
            </dl>

            <div className="flex items-center justify-between gap-3 pt-2">
                <p className="text-xs text-muted-foreground">
                    {isPro
                        ? "Manage payment, invoices and cancellation in the Stripe Customer Portal."
                        : "Upgrade to Pro for unlimited device sync, 50GB cloud backup, priority support."}
                </p>
                <button
                    type="button"
                    onClick={openPortal}
                    disabled={pending}
                    className={cn(
                        "shrink-0 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted",
                        pending && "opacity-60 cursor-progress",
                    )}
                >
                    {pending ? "Opening…" : isPro ? "Manage billing" : "View plans"}
                </button>
            </div>

            {error && <p className="text-xs text-red-300">Error: {error}</p>}
        </section>
    );
}
