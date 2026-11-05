"use client";

/**
 * `/media/live/sources` (WP16-41) — Live TV source settings: list (status, channel count, last refresh/error),
 * add/edit form per kind (M3U playlist + optional XMLTV; Xtream Codes host + username + password; HDHomeRun
 * IP/URL), test, refresh, delete (AlertDialog). Server validation messages (`{error}` 400) show inline under
 * the form. Below: channel management — search, hide/unhide, renumber (blur/Enter saves).
 * `?add=1` opens the add form directly (empty-state CTA of the other Live TV pages).
 */
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Eye, EyeOff, Pencil, Plus, RefreshCw, Search, TestTube2, Trash2, Tv } from "lucide-react";
import { toast } from "sonner";
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
    AlertDialogTitle, Badge, Button, EmptyState, ErrorState, Input, Label, Skeleton, Switch,
} from "@mmo/ui";
import type { LiveTvChannel, LiveTvSource } from "@/lib/mmo/media-types";
import { useMmo } from "../mmo-provider";
import { ChannelLogo, LiveHeader, errorText, useLiveFormat } from "./common";
import { fold } from "./live-logic";
import { SOURCE_KINDS, emptySourceForm, formFromSource, toSourceInput, validateSourceForm, type SourceFormState } from "./source-form";

const CHANNEL_PAGE = 150;
type FormState = SourceFormState;
const KINDS = SOURCE_KINDS;
const emptyForm = emptySourceForm;

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; sources: LiveTvSource[] };

