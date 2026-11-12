/**
 * Body of the set tracklist popover (mounted only while it is open): when the set was recorded,
 * how long it is and which WAV file it is; the entries (number, start, artist – title, deck,
 * remove); Copy tracklist, Open Mixcloud upload, Clear (two-step, inline).
 *
 * Focus rules: no focusable control is switched off with the native `disabled` (the browser then
 * drops focus to <body>); a button that cannot act says why in the status line. After a row is
 * removed the focus goes to the row that took its place (else the last row, else Copy). The
 * question of Clear puts the focus on "Keep"; "Keep" hands it back to Clear, "Yes" to Copy.
 *
 * What happened is always said in words in ONE polite live region (`role="status"`), which is
 * also visible text: copied or not, what Upload did with the browser and the clipboard, which
 * track was removed. A sentence goes away after a while, EXCEPT the one about Upload: the browser
 * takes the DJ away from this window, so that sentence stays until something else is said.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Copy, ExternalLink, X } from "lucide-react";
import { useLocale, useT } from "@/i18n";
import { isBareArrow } from "@/remote/remote-core";
import { copyKey, copyTracklist, uploadKeys, uploadToMixcloud } from "./actions.ts";
import { label, stamp } from "./export.ts";
import type { Entry } from "./set-logger.ts";
import { focusAfterRemove, tracksKey } from "./setlog-core.ts";
import { useSetlogStore } from "./setlog-store";

const NO_ENTRIES: readonly Entry[] = [];
/** How long a sentence stays in the status line. */
const STATUS_MS = 12_000;

type FocusTarget = { row: number } | "copy" | "clear" | "keep";

/** The wall clock, ticking once a second while `active` (the length of a running recording). */
function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [active]);
    return now;
}

