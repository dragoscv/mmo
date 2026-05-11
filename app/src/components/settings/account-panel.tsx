"use client";

import { useState, useTransition } from "react";
import { Download, Trash2, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { exportUserData, deleteAccount } from "@/actions/account";

/**
 * Account panel — GDPR-style "export my data" + "delete my account".
 *
 * Export downloads a JSON file synthesised from a server-action result,
 * client-side, so no separate Route Handler is needed. Delete requires
 * the user to type the literal string "DELETE" into a confirmation
 * field (matched server-side too) — guards against accidental clicks
 * and against CSRF-style replay since the value is bound to the form.
 */
export function AccountPanel() {
    const t = useTranslations("account");
    const [exportPending, startExport] = useTransition();
    const [deletePending, startDelete] = useTransition();
    const [confirmation, setConfirmation] = useState("");

    const onExport = () => {
        startExport(async () => {
            const result = await exportUserData();
            if (!result.ok) {
                toast.error(t("exportFailed", { error: result.error }));
                return;
            }
            // Build a JSON blob and trigger a save dialog.
            const blob = new Blob([JSON.stringify(result.data, null, 2)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            const date = new Date().toISOString().slice(0, 10);
            a.download = `mmo-export-${date}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            toast.success(t("exportSuccess"));
        });
    };

    const onDelete = () => {
        if (confirmation !== "DELETE") {
            toast.error(t("deleteConfirmRequired"));
            return;
        }
        startDelete(async () => {
            const result = await deleteAccount(confirmation);
            if (!result.ok) {
                toast.error(t("deleteFailed", { error: result.error }));
                return;
            }
            toast.success(t("deleteSuccess"));
            // Reload to /; the session cookie is gone and the home page
            // will redirect to sign-in if the route is gated.
            window.location.href = "/";
        });
    };

    return (
        <section className="rounded-xl border border-border bg-card p-5 space-y-5">
            <header>
                <h2 className="flex items-center gap-2 text-base font-semibold">
                    <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                    {t("title")}
                </h2>
                <p className="text-xs text-muted-foreground mt-1">{t("subtitle")}</p>
            </header>

            <div className="space-y-3 rounded-lg border border-border bg-background/40 p-4">
                <div>
                    <h3 className="text-sm font-medium">{t("exportTitle")}</h3>
                    <p className="text-xs text-muted-foreground mt-1">{t("exportSubtitle")}</p>
                </div>
                <button
                    type="button"
                    onClick={onExport}
                    disabled={exportPending}
                    className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
                >
                    <Download className="h-4 w-4" />
                    {exportPending ? t("exporting") : t("exportButton")}
                </button>
            </div>

            <div className="space-y-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
                <div>
                    <h3 className="text-sm font-medium text-red-200">{t("deleteTitle")}</h3>
                    <p className="text-xs text-muted-foreground mt-1">{t("deleteSubtitle")}</p>
                </div>
                <label className="block text-xs text-muted-foreground" htmlFor="account-delete-confirm">
                    {t("deleteConfirmLabel")}
                </label>
                <input
                    id="account-delete-confirm"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                    placeholder="DELETE"
                    disabled={deletePending}
                    className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono"
                />
                <button
                    type="button"
                    onClick={onDelete}
                    disabled={deletePending || confirmation !== "DELETE"}
                    className="inline-flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <Trash2 className="h-4 w-4" />
                    {deletePending ? t("deleting") : t("deleteButton")}
                </button>
            </div>
        </section>
    );
}