export function SourcesScreen() {
    const t = useTranslations("mx.live.sources");
    const tc = useTranslations("mx.live.common");
    const { clients } = useMmo();
    const livetv = clients?.livetv ?? null;
    const fmt = useLiveFormat();
    const params = useSearchParams();
    const [load, setLoad] = useState<Load>({ state: "loading" });
    const [tick, setTick] = useState(0);
    const [form, setForm] = useState<FormState | null>(() => (params?.get("add") === "1" ? emptyForm() : null));
    const [busy, setBusy] = useState<Record<string, "test" | "refresh" | undefined>>({});
    const [confirmDel, setConfirmDel] = useState<LiveTvSource | null>(null);
    const [channelsKey, setChannelsKey] = useState(0);

    useEffect(() => {
        if (!livetv) return;
        let alive = true;
        void livetv.sources()
            .then((sources) => { if (alive) setLoad({ state: "ok", sources }); })
            .catch((e: unknown) => { if (alive) setLoad((cur) => (cur.state === "ok" ? cur : { state: "error", message: errorText(e) })); });
        return () => { alive = false; };
    }, [livetv, tick]);

    // A freshly added source refreshes in the background: poll until it has a lastRefresh.
    const pending = load.state === "ok" && load.sources.some((s) => s.enabled && !s.lastRefresh && !s.lastError);
    useEffect(() => {
        if (!pending) return;
        const id = setInterval(() => { setTick((x) => x + 1); setChannelsKey((x) => x + 1); }, 4000);
        return () => clearInterval(id);
    }, [pending]);

    const test = async (s: LiveTvSource) => {
        if (!livetv) return;
        setBusy((b) => ({ ...b, [s.id]: "test" }));
        try {
            const r = await livetv.testSource(s.id);
            if (r?.ok) toast.success(t("testOk", { count: r.channelCount }));
            else toast.error(t("testFailed", { msg: r?.error ?? "?" }));
        } catch (e) { toast.error(t("testFailed", { msg: errorText(e) })); }
        finally { setBusy((b) => ({ ...b, [s.id]: undefined })); }
    };
    const refresh = async (s: LiveTvSource) => {
        if (!livetv) return;
        setBusy((b) => ({ ...b, [s.id]: "refresh" }));
        try {
            await livetv.refreshSource(s.id);
            toast.success(t("refreshed", { name: s.name }));
            setTick((x) => x + 1);
            setChannelsKey((x) => x + 1);
        } catch (e) { toast.error(t("refreshFailed", { msg: errorText(e) })); }
        finally { setBusy((b) => ({ ...b, [s.id]: undefined })); }
    };
    const remove = async () => {
        if (!livetv || !confirmDel) return;
        try {
            await livetv.deleteSource(confirmDel.id);
            toast.success(t("deleted", { name: confirmDel.name }));
            setTick((x) => x + 1);
            setChannelsKey((x) => x + 1);
        } catch (e) { toast.error(t("deleteFailed", { msg: errorText(e) })); }
        finally { setConfirmDel(null); }
    };

    if (!livetv) return null;
    const header = <LiveHeader title={t("title")} actions={!form ? <Button onClick={() => setForm(emptyForm())}><Plus aria-hidden />{t("add")}</Button> : null} />;
    if (load.state === "loading") {
        return <div className="lv-page">{header}<div className="lv-rec-list" aria-busy="true" aria-label={tc("loading")}>{[0, 1].map((i) => <Skeleton key={i} className="lv-row-skel" />)}</div></div>;
    }
    if (load.state === "error") {
        return <div className="lv-page">{header}<ErrorState detail={load.message} onRetry={() => { setLoad({ state: "loading" }); setTick((x) => x + 1); }} /></div>;
    }

    return (
        <div className="lv-page">
            {header}
            {form ? (
                <SourceForm key={form.id ?? "new"} initial={form} onCancel={() => setForm(null)} onSaved={() => { setForm(null); setTick((x) => x + 1); setChannelsKey((x) => x + 1); }} />
            ) : null}

            {!load.sources.length && !form ? (
                <EmptyState icon={<Tv aria-hidden />} title={t("empty.title")} description={t("empty.body")}
                    actions={<Button onClick={() => setForm(emptyForm())}><Plus aria-hidden />{t("add")}</Button>} />
            ) : (
                <ul className="lv-rec-list" aria-label={t("listLabel")}>
                    {load.sources.map((s) => (
                        <li key={s.id} className="lv-rec">
                            <span className="lv-rec-icon" aria-hidden><Tv /></span>
                            <div className="lv-rec-text">
                                <p className="lv-rec-title">{s.name}</p>
                                <p className="lv-dim lv-break">{t(`kinds.${s.kind}`)} · {s.url}</p>
                                <div className="lv-rec-badges">
                                    <Badge variant={s.enabled ? "success" : "secondary"}>{s.enabled ? t("enabled") : t("disabled")}</Badge>
                                    <Badge variant="outline">{t("channelCount", { count: s.channelCount })}</Badge>
                                    {s.kind !== "hdhomerun" && !s.xmltvUrl ? <Badge variant="outline">{t("noXmltv")}</Badge> : null}
                                </div>
                                <p className="lv-dim">
                                    {s.lastRefresh ? t("lastRefresh", { time: fmt.dateTime(s.lastRefresh) }) : s.enabled ? t("refreshing") : t("never")}
                                    {s.guideRefreshedAt ? ` · ${t("guideRefresh", { time: fmt.dateTime(s.guideRefreshedAt) })}` : ""}
                                </p>
                                {s.lastError ? <p className="lv-rec-error" role="status">{t("lastError", { msg: s.lastError })}</p> : null}
                                {s.guideError ? <p className="lv-rec-error" role="status">{t("guideError", { msg: s.guideError })}</p> : null}
                            </div>
                            <div className="lv-rec-actions">
                                <Button size="sm" variant="outline" loading={busy[s.id] === "test"} onClick={() => void test(s)}><TestTube2 aria-hidden />{t("test")}</Button>
                                <Button size="sm" variant="outline" loading={busy[s.id] === "refresh"} onClick={() => void refresh(s)}><RefreshCw aria-hidden />{t("refresh")}</Button>
                                <Button size="sm" variant="outline" onClick={() => { setForm(formFromSource(s)); window.scrollTo({ top: 0 }); }}
                                    aria-label={`${t("edit")}: ${s.name}`}><Pencil aria-hidden />{t("edit")}</Button>
                                <Button size="sm" variant="destructive" onClick={() => setConfirmDel(s)} aria-label={`${t("delete")}: ${s.name}`}><Trash2 aria-hidden />{t("delete")}</Button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {load.sources.length ? <ChannelManager reloadKey={channelsKey} sources={load.sources} /> : null}

            <AlertDialog open={!!confirmDel} onOpenChange={(o) => { if (!o) setConfirmDel(null); }}>
                <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t("confirmDelete.title")}</AlertDialogTitle>
                        <AlertDialogDescription>{t("confirmDelete.body", { name: confirmDel?.name ?? "" })}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t("confirmDelete.keep")}</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => void remove()}>{t("delete")}</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

function SourceForm({ initial, onCancel, onSaved }: { initial: FormState; onCancel: () => void; onSaved: () => void }) {
    const t = useTranslations("mx.live.sources.form");
    const { clients } = useMmo();
    const livetv = clients?.livetv ?? null;
    const [f, setF] = useState<FormState>(initial);
    const [errs, setErrs] = useState<string[]>([]);
    const [serverError, setServerError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const id = useId();
    const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((cur) => ({ ...cur, [k]: v }));
    const err = (k: string) => (errs.includes(k) ? t(`errors.${k}`) : null);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!livetv) return;
        const v = validateSourceForm(f);
        setErrs(v);
        setServerError(null);
        if (v.length) {
            document.getElementById(`${id}-${v[0]}`)?.focus();
            return;
        }
        setSaving(true);
        try {
            const body = toSourceInput(f);
            if (f.id) await livetv.updateSource(f.id, body); else await livetv.createSource(body);
            toast.success(f.id ? t("updated", { name: f.name }) : t("created", { name: f.name }));
            onSaved();
        } catch (e2) {
            setServerError(errorText(e2));
        } finally {
            setSaving(false);
        }
    };

    const field = (k: keyof FormState & string, label: string, input: ReactNode, hint?: string) => (
        <div className="lv-field">
            <Label htmlFor={`${id}-${k}`}>{label}</Label>
            {input}
            {hint ? <p className="lv-hint" id={`${id}-${k}-hint`}>{hint}</p> : null}
            {err(k) ? <p className="lv-field-error" id={`${id}-${k}-err`}>{err(k)}</p> : null}
        </div>
    );
    const describedBy = (k: string, hint: boolean) => [hint ? `${id}-${k}-hint` : "", err(k) ? `${id}-${k}-err` : ""].filter(Boolean).join(" ") || undefined;

    return (
        <form className="lv-form" onSubmit={(e) => void submit(e)} noValidate aria-labelledby={`${id}-title`}>
            <h2 id={`${id}-title`} className="mx-row-title">{f.id ? t("editTitle") : t("addTitle")}</h2>
            {!f.id ? (
                <fieldset className="lv-field">
                    <legend className="lv-legend">{t("kind")}</legend>
                    <div className="lv-kinds" role="radiogroup" aria-label={t("kind")}>
                        {KINDS.map((k) => (
                            <button key={k} type="button" role="radio" aria-checked={f.kind === k} className="lv-kind" onClick={() => set("kind", k)}>
                                <span className="lv-kind-name">{t(`kinds.${k}.name`)}</span>
                                <span className="lv-dim">{t(`kinds.${k}.desc`)}</span>
                            </button>
                        ))}
                    </div>
                </fieldset>
            ) : <p className="lv-dim">{t(`kinds.${f.kind}.name`)}</p>}
            <div className="lv-form-grid">
                {field("name", t("name"), <Input id={`${id}-name`} value={f.name} onChange={(e) => set("name", e.target.value)} aria-invalid={!!err("name")} aria-describedby={describedBy("name", false)} autoComplete="off" />)}
                {field("url", t(`url.${f.kind}`),
                    <Input id={`${id}-url`} value={f.url} onChange={(e) => set("url", e.target.value)} aria-invalid={!!err("url")}
                        aria-describedby={describedBy("url", true)} inputMode="url" autoComplete="off" spellCheck={false} placeholder={t(`urlPlaceholder.${f.kind}`)} />,
                    t(`urlHint.${f.kind}`))}
                {f.kind === "xtream" ? (
                    <>
                        {field("username", t("username"), <Input id={`${id}-username`} value={f.username} onChange={(e) => set("username", e.target.value)} aria-invalid={!!err("username")} aria-describedby={describedBy("username", false)} autoComplete="off" spellCheck={false} />)}
                        {field("password", t("password"),
                            <Input id={`${id}-password`} type="password" value={f.password} onChange={(e) => set("password", e.target.value)} aria-invalid={!!err("password")}
                                aria-describedby={describedBy("password", f.hasPassword)} autoComplete="new-password" />,
                            f.hasPassword ? t("passwordKeep") : undefined)}
                    </>
                ) : null}
                {f.kind !== "hdhomerun" ? field("xmltvUrl", t("xmltv"),
                    <Input id={`${id}-xmltvUrl`} value={f.xmltvUrl} onChange={(e) => set("xmltvUrl", e.target.value)} aria-describedby={describedBy("xmltvUrl", true)} inputMode="url" autoComplete="off" spellCheck={false} />,
                    t(f.kind === "xtream" ? "xmltvHintXtream" : "xmltvHint")) : null}
                {field("refreshHours", t("refreshHours"),
                    <Input id={`${id}-refreshHours`} type="number" min={1} max={720} value={f.refreshHours} onChange={(e) => set("refreshHours", e.target.value)} aria-invalid={!!err("refreshHours")} aria-describedby={describedBy("refreshHours", false)} />)}
                {field("tunerLimit", t("tunerLimit"),
                    <Input id={`${id}-tunerLimit`} type="number" min={1} max={64} value={f.tunerLimit} onChange={(e) => set("tunerLimit", e.target.value)} aria-invalid={!!err("tunerLimit")} aria-describedby={describedBy("tunerLimit", true)} />,
                    t("tunerHint"))}
            </div>
            <label className="lv-switch">
                <Switch checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} />
                <span>{t("enabled")}</span>
            </label>
            {serverError ? <p className="lv-form-error" role="alert">{t("serverError", { msg: serverError })}</p> : null}
            <div className="lv-form-actions">
                <Button type="button" variant="outline" onClick={onCancel}>{t("cancel")}</Button>
                <Button type="submit" loading={saving}><CheckCircle2 aria-hidden />{f.id ? t("save") : t("create")}</Button>
            </div>
        </form>
    );
}

function ChannelManager({ reloadKey, sources }: { reloadKey: number; sources: LiveTvSource[] }) {
    const t = useTranslations("mx.live.sources.channels");
    const { clients } = useMmo();
    const livetv = clients?.livetv ?? null;
    const [channels, setChannels] = useState<LiveTvChannel[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [source, setSource] = useState("");
    const [onlyHidden, setOnlyHidden] = useState(false);
    const [limit, setLimit] = useState(CHANNEL_PAGE);
    const [rowError, setRowError] = useState<Record<string, string>>({});
    const id = useId();

    useEffect(() => {
        if (!livetv) return;
        let alive = true;
        void livetv.channels({ hidden: true })
            .then((c) => { if (alive) { setChannels(c); setError(null); } })
            .catch((e: unknown) => { if (alive) setError(errorText(e)); });
        return () => { alive = false; };
    }, [livetv, reloadKey]);

    const shown = useMemo(() => {
        const q = fold(query.trim());
        return (channels ?? []).filter((c) => (!source || c.sourceId === source) && (!onlyHidden || c.hidden)
            && (!q || fold(c.name).includes(q) || (c.number ?? "").startsWith(q) || fold(c.group ?? "").includes(q)));
    }, [channels, query, source, onlyHidden]);

    const patch = useCallback(async (ch: LiveTvChannel, p: { hidden?: boolean; number?: string | null }) => {
        if (!livetv) return;
        setChannels((cur) => cur?.map((c) => (c.id === ch.id ? { ...c, ...p } : c)) ?? cur);
        try {
            const r = await livetv.updateChannel(ch.id, p);
            if (r) setChannels((cur) => cur?.map((c) => (c.id === ch.id ? { ...c, hidden: r.hidden, number: r.number } : c)) ?? cur);
            setRowError((e) => { const o = { ...e }; delete o[ch.id]; return o; });
        } catch (e) {
            setChannels((cur) => cur?.map((c) => (c.id === ch.id ? ch : c)) ?? cur);
            setRowError((er) => ({ ...er, [ch.id]: errorText(e) }));
        }
    }, [livetv]);

    if (!livetv) return null;
    return (
        <section className="lv-chman" aria-labelledby={`${id}-h`}>
            <h2 id={`${id}-h`} className="mx-row-title">{t("title")}</h2>
            <p className="lv-dim">{t("body")}</p>
            <div className="lv-toolbar">
                <label className="lv-search">
                    <Search aria-hidden className="size-4" />
                    <span className="sr-only">{t("search")}</span>
                    <Input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(CHANNEL_PAGE); }} placeholder={t("search")} />
                </label>
                {sources.length > 1 ? (
                    <label className="lv-select">
                        <span className="sr-only">{t("source")}</span>
                        <select value={source} onChange={(e) => { setSource(e.target.value); setLimit(CHANNEL_PAGE); }}>
                            <option value="">{t("allSources")}</option>
                            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </label>
                ) : null}
                <label className="lv-switch">
                    <Switch checked={onlyHidden} onCheckedChange={setOnlyHidden} />
                    <span>{t("onlyHidden")}</span>
                </label>
                {channels ? <span className="lv-count" aria-live="polite">{t("count", { count: shown.length })}</span> : null}
            </div>
            {error ? <ErrorState variant="inline" detail={error} /> : !channels ? <Skeleton className="lv-row-skel" /> : shown.length === 0 ? (
                <p className="lv-dim">{t("none")}</p>
            ) : (
                <div className="lv-table-wrap">
                    <table className="lv-table">
                        <thead>
                            <tr>
                                <th scope="col">{t("number")}</th>
                                <th scope="col">{t("name")}</th>
                                <th scope="col" className="lv-col-group">{t("group")}</th>
                                <th scope="col">{t("visible")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.slice(0, limit).map((ch) => (
                                <tr key={ch.id} data-hidden={ch.hidden ? "" : undefined}>
                                    <td>
                                        <NumberInput key={ch.number ?? ""} channel={ch} label={t("numberFor", { name: ch.name })} onCommit={(v) => void patch(ch, { number: v })} />
                                    </td>
                                    <td>
                                        <span className="lv-table-name"><ChannelLogo channel={ch} livetv={livetv} size="sm" />{ch.name}</span>
                                        {rowError[ch.id] ? <span className="lv-field-error" role="alert">{rowError[ch.id]}</span> : null}
                                    </td>
                                    <td className="lv-col-group lv-dim">{ch.group ?? ""}</td>
                                    <td>
                                        <Button size="sm" variant="ghost" aria-pressed={!ch.hidden} onClick={() => void patch(ch, { hidden: !ch.hidden })}
                                            aria-label={ch.hidden ? t("unhide", { name: ch.name }) : t("hide", { name: ch.name })}>
                                            {ch.hidden ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                                            <span className="lv-hide-sm">{ch.hidden ? t("hidden") : t("shown")}</span>
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {shown.length > limit ? (
                        <Button variant="outline" onClick={() => setLimit((l) => l + CHANNEL_PAGE)}>{t("more", { count: shown.length - limit })}</Button>
                    ) : null}
                </div>
            )}
        </section>
    );
}

function NumberInput({ channel, label, onCommit }: { channel: LiveTvChannel; label: string; onCommit: (v: string | null) => void }) {
    const [v, setV] = useState(channel.number ?? "");
    const commit = () => {
        const next = v.trim();
        if (next === (channel.number ?? "")) return;
        onCommit(next ? next : null);
    };
    return (
        <Input size="sm" className="lv-num-input" value={v} maxLength={16} inputMode="numeric" aria-label={label}
            onChange={(e) => setV(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") setV(channel.number ?? ""); }} />
    );
}
