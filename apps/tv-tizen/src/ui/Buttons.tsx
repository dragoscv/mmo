/**
 * Buttons (all D-pad focusable). `focusKey` → `data-focus-key` for keep-alive restoration.
 *   <PrimaryButton icon="play" label="Play" onClick={…} />
 *   <SecondaryButton icon="plus" label="Watchlist" />
 *   <IconButton icon="subtitles" label="Subtitles" />   (label = aria-label + tooltip under on focus)
 *   <Chips items={[{id, label}]} value={id} onChange={…} rowId="genres" />
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export interface ButtonProps {
    label: ReactNode;
    icon?: IconName;
    onClick?: () => void;
    focusKey?: string;
    /** Second line under the label. */
    sub?: ReactNode;
    disabled?: boolean;
    active?: boolean;
    className?: string;
    testId?: string;
    autoFocus?: boolean;
}

function Btn({ variant, ...p }: ButtonProps & { variant: "primary" | "secondary" | "ghost" }) {
    return (
        <button
            type="button"
            className={`tbtn tbtn-${variant}${p.active ? " is-active" : ""}${p.className ? ` ${p.className}` : ""}`}
            data-focusable=""
            data-focus-key={p.focusKey}
            data-testid={p.testId}
            disabled={p.disabled}
            autoFocus={p.autoFocus}
            aria-pressed={p.active === undefined ? undefined : p.active}
            onClick={p.onClick}
        >
            {p.icon && <Icon name={p.icon} className="tbtn-icon" />}
            <span className="tbtn-text">
                <span className="tbtn-label">{p.label}</span>
                {p.sub && <span className="tbtn-sub">{p.sub}</span>}
            </span>
        </button>
    );
}

export function PrimaryButton(p: ButtonProps) { return <Btn {...p} variant="primary" />; }
export function SecondaryButton(p: ButtonProps) { return <Btn {...p} variant="secondary" />; }
export function GhostButton(p: ButtonProps) { return <Btn {...p} variant="ghost" />; }

export interface IconButtonProps {
    icon: IconName;
    /** Accessible name; also shown as a caption under the button while focused. */
    label: string;
    onClick?: () => void;
    focusKey?: string;
    active?: boolean;
    disabled?: boolean;
    className?: string;
    testId?: string;
}

export function IconButton(p: IconButtonProps) {
    return (
        <button
            type="button"
            className={`ibtn${p.active ? " is-active" : ""}${p.className ? ` ${p.className}` : ""}`}
            data-focusable=""
            data-focus-key={p.focusKey}
            data-testid={p.testId}
            aria-label={p.label}
            aria-pressed={p.active === undefined ? undefined : p.active}
            disabled={p.disabled}
            onClick={p.onClick}
        >
            <Icon name={p.icon} />
            <span className="ibtn-caption" aria-hidden="true">{p.label}</span>
        </button>
    );
}

export interface ChipItem { id: string; label: ReactNode; icon?: IconName }

export interface ChipsProps {
    items: ChipItem[];
    value?: string | null;
    onChange?: (id: string) => void;
    /** `data-focus-row` id (default "chips"). */
    rowId?: string;
    wrap?: boolean;
    className?: string;
}

export function Chips({ items, value, onChange, rowId = "chips", wrap, className }: ChipsProps) {
    return (
        <div className={`chips${className ? ` ${className}` : ""}`} role="tablist" data-focus-row={rowId} {...(wrap ? { "data-focus-wrap": "" } : {})}>
            {items.map((c) => (
                <button key={c.id} type="button" role="tab" aria-selected={c.id === value}
                    className={`chip${c.id === value ? " is-active" : ""}`} data-focusable="" data-focus-key={`${rowId}:${c.id}`}
                    onClick={() => onChange?.(c.id)}>
                    {c.icon && <Icon name={c.icon} />}{c.label}
                </button>
            ))}
        </div>
    );
}
