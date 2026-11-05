/**
 * Screen scaffolding.
 *   <ScreenHeader title="…" right={…} />
 *   <StubScreen title="…" icon="music" />   heading + Empty state (placeholder until a screen agent builds it)
 * Layout: every rail screen is a `.tv-screen` (padding = overscan, scrolls vertically, `data-scroll="screen"`).
 */
import type { ReactNode } from "react";
import { t } from "../i18n/messages";
import { Empty, type StateAction } from "./States";
import type { IconName } from "./icons";

export function ScreenHeader({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
    return (
        <header className="tv-header">
            <div>
                <h1 className="tv-h1">{title}</h1>
                {sub && <p className="tv-sub">{sub}</p>}
            </div>
            {right && <div className="tv-header-right">{right}</div>}
        </header>
    );
}

export function StubScreen({ title, icon = "info", testId, action, children }: {
    title: ReactNode; icon?: IconName; testId?: string; action?: StateAction; children?: ReactNode;
}) {
    return (
        <div className="tv-screen" data-scroll="screen" data-testid={testId}>
            <ScreenHeader title={title} />
            <Empty icon={icon} title={title} message={t("screen.stub")} action={action} />
            {children}
        </div>
    );
}
