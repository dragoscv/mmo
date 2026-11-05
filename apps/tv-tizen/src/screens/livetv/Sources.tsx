/**
 * Live TV sources (WP16-34): list with status (channels, last refresh, errors), add form (kind M3U / Xtream /
 * HDHomeRun, name, URL, XMLTV URL, user, password masked) with the on-screen Keyboard, test, refresh, delete.
 * Rendered by LiveTv as a sub-view; Back closes the form, then the sub-view.
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/messages";
import type { LiveTvSource, LiveTvSourceInput, LiveTvSourceKind } from "../../lib/media-types";
import { useBackHandler } from "../../nav/back";
import type { ScreenCtx } from "../../nav/ctx";
import { Chips, Dialog, Empty, ErrorState, Keyboard, LoadingBlock, PrimaryButton, ScreenHeader, SecondaryButton } from "../../ui";
import { focusByKey } from "../../lib/focus";
import "./livetv.css";

type Field = "name" | "url" | "xmltvUrl" | "username" | "password";

interface Draft { kind: LiveTvSourceKind; name: string; url: string; xmltvUrl: string; username: string; password: string }
const EMPTY_DRAFT: Draft = { kind: "m3u", name: "", url: "", xmltvUrl: "", username: "", password: "" };

function fieldsFor(kind: LiveTvSourceKind): Field[] {
    if (kind === "xtream") return ["name", "url", "username", "password", "xmltvUrl"];
    if (kind === "hdhomerun") return ["name", "url"];
    return ["name", "url", "xmltvUrl"];
}

function label(f: Field, kind: LiveTvSourceKind): string {
    switch (f) {
        case "name": return t("lt.src.name");
        case "url": return kind === "hdhomerun" ? t("lt.src.hdhrUrl") : kind === "xtream" ? t("lt.src.xtreamUrl") : t("lt.src.m3uUrl");
        case "xmltvUrl": return t("lt.src.xmltv");
        case "username": return t("lt.src.user");
        case "password": return t("lt.src.password");
    }
}

function when(ms: number | null | undefined, lang: string): string {
    if (!ms) return t("lt.src.never");
    try { return new Date(ms).toLocaleString(lang === "ro" ? "ro-RO" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
    catch { return new Date(ms).toISOString(); }
}

export function Sources({ ctx, onClose }: { ctx: ScreenCtx; onClose: () => void }) {
    const { livetv, lang } = ctx;
    const [list, setList] = useState<LiveTvSource[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [form, setForm] = useState(false);
    const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
    const [editing, setEditing] = useState<Field | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
    const [formError, setFormError] = useState<string | null>(null);
    const [confirmDel, setConfirmDel] = useState<LiveTvSource | null>(null);

    const load = useCallback(() => {
        setError(null);
        livetv.sources().then(setList).catch((e: Error) => setError(e.message));
    }, [livetv]);
    useEffect(load, [load]);

    // Poll while a source has never refreshed (initial lineup runs in the background on the server).
    useEffect(() => {
        if (!list?.some((s) => s.enabled && !s.lastRefresh && !s.lastError)) return;
        const h = setTimeout(load, 3000);
        return () => clearTimeout(h);
    }, [list, load]);

    useBackHandler(() => {
        if (editing) { const f = editing; setEditing(null); requestAnimationFrame(() => focusByKey(`src-f:${f}`)); return; }
        if (form) { setForm(false); return; }
        onClose();
    }, true);

    const run = async (id: string, what: "test" | "refresh") => {
        setBusy(`${what}:${id}`);
        try {
            if (what === "test") {
                const r = await livetv.testSource(id);
                setMsg((m) => ({ ...m, [id]: r?.ok ? { ok: true, text: t("lt.src.testOk", { n: r.channelCount }) } : { ok: false, text: r?.error ?? t("lt.src.testFail") } }));
            } else {
                await livetv.refreshSource(id);
                setMsg((m) => ({ ...m, [id]: { ok: true, text: t("lt.src.refreshed") } }));
                load();
            }
        } catch (e) {
            setMsg((m) => ({ ...m, [id]: { ok: false, text: (e as Error).message } }));
        } finally { setBusy(null); }
    };

    const save = async () => {
        setFormError(null);
        if (!draft.url.trim()) { setFormError(t("lt.src.urlRequired")); return; }
        const input: LiveTvSourceInput = {
            kind: draft.kind,
            name: draft.name.trim() || (draft.kind === "hdhomerun" ? "HDHomeRun" : draft.kind === "xtream" ? "Xtream" : "M3U"),
            url: draft.url.trim(),
            xmltvUrl: draft.xmltvUrl.trim() || null,
            username: draft.kind === "xtream" ? draft.username.trim() || null : null,
            password: draft.kind === "xtream" ? draft.password || null : null,
        };
        setBusy("save");
        try {
            await livetv.createSource(input);
            setForm(false);
            setDraft(EMPTY_DRAFT);
            load();
        } catch (e) {
            setFormError((e as Error).message);
        } finally { setBusy(null); }
    };

    const del = async (s: LiveTvSource) => {
        setConfirmDel(null);
        setBusy(`del:${s.id}`);
        try { await livetv.deleteSource(s.id); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
    };

    if (form) {
        const fields = fieldsFor(draft.kind);
        return (
            <div className="tv-screen" data-scroll="screen" data-testid="lt-source-form">
                <ScreenHeader title={t("lt.src.addTitle")} sub={t("lt.src.addSub")} />
                <div className="lt-form">
                    <div className="lt-form-fields">
                        <Chips rowId="src-kind" value={draft.kind}
                            items={[{ id: "m3u", label: "M3U" }, { id: "xtream", label: "Xtream Codes" }, { id: "hdhomerun", label: "HDHomeRun" }]}
                            onChange={(id) => setDraft((d) => ({ ...d, kind: id as LiveTvSourceKind }))} />
                        {fields.map((f) => {
                            const v = draft[f];
                            const shown = f === "password" ? "•".repeat(v.length) : v;
                            return (
                                <button key={f} type="button" className={`lt-field${editing === f ? " is-editing" : ""}`} data-focusable="" data-focus-key={`src-f:${f}`}
                                    onClick={() => { setEditing(f); requestAnimationFrame(() => focusByKey("src-kb:a")); }}>
                                    <span className="lt-field-label">{label(f, draft.kind)}</span>
                                    <span className="lt-field-value">{shown || <span className="ph">{f === "xmltvUrl" ? t("lt.src.optional") : "—"}</span>}</span>
                                </button>
                            );
                        })}
                        {formError && <div className="lt-src-err">{formError}</div>}
                        <div className="lt-form-actions" data-focus-row="src-actions">
                            <PrimaryButton icon="check" label={t("lt.src.save")} onClick={() => { void save(); }} focusKey="src:save" disabled={busy === "save"} testId="src-save" />
                            <SecondaryButton label={t("common.cancel")} onClick={() => setForm(false)} focusKey="src:cancel" />
                        </div>
                        <div className="lt-note">{t("lt.src.privacy")}</div>
                    </div>
                    {editing && (
                        <div>
                            <div className="lt-field-label" style={{ marginBottom: "0.5rem" }}>{label(editing, draft.kind)}</div>
                            <Keyboard id="src-kb" value={draft[editing]} maxLength={editing === "url" || editing === "xmltvUrl" ? 400 : 80}
                                onChange={(v) => setDraft((d) => ({ ...d, [editing]: v }))}
                                onDone={() => { const f = editing; setEditing(null); requestAnimationFrame(() => focusByKey(`src-f:${f}`)); }} />
                            <div className="lt-note" style={{ marginTop: "0.6rem" }}>{t("lt.src.kbHint")}</div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="tv-screen" data-scroll="screen" data-testid="lt-sources-view">
            <ScreenHeader title={t("lt.sources")} sub={t("lt.src.sub")}
                right={<PrimaryButton icon="plus" label={t("lt.addSource")} onClick={() => { setDraft(EMPTY_DRAFT); setFormError(null); setForm(true); }} focusKey="src:add" testId="src-add" />} />
            {error && <ErrorState message={error} onRetry={load} />}
            {!error && list === null && <LoadingBlock lines={4} />}
            {list && list.length === 0 && <Empty icon="server" title={t("lt.emptyTitle")} message={t("lt.emptyMsg")} />}
            {list && list.length > 0 && (
                <div className="lt-sources">
                    {list.map((s) => {
                        const m = msg[s.id];
                        const pending = s.enabled && !s.lastRefresh && !s.lastError;
                        return (
                            <div key={s.id} className="lt-src" data-testid={`src-${s.id}`}>
                                <div className="lt-src-main">
                                    <div className="lt-src-name">{s.name} <span className="badge badge-neutral">{s.kind.toUpperCase()}</span></div>
                                    <div className="lt-src-sub">{s.url}</div>
                                    <div className="lt-src-sub">
                                        {pending ? t("lt.refreshing") : t("lt.src.status", { n: s.channelCount, when: when(s.lastRefresh, lang) })}
                                        {s.xmltvUrl ? ` · ${t("lt.src.guideAt", { when: when(s.guideRefreshedAt, lang) })}` : ` · ${t("lt.src.noXmltv")}`}
                                    </div>
                                    {s.lastError && <div className="lt-src-err">{s.lastError}</div>}
                                    {s.guideError && <div className="lt-src-err">{s.guideError}</div>}
                                    {m && <div className={m.ok ? "lt-src-ok" : "lt-src-err"}>{m.text}</div>}
                                </div>
                                <div className="lt-src-actions" data-focus-row={`src-row-${s.id}`}>
                                    <SecondaryButton icon="check" label={t("lt.src.test")} onClick={() => { void run(s.id, "test"); }} focusKey={`src:test:${s.id}`} disabled={!!busy} />
                                    <SecondaryButton icon="refresh" label={t("lt.src.refresh")} onClick={() => { void run(s.id, "refresh"); }} focusKey={`src:refresh:${s.id}`} disabled={!!busy} />
                                    <SecondaryButton icon="close" label={t("lt.src.delete")} onClick={() => setConfirmDel(s)} focusKey={`src:del:${s.id}`} disabled={!!busy} />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
            <Dialog open={!!confirmDel} title={t("lt.src.deleteTitle", { name: confirmDel?.name ?? "" })} message={t("lt.src.deleteMsg")} destructive icon="alert"
                confirmLabel={t("lt.src.delete")} onConfirm={() => { if (confirmDel) void del(confirmDel); }} onCancel={() => setConfirmDel(null)} />
        </div>
    );
}
