/**
 * Title-bar entry of the set tracklist (rendered by shell/TitleBar.tsx right after REC, only in
 * the native app): a list icon, "Tracklist" and the number of entries. It is on screen while a
 * recording runs or a recorded set is saved; the command palette item "Set tracklist" opens the
 * same popover when it is not (the button then shows for as long as the popover is open, so the
 * popover has something to hang from). Below 1180 px the word goes and the icon + number stay.
 *
 * Every part selects one small value of the store, which changes only when a row of the list
 * changes: the 30 Hz engine snapshots render nothing here.
 *
 * Arrow keys pressed in the open popover never reach the app's global shortcuts (bare arrows =
 * crossfader hard to A / B, centre): the popup consumes the ones nothing inside used.
 */
import { useRef } from "react";
import { ListMusic } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mmo/ui";
import { useLocale, useT } from "@/i18n";
import { consumeBareArrows } from "@/remote/remote-core";
import { tracksKey } from "./setlog-core.ts";
import { useSetlogStore } from "./setlog-store";
import { SetlogPopover } from "./SetlogPopover";

export function SetlogButton() {
    const t = useT();
    const locale = useLocale();
    const open = useSetlogStore((s) => s.open);
    const setOpen = useSetlogStore((s) => s.setOpen);
    const recording = useSetlogStore((s) => s.recording);
    const hasSet = useSetlogStore((s) => s.set !== null);
    const count = useSetlogStore((s) => s.set?.entries.length ?? 0);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const copyRef = useRef<HTMLButtonElement>(null);

    const tracks = t(tracksKey(count, locale), { n: count });
    const label = recording ? t("setlog.buttonAriaRec", { tracks }) : hasSet ? t("setlog.buttonAria", { tracks }) : t("setlog.buttonAriaNone");
    return (
        <Popover open={open} onOpenChange={(next) => setOpen(next)}>
            <PopoverTrigger ref={triggerRef} className="dk-btn tb-btn sl-btn" hidden={!(recording || hasSet || open)} data-setlog-trigger="" data-rec={recording || undefined} aria-label={label} title={label}>
                <ListMusic aria-hidden />
                <span className="sl-btn-text" aria-hidden>
                    {t("setlog.button")}
                </span>
                {hasSet && (
                    <span className="dk-num dk-num-sm sl-btn-count" aria-hidden>
                        {count}
                    </span>
                )}
            </PopoverTrigger>
            {/* Bare arrows are the app's crossfader shortcuts: none may leave the popover unused. */}
            <PopoverContent
                side="bottom"
                align="end"
                className="sl-pop"
                onKeyDown={(e) => {
                    consumeBareArrows(e);
                }}
                // Not the first control (a "remove" button): the keyboard starts on Copy.
                initialFocus={copyRef}
                // Back to the button; when it is about to hide (nothing saved), to REC next to it.
                finalFocus={() => {
                    const s = useSetlogStore.getState();
                    return s.recording || s.set !== null ? triggerRef.current : document.querySelector<HTMLElement>(".mixai-titlebar .tb-rec");
                }}
            >
                <PopoverTitle className="dk-label">{t("setlog.title")}</PopoverTitle>
                {open && <SetlogPopover copyRef={copyRef} />}
            </PopoverContent>
        </Popover>
    );
}
