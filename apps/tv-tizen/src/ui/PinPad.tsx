/**
 * 4-digit PIN entry: remote number keys (0–9, registered in tv-keys) + an on-screen keypad.
 *   <PinPad title="PIN for Ana" error={msg} onComplete={(pin) => …} onCancel={…} disabled={busy} resetKey={n} />
 * `onComplete` fires once 4 digits are in; bump `resetKey` (e.g. after a wrong PIN) to clear + shake.
 * Renders as a focus-trapped overlay; Back cancels.
 */
import { useEffect, useRef, useState } from "react";
import { useBackHandler } from "../nav/back";
import { t } from "../i18n/messages";
import { Icon } from "./icons";
import { useFocusScope } from "./Overlay";

export const PIN_LENGTH = 4;

export interface PinPadProps {
    title: string;
    /** Error line (wrong PIN / locked). */
    error?: string | null;
    onComplete: (pin: string) => void;
    onCancel: () => void;
    disabled?: boolean;
    /** Change to clear the digits and play the shake animation. */
    resetKey?: number;
}

/** Digit from a key event (top row 48–57, numpad 96–105, Tizen remote sends 48–57). */
export function digitFromEvent(e: KeyboardEvent): string | null {
    const k = e.keyCode;
    if (k >= 48 && k <= 57) return String(k - 48);
    if (k >= 96 && k <= 105) return String(k - 96);
    return /^[0-9]$/.test(e.key) ? e.key : null;
}

export function PinPad({ title, error, onComplete, onCancel, disabled, resetKey = 0 }: PinPadProps) {
    const [digits, setDigits] = useState("");
    const [shake, setShake] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const firstReset = useRef(true);
    useFocusScope(ref, true);
    useBackHandler(() => { onCancel(); }, true);

    useEffect(() => {
        if (firstReset.current) { firstReset.current = false; return; }
        setDigits("");
        setShake(true);
        const h = setTimeout(() => setShake(false), 450);
        return () => clearTimeout(h);
    }, [resetKey]);

    const add = (d: string) => {
        if (disabled) return;
        setDigits((cur) => {
            if (cur.length >= PIN_LENGTH) return cur;
            const next = cur + d;
            if (next.length === PIN_LENGTH) setTimeout(() => onComplete(next), 0);
            return next;
        });
    };
    const back = () => setDigits((cur) => cur.slice(0, -1));

    // Remote number keys.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const d = digitFromEvent(e);
            if (d === null) return;
            e.preventDefault();
            e.stopPropagation();
            add(d);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [disabled]);

    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    return (
        <div className="overlay" role="presentation">
            <div ref={ref} className="pinpad" role="dialog" aria-modal="true" aria-label={title} data-focus-scope="" data-testid="pinpad">
                <h2 className="pinpad-title">{title}</h2>
                <div className={`pin-dots${shake ? " shake" : ""}`} aria-label={t("pin.label")} aria-live="polite">
                    {Array.from({ length: PIN_LENGTH }, (_, i) => <span key={i} className={i < digits.length ? "on" : ""} />)}
                </div>
                <div className="pin-error" role="alert">{error ?? ""}</div>
                <div className="pin-keys">
                    {[0, 1, 2].map((r) => (
                        <div key={r} className="pin-row" data-focus-row={`pin-${r}`}>
                            {keys.slice(r * 3, r * 3 + 3).map((k) => (
                                <button key={k} type="button" className="pin-key" data-focusable="" data-focus-key={`pin:${k}`} disabled={disabled} onClick={() => add(k)}>{k}</button>
                            ))}
                        </div>
                    ))}
                    <div className="pin-row" data-focus-row="pin-3">
                        <button type="button" className="pin-key pin-key-aux" data-focusable="" data-focus-key="pin:clear" onClick={() => setDigits("")} aria-label={t("pin.clear")}>
                            <Icon name="close" />
                        </button>
                        <button type="button" className="pin-key" data-focusable="" data-focus-key="pin:0" disabled={disabled} onClick={() => add("0")}>0</button>
                        <button type="button" className="pin-key pin-key-aux" data-focusable="" data-focus-key="pin:back" onClick={back} aria-label={t("pin.backspace")}>
                            <Icon name="backspace" />
                        </button>
                    </div>
                </div>
                <div className="pin-hint">{t("pin.hint")}</div>
            </div>
        </div>
    );
}
