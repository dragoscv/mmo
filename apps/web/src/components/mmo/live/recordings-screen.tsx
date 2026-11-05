"use client";

/**
 * `/media/live/recordings` (WP16-41) — DVR: Recording now / Scheduled / Completed (+ failed/cancelled)
 * lists, cancel/delete behind an AlertDialog, completed recordings play in a dialog player, series rules
 * with delete. Recordings are `-c copy` files on the server: playback registers the path with
 * `GET /video/lookup?path=` and streams `/video/stream/:fileId` (HLS remux, never re-encoded).
 * Refreshes every 30 s while something is recording or about to start.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, CalendarClock, CircleDot, Disc3, ListVideo, Play, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
    AlertDialogTitle, Badge, Button, Dialog, DialogContent, DialogTitle, EmptyState, ErrorState, Skeleton,
} from "@mmo/ui";
import type { LiveTvRecording, LiveTvRule } from "@/lib/mmo/media-types";
import { useMmo } from "../mmo-provider";
import { LiveHeader, errorText, useLiveFormat, videoStreamUrl } from "./common";
import { attachStream, type StreamHandle } from "./stream";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; recordings: LiveTvRecording[]; rules: LiveTvRule[] };
type Confirm = { kind: "recording"; rec: LiveTvRecording } | { kind: "rule"; rule: LiveTvRule } | null;

const STATUS_VARIANT = { scheduled: "info", recording: "destructive", done: "success", failed: "warning", cancelled: "secondary" } as const;

export function RecordingsScreen() {
    const t = useTranslations("mx.live.recordings");
    const tc = useTranslations("mx.live.common");
    const { clients } = useMmo();
    const livetv = clients?.livetv ?? null;
    const fmt = useLiveFormat();
    const [load, setLoad] = useState<Load>({ state: "loading" });
    const [tick, setTick] = useState(0);
    const [confirm, setConfirm] = useState<Confirm>(null);
    const [playing, setPlaying] = useState<LiveTvRecording | null>(null);
    const [loadedAt, setLoadedAt] = useState(0);

    useEffect(() => {
        if (!livetv) return;
        let alive = true;
        void Promise.all([livetv.recordings(), livetv.rules()])
            .then(([recordings, rules]) => { if (alive) { setLoad({ state: "ok", recordings, rules }); setLoadedAt(Date.now()); } })
            .catch((e: unknown) => { if (alive) setLoad((cur) => (cur.state === "ok" ? cur : { state: "error", message: errorText(e) })); });
        return () => { alive = false; };
    }, [livetv, tick]);

    const groups = useMemo(() => {
        const recs = load.state === "ok" ? load.recordings : [];
        return {
            active: recs.filter((r) => r.status === "recording").sort((a, b) => a.start - b.start),
            scheduled: recs.filter((r) => r.status === "scheduled").sort((a, b) => a.start - b.start),
            done: recs.filter((r) => r.status === "done" || r.status === "failed" || r.status === "cancelled").sort((a, b) => b.start - a.start),
        };
    }, [load]);

    const live = groups.active.length > 0 || groups.scheduled.some((r) => r.start - loadedAt < 10 * 60_000);
    useEffect(() => {
        if (!live) return;
        const id = setInterval(() => setTick((x) => x + 1), 30_000);
        return () => clearInterval(id);
    }, [live]);

    const doConfirm = async () => {
        if (!livetv || !confirm) return;
        try {
            if (confirm.kind === "recording") {
                const r = await livetv.deleteRecording(confirm.rec.id);
                toast.success(r?.deleted ? t("deleted", { title: confirm.rec.title }) : t("cancelled", { title: confirm.rec.title }));
            } else {
                await livetv.deleteRule(confirm.rule.id);
                toast.success(t("ruleDeleted", { title: confirm.rule.titleMatch }));
            }
            setTick((x) => x + 1);
        } catch (e) {
            toast.error(t("actionFailed", { msg: errorText(e) }));
        } finally {
            setConfirm(null);
        }
    };

    if (!livetv) return null;
    const header = <LiveHeader title={t("title")} />;
    if (load.state === "loading") {
        return (
            <div className="lv-page">{header}
                <div className="lv-rec-list" aria-busy="true" aria-label={tc("loading")}>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="lv-row-skel" />)}</div>
            </div>
        );
    }
    if (load.state === "error") {
        return <div className="lv-page">{header}<ErrorState detail={load.message} onRetry={() => { setLoad({ state: "loading" }); setTick((x) => x + 1); }} /></div>;
    }
    const nothing = !groups.active.length && !groups.scheduled.length && !groups.done.length;

    const renderRec = (r: LiveTvRecording) => {
        const canPlay = r.status === "done" && !!r.path;
        const destructiveLabel = r.status === "scheduled" || r.status === "recording" ? t("cancel") : t("delete");
        return (
            <li key={r.id} className="lv-rec">
                <span className="lv-rec-icon" aria-hidden>
                    {r.status === "recording" ? <CircleDot className="lv-rec-dot" /> : r.status === "failed" ? <AlertTriangle /> : r.status === "scheduled" ? <CalendarClock /> : <Disc3 />}
                </span>
                <div className="lv-rec-text">
                    <p className="lv-rec-title">{r.title}</p>
                    <p className="lv-dim">
                        {r.channelName ? `${r.channelName} · ` : ""}{fmt.day(r.start)} · {fmt.range(r.start, r.stop)}
                    </p>
                    <div className="lv-rec-badges">
                        <Badge variant={STATUS_VARIANT[r.status]}>{t(`status.${r.status}`)}</Badge>
                        {r.conflict ? <Badge variant="warning">{t("conflict")}</Badge> : null}
                        {r.ruleId ? <Badge variant="outline">{t("fromRule")}</Badge> : null}
                    </div>
                    {r.error ? <p className="lv-rec-error">{r.error}</p> : null}
                </div>
                <div className="lv-rec-actions">
                    {canPlay ? <Button size="sm" onClick={() => setPlaying(r)} aria-label={t("playTitle", { title: r.title })}><Play aria-hidden />{t("play")}</Button> : null}
                    <Button size="sm" variant="destructive" onClick={() => setConfirm({ kind: "recording", rec: r })} aria-label={`${destructiveLabel}: ${r.title}`}>
                        {r.status === "scheduled" || r.status === "recording" ? <X aria-hidden /> : <Trash2 aria-hidden />}{destructiveLabel}
                    </Button>
                </div>
            </li>
        );
    };

    return (
        <div className="lv-page">
            {header}
            {nothing && !load.rules.length ? (
                <EmptyState icon={<Disc3 aria-hidden />} title={t("empty.title")} description={t("empty.body")}
                    actions={<Button render={<Link href="/media/live/guide" />}><CalendarClock aria-hidden />{t("empty.cta")}</Button>} />
            ) : (
                <div className="lv-rec-sections">
                    {groups.active.length ? (
                        <section aria-labelledby="lv-rec-active">
                            <h2 id="lv-rec-active" className="mx-row-title">{t("sections.active", { count: groups.active.length })}</h2>
                            <ul className="lv-rec-list">{groups.active.map(renderRec)}</ul>
                        </section>
                    ) : null}
                    <section aria-labelledby="lv-rec-scheduled">
                        <h2 id="lv-rec-scheduled" className="mx-row-title">{t("sections.scheduled", { count: groups.scheduled.length })}</h2>
                        {groups.scheduled.length ? <ul className="lv-rec-list">{groups.scheduled.map(renderRec)}</ul> : <p className="lv-dim">{t("noneScheduled")}</p>}
                    </section>
                    <section aria-labelledby="lv-rec-done">
                        <h2 id="lv-rec-done" className="mx-row-title">{t("sections.done", { count: groups.done.length })}</h2>
                        {groups.done.length ? <ul className="lv-rec-list">{groups.done.map(renderRec)}</ul> : <p className="lv-dim">{t("noneDone")}</p>}
                    </section>
                    <section aria-labelledby="lv-rec-rules">
                        <h2 id="lv-rec-rules" className="mx-row-title">{t("sections.rules", { count: load.rules.length })}</h2>
                        {load.rules.length ? (
                            <ul className="lv-rec-list">
                                {load.rules.map((rule) => (
                                    <li key={rule.id} className="lv-rec">
                                        <span className="lv-rec-icon" aria-hidden><ListVideo /></span>
                                        <div className="lv-rec-text">
                                            <p className="lv-rec-title">{rule.titleMatch}</p>
                                            <p className="lv-dim">
                                                {rule.channelId ? t("ruleChannel") : t("ruleAnyChannel")}
                                                {" · "}{rule.keepLast > 0 ? t("keepLast", { count: rule.keepLast }) : t("keepAll")}
                                            </p>
                                            {!rule.enabled ? <Badge variant="secondary">{t("ruleDisabled")}</Badge> : null}
                                        </div>
                                        <div className="lv-rec-actions">
                                            <Button size="sm" variant="destructive" onClick={() => setConfirm({ kind: "rule", rule })} aria-label={`${t("delete")}: ${rule.titleMatch}`}>
                                                <Trash2 aria-hidden />{t("delete")}
                                            </Button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        ) : <p className="lv-dim">{t("noRules")}</p>}
                    </section>
                </div>
            )}

            <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
                <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {confirm?.kind === "rule" ? t("confirm.ruleTitle")
                                : confirm?.rec.status === "scheduled" || confirm?.rec.status === "recording" ? t("confirm.cancelTitle") : t("confirm.deleteTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirm?.kind === "rule" ? t("confirm.ruleBody", { title: confirm.rule.titleMatch })
                                : confirm?.rec.status === "scheduled" || confirm?.rec.status === "recording" ? t("confirm.cancelBody", { title: confirm.rec.title })
                                    : t("confirm.deleteBody", { title: confirm?.rec.title ?? "" })}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t("confirm.keep")}</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => void doConfirm()}>{t("confirm.confirm")}</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <RecordingPlayer rec={playing} onClose={() => setPlaying(null)} />
        </div>
    );
}

function RecordingPlayer({ rec, onClose }: { rec: LiveTvRecording | null; onClose: () => void }) {
    const t = useTranslations("mx.live.recordings");
    const { clients } = useMmo();
    const fmt = useLiveFormat();
    const [error, setError] = useState<string | null>(null);
    const handle = useRef<StreamHandle | null>(null);

    const videoRef = useCallback((v: HTMLVideoElement | null) => {
        handle.current?.destroy();
        handle.current = null;
        if (!v || !rec?.path || !clients) return;
        const cfg = clients.cfg;
        setError(null);
        void (async () => {
            try {
                const headers: Record<string, string> = { "x-device-token": cfg.token };
                if (cfg.userId) headers["x-user-id"] = cfg.userId;
                const res = await fetch(`${cfg.baseUrl}/video/lookup?path=${encodeURIComponent(rec.path ?? "")}`, { headers });
                const body = (await res.json().catch(() => null)) as { fileId?: string; error?: string } | null;
                if (!res.ok || !body?.fileId) {
                    if (res.status === 403 || res.status === 404) {
                        // Recordings folder outside the library (default): play the file as recorded
                        // (server 3.8 `GET /livetv/recordings/{id}/file`, Range-capable). MKV plays in
                        // Chromium/Firefox; MPEG-TS needs the HLS path above.
                        const q = new URLSearchParams({ t: cfg.token });
                        if (cfg.userId) q.set("u", cfg.userId);
                        v.src = `${cfg.baseUrl}/livetv/recordings/${encodeURIComponent(rec.id)}/file?${q.toString()}`;
                        v.onerror = () => setError(t("notInLibrary"));
                        v.play().catch(() => undefined);
                        return;
                    }
                    setError(body?.error ?? `${res.status}`);
                    return;
                }
                const h = await attachStream(v, videoStreamUrl(cfg, body.fileId), {
                    vod: true, onFatal: (m) => setError(m === "unsupported" ? t("unsupported") : m),
                });
                if (!v.isConnected) { h.destroy(); return; }
                handle.current = h;
                v.play().catch(() => undefined);
            } catch (e) {
                setError(errorText(e));
            }
        })();
    }, [rec, clients, t]);

    useEffect(() => () => { handle.current?.destroy(); handle.current = null; }, []);

    return (
        <Dialog open={!!rec} onOpenChange={(o) => { if (!o) { handle.current?.destroy(); handle.current = null; onClose(); } }}>
            <DialogContent size="xl" mobile="center" className="lv-rec-player">
                <DialogTitle>{rec?.title ?? ""}</DialogTitle>
                {rec ? <p className="lv-dim">{rec.channelName ? `${rec.channelName} · ` : ""}{fmt.dateTime(rec.start)}</p> : null}
                <div className="lv-rec-video dark">
                    {/* Captions are not part of DVR recordings (stream copy of the broadcast). */}
                    <video ref={videoRef} controls playsInline aria-label={t("playerLabel", { title: rec?.title ?? "" })} />
                    {error ? <div className="lv-rec-video-error" role="alert"><AlertTriangle aria-hidden className="size-6" /><span>{error}</span></div> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}
