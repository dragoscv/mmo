/**
 * Focus-trapping overlays.
 *   useFocusScope(ref, open)  — registers `ref` as the active D-pad scope while `open` (focus v2 `pushFocusScope`)
 *   <Dialog open title message confirmLabel cancelLabel onConfirm onCancel destructive />   (Confirm)
 *   <SidePanel open title items={[{id,label,sub?,checked?}]} value onSelect onClose side="right" />  (choice list)
 * Back closes the topmost overlay (nav/back.ts) before any navigation happens.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { pushFocusScope } from "../lib/focus";
import { useBackHandler } from "../nav/back";
import { t } from "../i18n/messages";
import { PrimaryButton, SecondaryButton } from "./Buttons";
import { Icon, type IconName } from "./icons";

export function useFocusScope(ref: RefObject<HTMLElement | null>, open: boolean): void {
    useEffect(() => {
        if (!open || !ref.current) return;
        return pushFocusScope(ref.current, true);
    }, [open, ref]);
}

export interface DialogProps {
    open: boolean;
    title: ReactNode;
    message?: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
    destructive?: boolean;
    icon?: IconName;
    children?: ReactNode;
    testId?: string;
}

export function Dialog(p: DialogProps) {
    const ref = useRef<HTMLDivElement>(null);
    useFocusScope(ref, p.open);
    useBackHandler(() => { p.onCancel(); }, p.open);
    if (!p.open) return null;
    return (
        <div className="overlay" role="presentation">
            <div ref={ref} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" data-focus-scope="" data-testid={p.testId}>
                {p.icon && <div className="dialog-icon"><Icon name={p.icon} /></div>}
                <h2 id="dlg-title" className="dialog-title">{p.title}</h2>
                {p.message && <p className="dialog-msg">{p.message}</p>}
                {p.children}
                <div className="dialog-actions" data-focus-row="dialog-actions">
                    {/* Safe action first so OK on open never destroys anything. */}
                    <SecondaryButton label={p.cancelLabel ?? t("common.cancel")} onClick={p.onCancel} focusKey="dialog:cancel" testId="dialog-cancel" />
                    <PrimaryButton label={p.confirmLabel ?? t("common.ok")} onClick={p.onConfirm} focusKey="dialog:confirm"
                        className={p.destructive ? "tbtn-destructive" : undefined} testId="dialog-confirm" />
                </div>
            </div>
        </div>
    );
}

export interface SidePanelItem {
    id: string;
    label: ReactNode;
    sub?: ReactNode;
    icon?: IconName;
    disabled?: boolean;
}

export interface SidePanelProps {
    open: boolean;
    title: ReactNode;
    items: SidePanelItem[];
    /** Checked item id (radio semantics). */
    value?: string | null;
    onSelect: (id: string) => void;
    onClose: () => void;
    side?: "right" | "left";
    /** Extra content under the list (e.g. a toggle). */
    footer?: ReactNode;
    testId?: string;
}

export function SidePanel(p: SidePanelProps) {
    const ref = useRef<HTMLDivElement>(null);
    useFocusScope(ref, p.open);
    useBackHandler(() => { p.onClose(); }, p.open);
    // Land on the checked item rather than the first one.
    useEffect(() => {
        if (!p.open) return;
        const h = requestAnimationFrame(() => {
            const el = ref.current?.querySelector<HTMLElement>('[aria-checked="true"]');
            if (el) el.focus({ preventScroll: false });
        });
        return () => cancelAnimationFrame(h);
    }, [p.open]);
    if (!p.open) return null;
    return (
        <div className="overlay overlay-side" role="presentation">
            <div ref={ref} className={`sidepanel sidepanel-${p.side ?? "right"}`} role="dialog" aria-modal="true" aria-labelledby="sp-title" data-focus-scope="" data-testid={p.testId}>
                <h2 id="sp-title" className="sidepanel-title">{p.title}</h2>
                <div className="sidepanel-list" role="radiogroup" data-scroll="sidepanel">
                    {p.items.map((it) => (
                        <button key={it.id} type="button" role="radio" aria-checked={it.id === p.value}
                            className={`sp-item${it.id === p.value ? " is-checked" : ""}`} data-focusable="" data-focus-key={`sp:${it.id}`}
                            disabled={it.disabled} onClick={() => p.onSelect(it.id)}>
                            {it.icon && <Icon name={it.icon} className="sp-icon" />}
                            <span className="sp-text">
                                <span className="sp-label">{it.label}</span>
                                {it.sub && <span className="sp-sub">{it.sub}</span>}
                            </span>
                            {it.id === p.value && <Icon name="check" className="sp-check" />}
                        </button>
                    ))}
                </div>
                {p.footer}
            </div>
        </div>
    );
}
