/**
 * What the tracklist buttons do, without React (tested by actions.test.ts): copy the tracklist
 * text, and "upload to Mixcloud" = copy, then open the Mixcloud upload page in the browser.
 * The clipboard and the opener are injected; the defaults are the real ones.
 */
import { MIXCLOUD_UPLOAD_URL, openExternal, type OpenResult } from "../bridge/external.ts";
import { tracklistText } from "./export.ts";
import type { Entry } from "./set-logger.ts";

/** `copied` = on the clipboard; `empty` = no entries, nothing written; `failed` = the clipboard refused. */
export type CopyResult = "copied" | "empty" | "failed";

export interface ClipboardLike {
    writeText: (text: string) => Promise<void>;
}

export interface ActionDeps {
    clipboard?: ClipboardLike | null;
    open?: (url: string) => Promise<OpenResult>;
}

function systemClipboard(): ClipboardLike | null {
    return typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard : null;
}

/** Put the tracklist text on the clipboard. Never throws. */
export async function copyTracklist(entries: readonly Entry[], deps: ActionDeps = {}): Promise<CopyResult> {
    if (entries.length === 0) return "empty";
    const clipboard = deps.clipboard === undefined ? systemClipboard() : deps.clipboard;
    if (!clipboard) return "failed";
    try {
        await clipboard.writeText(tracklistText(entries));
        return "copied";
    } catch {
        return "failed";
    }
}

export interface UploadResult {
    copy: CopyResult;
    open: OpenResult;
}

/**
 * Copy the tracklist, THEN open the Mixcloud upload page (the browser takes the focus, and the
 * clipboard only accepts text from the focused window). The page is opened whatever the copy
 * did: the DJ can still upload the WAV and come back for the tracklist.
 */
export async function uploadToMixcloud(entries: readonly Entry[], deps: ActionDeps = {}): Promise<UploadResult> {
    const copy = await copyTracklist(entries, deps);
    const open = await (deps.open ?? openExternal)(MIXCLOUD_UPLOAD_URL);
    return { copy, open };
}

export type CopyKey = "setlog.copied" | "setlog.copyEmpty" | "setlog.copyFailed";
export type OpenKey = "setlog.open.ok" | "setlog.open.failed";
export type ClipKey = "setlog.clip.ok" | "setlog.clip.empty" | "setlog.clip.failed";

/** The sentence that says what Copy did. */
export function copyKey(r: CopyResult): CopyKey {
    return r === "copied" ? "setlog.copied" : r === "empty" ? "setlog.copyEmpty" : "setlog.copyFailed";
}

/** The two sentences that say what Upload did: the browser, then the clipboard. */
export function uploadKeys(r: UploadResult): [OpenKey, ClipKey] {
    return [r.open === "opened" ? "setlog.open.ok" : "setlog.open.failed", r.copy === "copied" ? "setlog.clip.ok" : r.copy === "empty" ? "setlog.clip.empty" : "setlog.clip.failed"];
}
