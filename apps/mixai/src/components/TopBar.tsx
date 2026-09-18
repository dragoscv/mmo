import { useEffect, useState } from "react";
import { Circle, Command, Keyboard, Settings } from "lucide-react";
import { Button, ToggleGroup, ToggleGroupItem, Tooltip, TooltipContent, TooltipTrigger, KbdCombo } from "@mmo/ui";
import { useMixerStore } from "@/state/mixer-store";
import { useUiStore } from "@/state/ui-store";
import { useRecordingStore } from "@/state/recording-store";
import { useT } from "@/i18n";

export function TopBar({ deckCount, canFourDeck }: { deckCount: 2 | 4; canFourDeck: boolean }) {
    const t = useT();
    const native = useMixerStore((s) => s.native);
    const latencyMs = useMixerStore((s) => s.latencyMs);
    const sampleRate = useMixerStore((s) => s.sampleRate);
    const setDeckCount = useUiStore((s) => s.setDeckCount);
    const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
    const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);
    const setCommandOpen = useUiStore((s) => s.setCommandOpen);

    return (
        <header className="panel flex items-center gap-3.5 px-3.5 py-2">
            <strong className="text-gradient-brand font-heading text-lg tracking-[0.18em]">{t("app.name")}</strong>

            <span
                className={"rounded-full px-2 py-0.5 text-[10px] font-bold " + (native ? "bg-success" : "bg-warning")}
                // Dark ink in both modes: success/warning chips are light hues.
                style={{ color: "oklch(0.14 0.02 285)" }}
            >
                {native ? t("app.audioCore") : t("app.uiPreview")}
            </span>

            {native && (
                <span className="mono text-[11px] text-muted-foreground">
                    {(sampleRate / 1000).toFixed(1)} kHz · {latencyMs.toFixed(1)} ms
                </span>
            )}

            <div className="flex-1" />

            {native && <RecordButton />}

            <ToggleGroup
                value={[String(deckCount)]}
                onValueChange={(v) => {
                    const next = v[0];
                    if (next) setDeckCount(next === "4" ? 4 : 2);
                }}
                variant="outline"
                size="sm"
                aria-label={t("topbar.deckCount")}
                title={canFourDeck ? undefined : t("topbar.deck4Unavailable")}
            >
                <ToggleGroupItem value="2" className="text-[11px] font-bold">
                    {t("topbar.deck2")}
                </ToggleGroupItem>
                <ToggleGroupItem value="4" disabled={!canFourDeck} className="text-[11px] font-bold">
                    {t("topbar.deck4")}
                </ToggleGroupItem>
            </ToggleGroup>

            <Tooltip>
                <TooltipTrigger
                    render={
                        <Button variant="outline" size="sm" onClick={() => setCommandOpen(true)}>
                            <Command aria-hidden />
                            {t("topbar.commands")}
                        </Button>
                    }
                />
                <TooltipContent>
                    <KbdCombo combo="mod+k" />
                </TooltipContent>
            </Tooltip>

            <Tooltip>
                <TooltipTrigger
                    render={
                        <Button variant="outline" size="sm" onClick={() => setShortcutsOpen(true)}>
                            <Keyboard aria-hidden />
                            {t("topbar.keys")}
                        </Button>
                    }
                />
                <TooltipContent>{t("topbar.keysHint")}</TooltipContent>
            </Tooltip>

            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                <Settings aria-hidden />
                {t("topbar.settings")}
            </Button>
        </header>
    );
}

function RecordButton() {
    const t = useT();
    const recording = useRecordingStore((s) => s.recording);
    const busy = useRecordingStore((s) => s.busy);
    const startedAt = useRecordingStore((s) => s.startedAt);
    const toggle = useRecordingStore((s) => s.toggle);
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        if (!recording) {
            setElapsed(0);
            return;
        }
        const id = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
        return () => clearInterval(id);
    }, [recording, startedAt]);

    const mm = Math.floor(elapsed / 60)
        .toString()
        .padStart(2, "0");
    const ss = Math.floor(elapsed % 60)
        .toString()
        .padStart(2, "0");

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <Button
                        variant={recording ? "destructive" : "outline"}
                        size="sm"
                        onClick={() => void toggle()}
                        disabled={busy}
                        aria-pressed={recording}
                        className={recording ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "text-muted-foreground"}
                    >
                        <Circle
                            aria-hidden
                            className={"size-2.5 fill-current " + (recording ? "text-destructive-foreground" : "text-destructive")}
                            style={{ animation: recording ? "mixai-rec-pulse 1s ease-in-out infinite" : undefined }}
                        />
                        {recording ? <span className="mono">{`${mm}:${ss}`}</span> : <span>{t("topbar.rec")}</span>}
                    </Button>
                }
            />
            <TooltipContent>{recording ? t("topbar.recStop") : t("topbar.recStart")}</TooltipContent>
        </Tooltip>
    );
}
