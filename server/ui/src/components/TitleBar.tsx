/**
 * Draggable titlebar for macOS only. The BrowserWindow uses
 * `titleBarStyle: "hiddenInset"`, which on macOS removes the native bar but
 * keeps the traffic lights — so we need a drag region and left padding for
 * them. On Windows/Linux Electron ignores hiddenInset and draws the native
 * frame; rendering this there produced the old double-frame bug.
 */
export function TitleBar() {
    return (
        <div
            className="app-region-drag flex h-8 shrink-0 select-none items-center justify-center border-b bg-background/80 pl-[72px] text-[11px] text-muted-foreground"
            aria-hidden
        >
            MixAI Companion
        </div>
    );
}
