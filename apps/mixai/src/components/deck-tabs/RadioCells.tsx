import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@mmo/ui";

export interface RadioCell<T extends string | number> {
    value: T;
    /** Visible content: text (also the accessible name unless `ariaLabel` is given) or an icon (then `ariaLabel` is required). */
    label: ReactNode;
    title?: string;
    ariaLabel?: string;
}

/**
 * One-of-many choice as a row of `dk-cell`s (selected = outline). A real radio group: one tab
 * stop, arrow keys / Home / End move and select, like the native control.
 */
export function RadioCells<T extends string | number>({
    label,
    value,
    options,
    onChange,
    disabled = false,
    className,
    groupClass = "dt-radios",
}: {
    /** Accessible name of the group. */
    label: string;
    value: T;
    options: readonly RadioCell<T>[];
    onChange: (value: T) => void;
    disabled?: boolean;
    className?: string;
    /** Layout class of the group (the deck tabs' row by default; the mixer passes its own). */
    groupClass?: string;
}) {
    const selected = options.findIndex((o) => o.value === value);

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled || options.length === 0) return;
        const cur = selected >= 0 ? selected : 0;
        let next: number;
        switch (e.key) {
            case "ArrowRight":
            case "ArrowDown":
                next = (cur + 1) % options.length;
                break;
            case "ArrowLeft":
            case "ArrowUp":
                next = (cur - 1 + options.length) % options.length;
                break;
            case "Home":
                next = 0;
                break;
            case "End":
                next = options.length - 1;
                break;
            default:
                return;
        }
        // Keep the deck shortcuts (bound to bare keys) from firing while the group has focus.
        e.preventDefault();
        e.stopPropagation();
        // A held key moves the selection once: each step here changes the engine.
        if (e.repeat) return;
        const option = options[next];
        if (!option) return;
        onChange(option.value);
        e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
    };

    return (
        <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={cn(groupClass, className)} onKeyDown={onKeyDown}>
            {options.map((o, i) => {
                const on = i === selected;
                return (
                    <button
                        key={String(o.value)}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={o.ariaLabel}
                        data-on={on}
                        tabIndex={on || (selected < 0 && i === 0) ? 0 : -1}
                        disabled={disabled}
                        title={o.title}
                        className="dk-cell"
                        onClick={() => onChange(o.value)}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}
