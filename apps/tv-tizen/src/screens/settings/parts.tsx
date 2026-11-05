/**
 * Settings building blocks: section frame, focusable rows (action / toggle / value), chip rows.
 * Every row is one D-pad stop; values sit at the right edge so a column of rows reads like a table.
 */
import type { ReactNode } from "react";
import { Chips, Icon, type ChipItem, type IconName } from "../../ui";

export function Section({ title, sub, children, testId }: { title: ReactNode; sub?: ReactNode; children: ReactNode; testId?: string }) {
    return (
        <section className="set-section" data-testid={testId}>
            <h2 className="set-h2">{title}</h2>
            {sub && <p className="set-sub">{sub}</p>}
            <div className="set-rows">{children}</div>
        </section>
    );
}

export function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
    return (
        <div className="set-group">
            <h3 className="set-h3">{title}</h3>
            {children}
        </div>
    );
}

export interface RowProps {
    label: ReactNode;
    value?: ReactNode;
    sub?: ReactNode;
    icon?: IconName;
    onClick?: () => void;
    focusKey: string;
    disabled?: boolean;
    destructive?: boolean;
    chevron?: boolean;
    testId?: string;
}

export function Row(p: RowProps) {
    return (
        <button type="button" className={`set-row${p.destructive ? " is-destructive" : ""}`} data-focusable="" data-focus-key={p.focusKey}
            data-testid={p.testId} disabled={p.disabled} onClick={p.onClick}>
            {p.icon && <Icon name={p.icon} className="set-row-icon" />}
            <span className="set-row-text">
                <span className="set-row-label">{p.label}</span>
                {p.sub && <span className="set-row-sub">{p.sub}</span>}
            </span>
            {p.value !== undefined && <span className="set-row-value">{p.value}</span>}
            {p.chevron && <Icon name="chevronRight" className="set-row-chev" />}
        </button>
    );
}

export function ToggleRow({ label, sub, checked, onChange, focusKey, disabled, testId }: {
    label: ReactNode; sub?: ReactNode; checked: boolean; onChange: (v: boolean) => void; focusKey: string; disabled?: boolean; testId?: string;
}) {
    return (
        <button type="button" role="switch" aria-checked={checked} className="set-row" data-focusable="" data-focus-key={focusKey}
            data-testid={testId} disabled={disabled} onClick={() => onChange(!checked)}>
            <span className="set-row-text">
                <span className="set-row-label">{label}</span>
                {sub && <span className="set-row-sub">{sub}</span>}
            </span>
            <span className={`set-switch${checked ? " is-on" : ""}`} aria-hidden="true"><span /></span>
        </button>
    );
}

/** Label + a chip row (each chip one D-pad stop; ←/→ moves between chips). */
export function ChipRow({ label, items, value, onChange, rowId }: {
    label: ReactNode; items: ChipItem[]; value: string | null; onChange: (id: string) => void; rowId: string;
}) {
    return (
        <div className="set-chiprow">
            <div className="set-row-label">{label}</div>
            <Chips items={items} value={value} onChange={onChange} rowId={rowId} />
        </div>
    );
}

export function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" | "success" }) {
    return <div className={`set-note set-note-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}
