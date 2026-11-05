/**
 * On-screen keyboard (a–z, 0–9, space, ⌫, clear, RO diacritics toggle ă â î ș ț). Controlled:
 *   <Keyboard value={q} onChange={setQ} onDone={submit} />
 * Inline (not an overlay) — screens place it next to their results; rows are `data-focus-row`s with wrap.
 */
import { useState } from "react";
import { t } from "../i18n/messages";
import { Icon } from "./icons";

const LATIN = ["abcdefg", "hijklmn", "opqrstu", "vwxyz", "1234567", "890"];
const RO = ["ăâîșț", "abcdefg", "hijklmn", "opqrstu", "vwxyz", "1234567890"];

export interface KeyboardProps {
    value: string;
    onChange: (v: string) => void;
    /** "Done" key (submit / close). Hidden when omitted. */
    onDone?: () => void;
    maxLength?: number;
    className?: string;
    /** Prefix for focus keys/rows (default "kb"). */
    id?: string;
}

export function Keyboard({ value, onChange, onDone, maxLength = 80, className, id = "kb" }: KeyboardProps) {
    const [ro, setRo] = useState(false);
    const rows = ro ? RO : LATIN;
    const type = (ch: string) => { if (value.length < maxLength) onChange(value + ch); };
    return (
        <div className={`kb${className ? ` ${className}` : ""}`} role="group" aria-label="keyboard">
            {rows.map((r, ri) => (
                <div key={`${ro}-${ri}`} className="kb-row" data-focus-row={`${id}-${ri}`} data-focus-wrap="">
                    {Array.from(r).map((ch) => (
                        <button key={ch} type="button" className="kb-key" data-focusable="" data-focus-key={`${id}:${ch}`} onClick={() => type(ch)}>{ch}</button>
                    ))}
                </div>
            ))}
            <div className="kb-row kb-row-actions" data-focus-row={`${id}-actions`} data-focus-wrap="">
                <button type="button" className="kb-key kb-wide" data-focusable="" data-focus-key={`${id}:space`} onClick={() => type(" ")}>{t("kb.space")}</button>
                <button type="button" className="kb-key" data-focusable="" data-focus-key={`${id}:back`} aria-label={t("kb.backspace")} onClick={() => onChange(value.slice(0, -1))}>
                    <Icon name="backspace" />
                </button>
                <button type="button" className="kb-key" data-focusable="" data-focus-key={`${id}:clear`} aria-label={t("kb.clear")} onClick={() => onChange("")}>
                    <Icon name="close" />
                </button>
                <button type="button" className={`kb-key kb-wide${ro ? " is-active" : ""}`} data-focusable="" data-focus-key={`${id}:ro`} aria-pressed={ro} onClick={() => setRo((v) => !v)}>
                    {t("kb.diacritics")}
                </button>
                {onDone && (
                    <button type="button" className="kb-key kb-wide kb-done" data-focusable="" data-focus-key={`${id}:done`} onClick={onDone}>{t("kb.done")}</button>
                )}
            </div>
        </div>
    );
}
