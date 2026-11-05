/**
 * Loading / empty / error states (every screen uses all three).
 *   <LoadingRows rows={2} kind="poster" />      skeleton rows (shimmer; static under reduced motion)
 *   <LoadingBlock lines={3} />                  skeleton text block
 *   <Empty icon="movie" title="…" message="…" action={{label, onClick}} />
 *   <ErrorState message="…" onRetry={…} />
 */
import type { ReactNode } from "react";
import { t } from "../i18n/messages";
import { PrimaryButton, SecondaryButton } from "./Buttons";
import { CARD_REM } from "./Cards";
import { Icon, type IconName } from "./icons";

export function LoadingRows({ rows = 2, kind = "poster", count = 8 }: { rows?: number; kind?: "poster" | "landscape" | "square"; count?: number }) {
    return (
        <div className="skel-rows" aria-busy="true" aria-label={t("common.loading")}>
            {Array.from({ length: rows }, (_, r) => (
                <div key={r} className="skel-row">
                    <div className="skel skel-line skel-title" />
                    <div className="skel-track">
                        {Array.from({ length: count }, (_, i) => (
                            <div key={i} className={`skel skel-card skel-${kind}`} style={{ width: `${CARD_REM[kind]}rem` }} />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

export function LoadingBlock({ lines = 3 }: { lines?: number }) {
    return (
        <div className="skel-block" aria-busy="true" aria-label={t("common.loading")}>
            {Array.from({ length: lines }, (_, i) => <div key={i} className="skel skel-line" style={{ width: `${90 - i * 15}%` }} />)}
        </div>
    );
}

export interface StateAction { label: string; onClick: () => void; icon?: IconName }

export function Empty({ icon = "info", title, message, action, secondary }: {
    icon?: IconName; title?: ReactNode; message?: ReactNode; action?: StateAction; secondary?: StateAction;
}) {
    return (
        <div className="state state-empty" role="status">
            <div className="state-icon"><Icon name={icon} /></div>
            <div className="state-title">{title ?? t("state.emptyTitle")}</div>
            {message && <div className="state-msg">{message}</div>}
            {(action || secondary) && (
                <div className="state-actions">
                    {action && <PrimaryButton label={action.label} icon={action.icon} onClick={action.onClick} focusKey="state:action" />}
                    {secondary && <SecondaryButton label={secondary.label} icon={secondary.icon} onClick={secondary.onClick} focusKey="state:secondary" />}
                </div>
            )}
        </div>
    );
}

export function ErrorState({ message, onRetry, title }: { message: ReactNode; onRetry?: () => void; title?: ReactNode }) {
    return (
        <div className="state state-error" role="alert">
            <div className="state-icon"><Icon name="alert" /></div>
            <div className="state-title">{title ?? t("state.errorTitle")}</div>
            <div className="state-msg">{message}</div>
            {onRetry && (
                <div className="state-actions">
                    <PrimaryButton label={t("common.retry")} icon="refresh" onClick={onRetry} focusKey="state:retry" />
                </div>
            )}
        </div>
    );
}
