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
 * `aria-pressed`; colours come only from token variables. Focus ring is the
 * global `:focus-visible` outline from @mmo/ui.
 */
export function ToggleChip({ pressed, accent = "var(--accent)", size = "sm", style, children, disabled, ...rest }: ToggleChipProps) {
    const on = pressed === true;
    const unavailable = disabled || rest["aria-disabled"] === true || rest["aria-disabled"] === "true";
    return (
        <button
            type="button"
            aria-pressed={pressed === undefined ? undefined : on}
            disabled={disabled}
            {...rest}
            style={{
                padding: size === "xs" ? "3px 7px" : "6px 9px",
                borderRadius: size === "xs" ? 6 : 8,
                fontSize: size === "xs" ? 9 : 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                lineHeight: 1.1,
                background: on ? accent : "var(--bg-elev-2)",
                color: on ? "var(--accent-fg)" : "var(--fg)",
                opacity: unavailable ? 0.4 : 1,
                cursor: unavailable ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                whiteSpace: "nowrap",
                ...style,
            }}
        >
            {children}
        </button>
    );
}