export function SetlogPopover({ copyRef }: { copyRef: RefObject<HTMLButtonElement | null> }) {
    const t = useT();
    const locale = useLocale();
    const set = useSetlogStore((s) => s.set);
    const recording = useSetlogStore((s) => s.recording);
    const entries = set?.entries ?? NO_ENTRIES;
    const now = useNow(recording);
    const [status, setStatus] = useState("");
    const [confirm, setConfirm] = useState(false);
    const listRef = useRef<HTMLOListElement>(null);
    const clearRef = useRef<HTMLButtonElement>(null);
    const keepRef = useRef<HTMLButtonElement>(null);
    const focusNext = useRef<FocusTarget | null>(null);
    const uploading = useRef(false);
    const timers = useRef<number[]>([]);
    const hintId = useId();
    const askId = useId();

    useEffect(
        () => () => {
            for (const id of timers.current) window.clearTimeout(id);
        },
        [],
    );

    /**
     * Say `text` in the status line. Emptied first, so the same sentence twice is announced twice.
     * `hold` keeps it on screen until the next sentence (or until the popover closes).
     */
    const say = (text: string, hold = false) => {
        for (const id of timers.current) window.clearTimeout(id);
        setStatus("");
        timers.current = [window.setTimeout(() => setStatus(text), 40)];
        if (!hold) timers.current.push(window.setTimeout(() => setStatus(""), STATUS_MS));
    };

    // Focus that follows a change of the list or of the Clear question (see the header).
    useLayoutEffect(() => {
        const target = focusNext.current;
        if (target === null) return;
        focusNext.current = null;
        if (target === "copy") copyRef.current?.focus();
        else if (target === "clear") clearRef.current?.focus();
        else if (target === "keep") keepRef.current?.focus();
        else {
            const next = focusAfterRemove(target.row, entries.length);
            const el = next === null ? copyRef.current : listRef.current?.querySelectorAll<HTMLElement>("[data-sl-remove]")[next];
            (el ?? copyRef.current)?.focus();
        }
    }, [entries, confirm, copyRef]);

    const tracks = t(tracksKey(entries.length, locale), { n: entries.length });
    const lengthSec = set ? (recording ? Math.max(0, (now - set.startedAt) / 1000) : set.lengthSec) : 0;
    const when = set ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(set.startedAt) : "";

    const onRemove = (index: number) => {
        const e = entries[index];
        if (!e) return;
        focusNext.current = { row: index };
        useSetlogStore.getState().remove(index);
        say(t("setlog.removed", { track: label(e) }));
    };

    const onCopy = async () => {
        const r = await copyTracklist(entries);
        say(t(copyKey(r), { tracks }));
    };

    const onUpload = async () => {
        if (uploading.current) return;
        uploading.current = true;
        try {
            const [opened, clip] = uploadKeys(await uploadToMixcloud(entries));
            // Read after coming back from the browser: it must still be there.
            say(`${t(opened)} ${t(clip)}`, true);
        } finally {
            uploading.current = false;
        }
    };

    const askClear = () => {
        if (recording) return say(t("setlog.clearBusy"));
        if (!set) return say(t("setlog.clearNothing"));
        focusNext.current = "keep";
        setConfirm(true);
    };
    const keep = () => {
        focusNext.current = "clear";
        setConfirm(false);
    };
    const doClear = () => {
        // A recording that started while the question was showing: its tracklist is not cleared.
        if (useSetlogStore.getState().recording) {
            focusNext.current = "clear";
            setConfirm(false);
            return say(t("setlog.clearBusy"));
        }
        focusNext.current = "copy";
        setConfirm(false);
        useSetlogStore.getState().clear();
        say(t("setlog.cleared"));
    };

    /** Up / down move between the remove buttons of the rows (and never reach the crossfader). */
    const onListKey = (e: KeyboardEvent<HTMLOListElement>) => {
        if (!isBareArrow(e) || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-sl-remove]")];
        const at = buttons.indexOf(e.target as HTMLElement);
        if (at < 0) return;
        e.preventDefault();
        buttons[Math.min(buttons.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    };

    return (
        <div className="sl-body" data-rec={recording || undefined}>
            {set ? (
                <>
                    <dl className="sl-meta">
                        <div>
                            <dt className="dk-label">{t("setlog.recorded")}</dt>
                            <dd>{when}</dd>
                        </div>
                        <div>
                            <dt className="dk-label">{t("setlog.length")}</dt>
                            <dd className="dk-num">{stamp(lengthSec)}</dd>
                        </div>
                        <div className="sl-meta-file">
                            <dt className="dk-label">{t("setlog.file")}</dt>
                            <dd className="sl-clip" title={set.file ?? undefined}>
                                {set.file ?? t("setlog.fileUnknown")}
                            </dd>
                        </div>
                    </dl>
                    {recording && (
                        <p className="sl-rec">
                            <i className="sl-rec-dot" aria-hidden />
                            {t("setlog.recordingNow")}
                        </p>
                    )}
                    {entries.length > 0 ? (
                        <ol
                            ref={listRef}
                            role="list"
                            className="sl-list"
                            data-long={(entries[entries.length - 1]?.startSec ?? 0) >= 3600 || undefined}
                            data-many={entries.length >= 100 || undefined}
                            aria-label={t("setlog.listAria")}
                            onKeyDown={onListKey}
                        >
                            {entries.map((e, i) => {
                                const name = label(e);
                                return (
                                    <li key={`${e.track.id}@${e.startSec}`} className="sl-row">
                                        <span className="dk-num dk-num-sm sl-n">{String(i + 1).padStart(2, "0")}</span>
                                        <span className="dk-num dk-num-sm sl-t">{stamp(e.startSec)}</span>
                                        <span className="sl-name sl-clip" title={name}>
                                            {name}
                                        </span>
                                        <span className="sl-deck" data-deck={e.deck}>
                                            <span aria-hidden>{e.deck.toUpperCase()}</span>
                                            <span className="sr-only">{t("setlog.deck", { deck: e.deck.toUpperCase() })}</span>
                                        </span>
                                        <button type="button" className="dk-btn dk-btn-icon sl-rm" data-sl-remove="" aria-label={t("setlog.remove", { track: name })} title={t("setlog.remove", { track: name })} onClick={() => onRemove(i)}>
                                            <X size={12} aria-hidden />
                                        </button>
                                    </li>
                                );
                            })}
                        </ol>
                    ) : (
                        <p className="sl-note">{t(recording ? "setlog.empty" : "setlog.emptyDone")}</p>
                    )}
                </>
            ) : (
                <p className="sl-note">{t("setlog.none")}</p>
            )}

            {confirm ? (
                <div className="sl-actions" role="group" aria-labelledby={askId}>
                    <span id={askId} className="sl-ask">
                        {t("setlog.clearAsk")}
                    </span>
                    <button type="button" className="dk-btn sl-yes" data-sl-yes="" onClick={doClear}>
                        {t("setlog.clearYes")}
                    </button>
                    <button ref={keepRef} type="button" className="dk-btn" data-sl-keep="" onClick={keep}>
                        {t("setlog.clearNo")}
                    </button>
                </div>
            ) : (
                <div className="sl-actions">
                    <button ref={copyRef} type="button" className="dk-btn" data-sl-copy="" aria-disabled={entries.length === 0 || undefined} onClick={() => void onCopy()}>
                        <Copy size={12} aria-hidden />
                        {t("setlog.copy")}
                    </button>
                    <button type="button" className="dk-btn" data-sl-upload="" aria-describedby={hintId} onClick={() => void onUpload()}>
                        <ExternalLink size={12} aria-hidden />
                        {t("setlog.upload")}
                    </button>
                    <button ref={clearRef} type="button" className="dk-btn sl-push" data-sl-clear="" aria-disabled={recording || !set || undefined} onClick={askClear}>
                        {t("setlog.clear")}
                    </button>
                </div>
            )}
            {/* Below the buttons: a sentence that appears does not push a button down. */}
            <p className="sl-status" role="status" aria-live="polite" aria-atomic="true" data-sl-status="">
                {status}
            </p>
            <p id={hintId} className="sl-note sl-hint">
                {t("setlog.uploadHint")}
            </p>
        </div>
    );
}
