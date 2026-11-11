/**
 * Compact state tile of the library (checking, offline, not paired, loading, empty, no
 * results, error, local file). Full and compact tiers stack icon + title, detail and action;
 * the icon tier is one line (title + action) with the detail as a tooltip.
 */
import type { ReactNode } from "react";
import type { Tier } from "@/layout/types";

export function StateBlock({
    tier,
    icon,
    title,
    detail,
    detailOneLine,
    action,
    tone,
    busy,
}: {
    tier: Tier;
    icon?: ReactNode;
    title: string;
    detail?: string;
    /** Keep the detail on one truncated line (raw error text); the full text is the tooltip. */
    detailOneLine?: boolean;
    action?: ReactNode;
    /** The tone changes the icon colour only; the icon shape and the title carry the meaning. */
    tone?: "warning" | "error";
    busy?: boolean;
}) {
    const small = tier === "icon";
    return (
        <div className="lib-state" data-tier={tier} data-tone={tone} role={tone === "error" ? "alert" : "status"} aria-busy={busy || undefined}>
            <span className="lib-state-title" title={small ? detail : undefined}>
                {icon}
                <span className="lib-c">{title}</span>
            </span>
            {!small && detail && (
                <span className={detailOneLine ? "lib-state-detail lib-c" : "lib-state-detail"} title={detailOneLine ? detail : undefined}>
                    {detail}
                </span>
            )}
            {action && <span className="lib-state-actions">{action}</span>}
        </div>
    );
}
