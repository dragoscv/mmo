/** Setlist panel: load a JSON setlist, songs/parts, prev/next, current highlighted, lyrics teleprompter. */
import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, FolderOpen } from "lucide-react";
import { Button, cn } from "@mmo/ui";
import { useT } from "../i18n";
import { currentPart, parseSetlist } from "../lib/protocol";
import { useStore } from "../store";

export function SetlistPanel() {
    const t = useT();
    const state = useStore((s) => s.proto.state);
    const send = useStore((s) => s.send);
    const notify = useStore((s) => s.notify);
    const file = useRef<HTMLInputElement>(null);
    const lyricsRef = useRef<HTMLDivElement>(null);
    const reduced = useReducedMotion();
    const setlist = state?.setlist ?? null;
    const cur = currentPart(state);

    useEffect(() => {
        const el = lyricsRef.current?.querySelector<HTMLElement>("[data-current=true]");
        el?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    }, [cur?.pos.song, cur?.pos.part, reduced]);

    const onFile = async (f: File | undefined) => {
        if (!f) return;
        const sl = f.size < 2_000_000 ? parseSetlist(await f.text()) : null;
        if (!sl) {
            notify("error", "setlist.invalid");
            return;
        }
        send({ type: "load_setlist", setlist: sl });
        notify("success", "setlist.loaded", { name: sl.name });
    };

    const lyrics = cur?.song.lyrics?.split(/\r?\n/) ?? [];
    const partName = cur?.part.name.toLowerCase();

    return (
        <section aria-label={t("setlist.title")} className="surface flex min-h-0 flex-col gap-3 rounded-2xl p-3">
            <header className="flex items-center gap-2">
                <h2 className="font-heading text-sm font-semibold tracking-wide text-muted-foreground uppercase">{setlist?.name ?? t("setlist.title")}</h2>
                <Button variant="ghost" size="icon-sm" className="ms-auto" aria-label={t("setlist.load")} title={t("setlist.load")} onClick={() => file.current?.click()}>
                    <FolderOpen />
                </Button>
                <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            </header>
            {!setlist ? (
                <p className="text-sm text-muted-foreground">{t("setlist.empty")}</p>
            ) : (
                <>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="icon" aria-label={`${t("setlist.prev")} (←)`} onClick={() => send({ type: "prev" })}>
                            <ChevronLeft />
                        </Button>
                        <div className="min-w-0 flex-1 text-center" aria-live="polite">
                            <div className="truncate font-heading text-base font-semibold">{cur?.song.title ?? "–"}</div>
                            <div className="truncate text-xs text-muted-foreground">
                                {cur?.part.name}
                                {cur?.song.key || cur?.song.bpm ? ` · ${t("setlist.songMeta", { key: cur?.song.key ?? "–", bpm: cur?.song.bpm ?? "–" })}` : ""}
                            </div>
                        </div>
                        <Button variant="outline" size="icon" aria-label={`${t("setlist.next")} (→)`} onClick={() => send({ type: "next" })}>
                            <ChevronRight />
                        </Button>
                    </div>
                    <ol className="flex max-h-36 min-h-0 flex-col gap-0.5 overflow-y-auto text-sm">
                        {setlist.songs.map((song, si) => (
                            <li key={`${si}-${song.title}`}>
                                <div className="px-2 pt-1 text-xs font-semibold text-muted-foreground">
                                    {si + 1}. {song.title}
                                </div>
                                <div className="flex flex-wrap gap-1 px-2 pb-1">
                                    {song.parts.map((p, pi) => {
                                        const active = cur?.pos.song === si && cur.pos.part === pi;
                                        return (
                                            <button
                                                key={`${pi}-${p.name}`}
                                                type="button"
                                                aria-current={active ? "step" : undefined}
                                                onClick={() => send({ type: "goto", song: si, part: pi })}
                                                className={cn(
                                                    "relative rounded-md px-2 py-0.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
                                                    active ? "text-primary-foreground" : "bg-muted hover:bg-muted/70",
                                                )}
                                            >
                                                {active ? <motion.span layoutId="part-pill" className="absolute inset-0 rounded-md bg-primary" /> : null}
                                                <span className="relative">{p.name}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </li>
                        ))}
                    </ol>
                    <div className="flex min-h-0 flex-1 flex-col">
                        <h3 className="text-xs font-semibold text-muted-foreground">{t("setlist.lyrics")}</h3>
                        <div ref={lyricsRef} className="teleprompter min-h-0 flex-1 overflow-y-auto py-6 text-lg leading-relaxed">
                            {lyrics.length === 0 ? (
                                <p className="text-sm text-muted-foreground">{t("setlist.noLyrics")}</p>
                            ) : (
                                lyrics.map((line, i) => {
                                    const isHeader = /^\s*\[(.+)\]\s*$/.exec(line);
                                    const current = !!isHeader && isHeader[1]?.toLowerCase() === partName;
                                    return (
                                        <p
                                            key={i}
                                            data-current={current}
                                            className={cn(isHeader ? "mt-3 text-xs font-semibold tracking-wide uppercase" : "", current ? "text-primary" : isHeader ? "text-muted-foreground" : "")}
                                        >
                                            {isHeader ? isHeader[1] : line || " "}
                                        </p>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </>
            )}
        </section>
    );
}
