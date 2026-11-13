/**
 * The "Stream" tab of the Connect popover (WP19-59): the address of the "Now playing" page a
 * streamer adds to OBS as a Browser source, Copy, a new code, the note when the usual port was
 * taken (the address then holds for this run only: the next start asks for the usual port
 * again), and what the page shows right now.
 *
 * Mounted only while its tab is selected (RemotePopover), so nothing here renders while the
 * popover is closed or shows another tab. Every control is a button that stays where it is (no
 * native `disabled`, nothing removes itself), and the line that says what an action did is always
 * there with its height reserved: no button moves when it speaks. It does not clear itself after
 * a while: right after Copy the DJ goes to OBS and reads it when they come back.
 */
import { useEffect, useRef, useState } from "react";
import { useT, type MessageKey } from "@/i18n";
import { soft } from "@/components/deck-tabs/soft-disabled";
import { copyKey, onAirLine } from "./overlay-core";
import { useRemoteStore } from "./remote-store";

interface Note {
    key: MessageKey;
    ok: boolean;
}

function Address({ where, url, onCopy }: { where: string; url: string; onCopy: (url: string) => void }) {
    const t = useT();
    return (
        <li className="rm-ov-addr">
            <span className="dk-label">{where}</span>
            {/* The whole address is in the DOM (select + copy gives all of it); the view cuts its end. */}
            <span className="dk-num dk-num-sm rm-url rm-ov-url" title={url}>
                {url}
            </span>
            <button type="button" className="dk-btn dk-btn-xs" aria-label={t("remote.overlay.copyAria", { where })} onClick={() => onCopy(url)}>
                {t("remote.overlay.copy")}
            </button>
        </li>
    );
}

export function StreamPanel() {
    const t = useT();
    const here = useRemoteStore((s) => s.urlOverlay);
    const lan = useRemoteStore((s) => s.urlOverlayLan);
    const fallback = useRemoteStore((s) => s.portFallback);
    const port = useRemoteStore((s) => s.port);
    const onAir = useRemoteStore((s) => s.onAir);
    const copyOverlay = useRemoteStore((s) => s.copyOverlay);
    const rotateOverlay = useRemoteStore((s) => s.rotateOverlay);
    const [note, setNote] = useState<Note | null>(null);
    const [busy, setBusy] = useState(false);
    // An answer that arrives after the tab was left must not touch the state.
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const copy = (url: string) => {
        void copyOverlay(url).then((r) => {
            if (alive.current) setNote({ key: copyKey(r), ok: r === "copied" });
        });
    };
    const rotate = () => {
        setBusy(true);
        void rotateOverlay().then((changed) => {
            if (!alive.current) return;
            setBusy(false);
            setNote(changed ? { key: "remote.overlay.rotated", ok: true } : { key: "remote.overlay.rotateFailed", ok: false });
        });
    };
    const song = onAirLine(onAir);

    return (
        <section className="rm-panel" role="tabpanel" id="rm-panel-stream" aria-labelledby="rm-tab-stream">
            <p className="rm-hint">{t("remote.overlay.intro")}</p>
            {fallback && <p className="rm-hint rm-warn">{t("remote.overlay.fallback", { port: port ?? "" })}</p>}
            <ul className="rm-ov-list">
                {here && <Address where={t("remote.overlay.here")} url={here} onCopy={copy} />}
                {lan && <Address where={t("remote.overlay.lan")} url={lan} onCopy={copy} />}
            </ul>
            <div className="rm-row rm-ov-code">
                {/* Never natively disabled: it is the focused button while its own action runs. */}
                <button type="button" className="dk-btn dk-btn-xs" title={t("remote.overlay.newCodeTip")} {...soft(busy, rotate)}>
                    {t("remote.overlay.newCode")}
                </button>
                {/* On a fallback port the address is NOT the one of the next start: do not promise it. */}
                <span className="rm-hint">{t(fallback ? "remote.overlay.keepFallback" : "remote.overlay.keep")}</span>
            </div>
            <p className="rm-ov-note" role="status" data-ok={note ? note.ok : undefined}>
                {note ? t(note.key) : ""}
            </p>
            <p className="rm-hint rm-ov-onair" title={song ?? undefined}>
                {song ? t("remote.overlay.onAir", { song }) : t("remote.overlay.onAirNone")}
            </p>
        </section>
    );
}
