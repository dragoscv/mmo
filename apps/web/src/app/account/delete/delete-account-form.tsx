"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Loader2, Trash2 } from "lucide-react";
import { deleteAccount } from "@/actions/account";
import { Button, buttonVariants } from "@/components/ui/button";

export function DeleteAccountForm({ word }: { word: string }) {
    const t = useTranslations("mx.account.delete");
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [pending, start] = useTransition();
    const matches = value.trim() === word;

    if (done) {
        return (
            <div role="status" className="space-y-2">
                <p className="text-base font-semibold">{t("doneTitle")}</p>
                <p className="text-sm text-muted-foreground">{t("doneBody")}</p>
                <Link href="/" className={buttonVariants({ variant: "outline" })}>{t("doneHome")}</Link>
            </div>
        );
    }

    const onSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!matches) {
            setError(t("mismatch", { word }));
            return;
        }
        setError(null);
        start(async () => {
            const r = await deleteAccount(value.trim());
            if (r.ok) setDone(true);
            else setError(t("failed", { error: r.error }));
        });
    };

    return (
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
            <p className="text-sm text-muted-foreground">{t("confirmHint")}</p>
            <label htmlFor="account-delete-word" className="block text-sm font-medium">
                {t("confirmLabel", { word })}
            </label>
            <input
                id="account-delete-word"
                name="confirmation"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={value}
                onChange={(e) => { setValue(e.target.value); setError(null); }}
                disabled={pending}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "account-delete-error" : undefined}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {error && <p id="account-delete-error" role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" variant="destructive" disabled={pending || !matches} className="gap-2">
                {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                {pending ? t("deleting") : t("button")}
            </Button>
        </form>
    );
}
