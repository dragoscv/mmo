import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ToggleChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
    /** Toggle state; omit for a plain (momentary) button. */
    pressed?: boolean;
    /** Colour when pressed (a CSS variable from the design tokens). */
    accent?: string;
    /** Visual size. */
    size?: "xs" | "sm";
    children: ReactNode;
}

/**
 * Small DJ-style button. When `pressed` is given it is a toggle and exposes
 * `aria-pressed`; the look comes from the `dk-btn` class (src/look/look.css): in the
 * Signature look every ON state is the one accent, in the classic look it is `accent`.
 * Never smaller than 24×24 CSS px (WCAG 2.2 2.5.8), so it can sit in the tightest panel tier.
 */
export function ToggleChip({ pressed, accent = "var(--accent)", size = "sm", style, className, children, disabled, ...rest }: ToggleChipProps) {
    const on = pressed === true;
    return (
        <button
            type="button"
            aria-pressed={pressed === undefined ? undefined : on}
            disabled={disabled}
            {...rest}
            className={`dk-btn${size === "xs" ? " dk-btn-xs" : ""}${className ? ` ${className}` : ""}`}
            style={{ ["--chip-accent" as string]: accent, ...style }}
        >
            {children}
        </button>
    );
}
