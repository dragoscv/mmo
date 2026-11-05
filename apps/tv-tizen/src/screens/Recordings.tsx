/**
 * Recordings / DVR (WP16-34): Scheduled (scheduled + recording, conflicts flagged) · Recorded (done + failed)
 * · Rules (series). Cancel / delete through a Dialog. A finished recording plays through `/video/lookup?path=`
 * (registers the file) → the regular player route.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../i18n/messages";
import { ServerHttp } from "../lib/http";
import type { LiveTvRecording, LiveTvRule } from "../lib/media-types";
import type { ScreenProps } from "../nav/ctx";
import { Chips, Dialog, Empty, ErrorState, Icon, LoadingBlock, ScreenHeader, useBackdrop } from "../ui";
import { dayLabel, hhmm } from "./livetv/common";
import { useScreenActive } from "../nav/Nav";
import "./livetv/livetv.css";

type Tab = "scheduled" | "recorded" | "rules";

export function Recordings({ ctx }: ScreenProps<"recordings">) {
    const { livetv, nav, lang } = ctx;
    const active = useScreenActive();
    const backdrop = useBackdrop();
    const [tab, setTab] = useState<Tab>("scheduled");
    const [recs, setRecs] = useState<LiveTvRecording[] | null>(null);
    const [rules, setRules] = useState<LiveTvRule[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<{ kind: "rec"; r: LiveTvRecording } | { kind: "rule"; r: LiveTvRule } | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    const http = useMemo(() => new ServerHttp(ctx.cfg), [ctx.cfg]);

    useEffect(() => { if (active) backdrop.show(null); }, [active, backdrop]);

    const load = useCallback(() => {
        setError(null);
        Promise.all([livetv.recordings(), livetv.rules()]).then(([r, ru]) => { setRecs(r); setRules(ru); }).catch((e: Error) => setError(e.message));
    }, [livetv]);
    useEffect(load, [load]);
    // Refresh while something is recording (status/size changes).
    useEffect(() => {
        if (!active || !recs?.some((r) => r.status === "recording")) return;
        const h = setInterval(load, 30_000);
        return () => clearInterval(h);
    }, [active, recs, load]);

    const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };

    const play = async (r: LiveTvRecording) => {
        if (!r.path) { flash(t("lt.rec.noFile")); return; }
        try {
            const res = await http.get<{ fileId: string }>(`/video/lookup?path=${encodeURIComponent(r.path)}`);
            if (!res?.fileId) throw new Error(t("lt.rec.noFile"));
            const video = await ctx.client.resolveVideo(res.fileId, r.path);
            nav.push({ name: "player", item: { kind: "video", video } });
        } catch (e) {
            flash((e as Error).message);
        }
    };

    const doConfirm = async () => {
        const c = confirm;
        setConfirm(null);
        if (!c) return;
        try {
            if (c.kind === "rec") await livetv.deleteRecording(c.r.id);
            else await livetv.deleteRule(c.r.id);
            load();
        } catch (e) { flash((e as Error).message); }
    };

    const scheduled = (recs ?? []).filter((r) => r.status === "scheduled" || r.status === "recording").sort((a, b) => a.start - b.start);
    const recorded = (recs ?? []).filter((r) => r.status === "done" || r.status === "failed").sort((a, b) => b.start - a.start);
    const statusLabel = (r: LiveTvRecording) => t(`lt.rec.status.${r.status}` as const);
    const when = (r: LiveTvRecording) => `${dayLabel(r.start, lang)} ${hhmm(r.start, lang)}–${hhmm(r.stop, lang)}`;

    let body;
    if (error) body = <ErrorState message={error} onRetry={load} />;
    else if (!recs) body = <LoadingBlock lines={5} />;
    else if (tab === "scheduled") {
        body = scheduled.length === 0 ? <Empty icon="record" title={t("lt.rec.noneScheduled")} message={t("lt.rec.noneScheduledMsg")} action={{ label: t("screen.guide"), icon: "guide", onClick: () => nav.push({ name: "guide" }) }} /> : (
            <div className="rc-list">
                {scheduled.map((r) => (
                    <button key={r.id} type="button" className="rc-item" data-focusable="" data-focus-key={`rc:${r.id}`} onClick={() => setConfirm({ kind: "rec", r })}>
                        <Icon name="record" className={r.status === "recording" ? "lt-live-dot" : undefined} />
                        <span className="rc-main">
                            <span className="rc-title">{r.title}</span>
                            <span className="rc-sub">{[r.channelName, when(r), statusLabel(r), r.ruleId ? t("lt.rec.fromRule") : null].filter(Boolean).join(" · ")}</span>
                        </span>
                        {r.conflict && <span className="badge badge-warning">{t("lt.rec.conflict")}</span>}
                        <span className="badge badge-neutral">{t("lt.rec.cancel")}</span>
                    </button>
                ))}
            </div>
        );
    } else if (tab === "recorded") {
        body = recorded.length === 0 ? <Empty icon="record" title={t("lt.rec.noneRecorded")} /> : (
            <div className="rc-list">
                {recorded.map((r) => (
                    <div key={r.id} style={{ display: "flex", gap: "0.6rem" }} data-focus-row={`rc-row-${r.id}`}>
                        <button type="button" className="rc-item" data-focusable="" data-focus-key={`rc:${r.id}`} onClick={() => { void play(r); }} disabled={r.status !== "done"}>
                            <Icon name={r.status === "done" ? "play" : "alert"} />
                            <span className="rc-main">
                                <span className="rc-title">{r.title}</span>
                                <span className="rc-sub">{[r.channelName, when(r), statusLabel(r), r.error].filter(Boolean).join(" · ")}</span>
                            </span>
                        </button>
                        <button type="button" className="rc-item" style={{ width: "auto" }} data-focusable="" data-focus-key={`rc-del:${r.id}`} onClick={() => setConfirm({ kind: "rec", r })} aria-label={t("lt.rec.delete")}>
                            <Icon name="close" />
                        </button>
                    </div>
                ))}
            </div>
        );
    } else {
        body = rules.length === 0 ? <Empty icon="repeat" title={t("lt.rec.noRules")} message={t("lt.rec.noRulesMsg")} /> : (
            <div className="rc-list">
                {rules.map((r) => (
                    <button key={r.id} type="button" className="rc-item" data-focusable="" data-focus-key={`rule:${r.id}`} onClick={() => setConfirm({ kind: "rule", r })}>
                        <Icon name="repeat" />
                        <span className="rc-main">
                            <span className="rc-title">{r.titleMatch}</span>
                            <span className="rc-sub">{[r.enabled ? t("lt.rec.ruleOn") : t("lt.rec.ruleOff"), r.keepLast > 0 ? t("lt.rec.keepLast", { n: r.keepLast }) : null].filter(Boolean).join(" · ")}</span>
                        </span>
                        <span className="badge badge-neutral">{t("lt.rec.delete")}</span>
                    </button>
                ))}
            </div>
        );
    }

    const c = confirm;
    const isCancel = c?.kind === "rec" && (c.r.status === "scheduled" || c.r.status === "recording");
    const recTitle = c?.kind === "rec" ? c.r.title : "";
    return (
        <div className="tv-screen" data-scroll="screen" data-testid="screen-recordings">
            <ScreenHeader title={t("screen.recordings")} />
            <Chips rowId="rc-tabs" value={tab} onChange={(id) => setTab(id as Tab)} className="mu-tabs"
                items={[
                    { id: "scheduled", label: t("lt.rec.scheduled", { n: scheduled.length }) },
                    { id: "recorded", label: t("lt.rec.recorded", { n: recorded.length }) },
                    { id: "rules", label: t("lt.rec.rules", { n: rules.length }) },
                ]} />
            {body}
            {toast && <div className="lp-toast" role="status">{toast}</div>}
            <Dialog open={!!c} destructive icon="alert"
                title={c?.kind === "rule" ? t("lt.rec.deleteRuleTitle", { title: c.r.titleMatch }) : isCancel ? t("lt.rec.cancelTitle", { title: recTitle }) : t("lt.rec.deleteTitle", { title: recTitle })}
                message={c?.kind === "rule" ? t("lt.rec.deleteRuleMsg") : isCancel ? t("lt.rec.cancelMsg") : t("lt.rec.deleteMsg")}
                confirmLabel={isCancel ? t("lt.rec.cancel") : t("lt.rec.delete")}
                onConfirm={() => { void doConfirm(); }} onCancel={() => setConfirm(null)} />
        </div>
    );
}
