/**
 * Live skin editor: a floating panel over the running app that edits a skin's tokens and
 * `style` block with instant preview, saves the result as an installed skin and exports it as
 * a `.mixaipack`.
 *
 * - `useSkinEditor` : state + preview / save / export (./skin-editor/store.ts; also driven by the dev hooks).
 * - `SkinEditorEntry`: the button Settings → Appearance shows.
 * - `SkinEditorHost` : the editor itself, mounted once by App.tsx.
 *
 * The panel is non-modal (the app under it stays usable: that is the preview), draggable by its
 * header or with the arrow keys on the move handle, and closes with Esc while focus is inside.
 * No group scrolls: the long colour list is split in three sets.
 */
import { Component, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ErrorInfo, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Check, Download, Move, Palette, RotateCcw, Save, TriangleAlert, X } from "lucide-react";
import { Button } from "@mmo/ui";
import type { PackTokens } from "@/bridge/packs";
import { useT, type MessageKey, type Translate } from "@/i18n";
import { useLayoutStore } from "@/layout/layout-store";
import { layoutName } from "@/layout/presets";
import { readLookNumber, useLookVersion } from "@/look/look";
import { STYLE_SIZES, type StyleColorKey, type StyleSizeKey } from "@/look/style-vars";
import { isSafeColor } from "@/packs/apply-tokens";
import { BUILTIN_SKINS } from "@/packs/builtin-skins";
import { skinName } from "@/packs/skin-text";
import { usePackStore } from "@/packs/pack-store";
import { useUiStore } from "@/state/ui-store";
import { fromPicker, normalizeColorText, parseColor, toHex } from "./skin-editor/color";
import { effectiveColor } from "./skin-editor/effective";
import {
    ACCENTS,
    COLOR_SECTIONS,
    CUE_COLORS,
    DECK_IDS,
    GROUPS,
    NAME_MAX,
    SHAPE_SIZES,
    WAVE_COLORS,
    WAVE_SIZES,
    clampSize,
    deckColorProp,
    draftProblems,
    fieldProp,
    setBase,
    setDeckColor,
    setStyleColor,
    setStyleOption,
    setStyleSize,
    setThemeColor,
    sizeStep,
    skinId,
    styleColorProp,
    themeColorProp,
    type FieldRef,
    type GroupId,
} from "./skin-editor/model";
import { useSkinEditor, type EditorNote } from "./skin-editor/store";

export { useSkinEditor };

const PANEL_W = 320;
/** Contrast problems listed in the panel before "and N more". */
const ISSUES_SHOWN = 3;

function styleLabel(t: Translate, key: StyleColorKey): string {
    const cue = /^cue(\d)$/.exec(key);
    return cue ? t("skins.ed.cueN", { n: cue[1]! }) : t(`skins.s.${key}` as MessageKey);
}

function fieldLabel(t: Translate, f: FieldRef): string {
    return f.kind === "theme" ? t(`skins.c.${f.key}` as MessageKey) : styleLabel(t, f.key);
}

/** Button in Settings → Appearance: closes Settings (the app is the preview) and opens the editor. */
export function SkinEditorEntry() {
    const t = useT();
    return (
        <Button
            variant="outline"
            size="sm"
            onClick={() => {
                useUiStore.getState().setSettingsOpen(false);
                useSkinEditor.getState().setOpen(true);
            }}
        >
            <Palette aria-hidden /> {t("skins.ed.entry")}
        </Button>
    );
}

/**
 * The editor floats over the whole app, outside the panel boundaries: a crash in it closes the
 * editor (which undoes the preview) and leaves the app running. Opening it again starts clean.
 */
class EditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error("[mixai] skin editor crashed", error, info.componentStack);
        try {
            // Back to the first tab: a crash in one tab must not repeat at every reopen.
            useSkinEditor.setState({ group: "base" });
            useSkinEditor.getState().setOpen(false);
        } catch (e) {
            // Undoing the preview failed too: still close, and never take the app down with us.
            console.error("[mixai] skin editor close failed", e);
            useSkinEditor.setState({ open: false });
        }
    }

    render() {
        return this.state.failed ? null : this.props.children;
    }
}

export function SkinEditorHost() {
    const open = useSkinEditor((s) => s.open);
    return open ? (
        <EditorBoundary>
            <SkinEditorPanel />
        </EditorBoundary>
    ) : null;
}

// ── fields ──────────────────────────────────────────────────────────────────────────────────

function UnsetButton({ name, disabled, onClick }: { name: string; disabled: boolean; onClick: () => void }) {
    const t = useT();
    const label = t("skins.ed.unset", { name });
    return (
        <button type="button" className="ske-x" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
            <X aria-hidden />
        </button>
    );
}

/** One colour: native picker + text field (#rrggbb or oklch()) + "back to automatic". */
function ColorField({ label, prop, value, onChange }: { label: string; prop: string; value: string | undefined; onChange: (v: string | null) => void }) {
    const t = useT();
    const id = useId();
    const [text, setText] = useState(value ?? "");
    const [bad, setBad] = useState(false);
    // Follow a value that changed outside this field (picker, reset, "start from").
    useEffect(() => {
        setText((cur) => (cur.trim() === (value ?? "") ? cur : (value ?? "")));
        setBad(false);
    }, [value]);

    const shown = value ?? effectiveColor(prop);
    const hex = toHex(shown ?? "");
    const typed = (raw: string) => {
        setText(raw);
        const v = raw.trim();
        if (!v) {
            setBad(false);
            if (value !== undefined) onChange(null);
        } else if (parseColor(v) && isSafeColor(v)) {
            setBad(false);
            onChange(v);
        } else setBad(true);
    };
    // A typed hex with a visible tint is stored as oklch(): see ./skin-editor/color.ts.
    const blurred = () => {
        const v = text.trim();
        if (!v.startsWith("#")) return;
        const o = normalizeColorText(v);
        if (o && o !== v) {
            setText(o);
            onChange(o);
        }
    };
    return (
        <div className="ske-row" data-set={value !== undefined}>
            <label htmlFor={id} className="ske-name" title={label}>
                {label}
            </label>
            <input
                type="color"
                className="ske-swatch"
                aria-label={t("skins.ed.pick", { name: label })}
                title={hex}
                value={hex}
                onChange={(e) => {
                    const o = fromPicker(e.target.value, value);
                    if (o) onChange(o);
                }}
            />
            <input
                id={id}
                type="text"
                className="ske-text"
                spellCheck={false}
                autoComplete="off"
                value={text}
                placeholder={shown ? `${hex} · ${t("skins.ed.auto")}` : t("skins.ed.auto")}
                aria-invalid={bad || undefined}
                aria-describedby={bad ? `${id}-err` : undefined}
                onChange={(e) => typed(e.target.value)}
                onBlur={blurred}
            />
            <UnsetButton name={label} disabled={value === undefined} onClick={() => onChange(null)} />
            {bad ? (
                <p id={`${id}-err`} role="alert" className="ske-err">
                    <TriangleAlert aria-hidden /> {t("skins.ed.badColor")}
                </p>
            ) : null}
        </div>
    );
}

/** One bounded number: a slider over the range the validator accepts. */
function SizeField({ k, value, onChange }: { k: StyleSizeKey; value: number | undefined; onChange: (v: number | null) => void }) {
    const t = useT();
    const id = useId();
    const spec = STYLE_SIZES[k];
    const label = t(`skins.z.${k}` as MessageKey);
    const shown = value ?? clampSize(k, readLookNumber(spec.prop, spec.min));
    const text = t("skins.ed.sizeValue", { value: shown, unit: spec.unit ? ` ${spec.unit}` : "" });
    return (
        <div className="ske-row ske-row-size" data-set={value !== undefined}>
            <label htmlFor={id} className="ske-name" title={label}>
                {label}
            </label>
            <input id={id} type="range" className="ske-range" min={spec.min} max={spec.max} step={sizeStep(k)} value={shown} aria-valuetext={text} onChange={(e) => onChange(Number(e.target.value))} />
            <output htmlFor={id} className="ske-val dk-num dk-num-sm">
                {text}
            </output>
            <UnsetButton name={label} disabled={value === undefined} onClick={() => onChange(null)} />
        </div>
    );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
    return (
        <div className="ske-row ske-row-wide" role="group" aria-label={label}>
            <span className="ske-name" aria-hidden="true" title={label}>
                {label}
            </span>
            <div className="ske-seg">
                {options.map((o) => (
                    <button key={o.value} type="button" className="dk-btn dk-btn-xs" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
                        {o.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void }) {
    const id = useId();
    return (
        <div className="ske-row ske-row-wide">
            <label htmlFor={id} className="ske-name" title={label}>
                {label}
            </label>
            <select id={id} className="ske-select" value={value} onChange={(e) => onChange(e.target.value)}>
                {options.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        </div>
    );
}

// ── groups ──────────────────────────────────────────────────────────────────────────────────

type Edit = (fn: (t: PackTokens) => PackTokens) => void;

function StyleColors({ keys, draft, edit }: { keys: readonly StyleColorKey[]; draft: PackTokens; edit: Edit }) {
    const t = useT();
    return keys.map((k) => <ColorField key={k} label={styleLabel(t, k)} prop={styleColorProp(k)} value={draft.style?.colors?.[k]} onChange={(v) => edit((d) => setStyleColor(d, k, v))} />);
}

function ThemeColors({ keys, draft, edit }: { keys: readonly string[]; draft: PackTokens; edit: Edit }) {
    const t = useT();
    return keys.map((k) => <ColorField key={k} label={t(`skins.c.${k}` as MessageKey)} prop={themeColorProp(k)} value={draft.colors?.[k]} onChange={(v) => edit((d) => setThemeColor(d, k, v))} />);
}

function Sizes({ keys, draft, edit }: { keys: readonly StyleSizeKey[]; draft: PackTokens; edit: Edit }) {
    return keys.map((k) => <SizeField key={k} k={k} value={draft.style?.sizes?.[k]} onChange={(v) => edit((d) => setStyleSize(d, k, v))} />);
}

const SECTION_LABEL = { surfaces: "skins.ed.secSurfaces", text: "skins.ed.secText", states: "skins.ed.secStates" } as const;

function GroupBody({ group, draft, edit }: { group: GroupId; draft: PackTokens; edit: Edit }): ReactNode {
    const t = useT();
    const [section, setSection] = useState<(typeof COLOR_SECTIONS)[number]["id"]>("surfaces");
    // Not `s.all()` in the selector: it builds a new array on every call, which never settles.
    const userLayouts = useLayoutStore((s) => s.user);
    const layouts = useMemo(() => useLayoutStore.getState().all(), [userLayouts]);
    switch (group) {
        case "base":
            return (
                <>
                    <Segmented
                        label={t("skins.ed.mode")}
                        value={draft.mode ?? "mine"}
                        options={[
                            { value: "mine", label: t("skins.ed.modeMine") },
                            { value: "dark", label: t("skins.ed.modeDark") },
                            { value: "light", label: t("skins.ed.modeLight") },
                        ]}
                        onChange={(v) => edit((d) => setBase(d, { mode: v === "mine" ? undefined : v }))}
                    />
                    <SelectRow
                        label={t("skins.ed.accent")}
                        value={draft.accent ?? ""}
                        options={[{ value: "", label: t("skins.ed.accentMine") }, ...ACCENTS.map((a) => ({ value: a, label: t(`skins.ed.accent.${a}` as MessageKey) }))]}
                        onChange={(v) => edit((d) => setBase(d, { accent: v || undefined }))}
                    />
                    <p className="ske-hint">{t("skins.ed.accentHint")}</p>
                    <Segmented
                        label={t("skins.ed.look")}
                        value={draft.style?.look ?? "signature"}
                        options={[
                            { value: "signature", label: t("skins.ed.lookSignature") },
                            { value: "classic", label: t("skins.ed.lookClassic") },
                        ]}
                        onChange={(v) => edit((d) => setStyleOption(d, { look: v === "classic" ? "classic" : undefined }))}
                    />
                </>
            );
        case "colors": {
            const sec = COLOR_SECTIONS.find((s) => s.id === section) ?? COLOR_SECTIONS[0]!;
            return (
                <>
                    <div className="ske-seg ske-sections" role="group" aria-label={t("skins.ed.sections")}>
                        {COLOR_SECTIONS.map((s) => (
                            <button key={s.id} type="button" className="dk-btn dk-btn-xs" aria-pressed={s.id === sec.id} onClick={() => setSection(s.id)}>
                                {t(SECTION_LABEL[s.id])}
                            </button>
                        ))}
                    </div>
                    <ThemeColors keys={sec.theme} draft={draft} edit={edit} />
                    <StyleColors keys={sec.style} draft={draft} edit={edit} />
                </>
            );
        }
        case "decks":
            return DECK_IDS.map((d) => (
                <ColorField key={d} label={t("skins.ed.deck", { deck: d.toUpperCase() })} prop={deckColorProp(d)} value={draft.decks?.[d]} onChange={(v) => edit((x) => setDeckColor(x, d, v))} />
            ));
        case "wave":
            return (
                <>
                    <StyleColors keys={WAVE_COLORS} draft={draft} edit={edit} />
                    <Sizes keys={WAVE_SIZES} draft={draft} edit={edit} />
                </>
            );
        case "cues":
            return <StyleColors keys={CUE_COLORS} draft={draft} edit={edit} />;
        case "shape":
            return <Sizes keys={SHAPE_SIZES} draft={draft} edit={edit} />;
        case "options":
            return (
                <>
                    <Segmented
                        label={t("skins.ed.platter")}
                        value={draft.style?.platter ? "on" : "off"}
                        options={[
                            { value: "off", label: t("skins.ed.off") },
                            { value: "on", label: t("skins.ed.on") },
                        ]}
                        onChange={(v) => edit((d) => setStyleOption(d, { platter: v === "on" ? true : undefined }))}
                    />
                    <Segmented
                        label={t("skins.ed.waves")}
                        value={draft.style?.waves ?? "stacked"}
                        options={[
                            { value: "stacked", label: t("skins.ed.wavesStacked") },
                            { value: "overlay", label: t("skins.ed.wavesOverlay") },
                        ]}
                        onChange={(v) => edit((d) => setStyleOption(d, { waves: v === "overlay" ? "overlay" : undefined }))}
                    />
                    <SelectRow
                        label={t("skins.ed.layout")}
                        value={draft.style?.layout ?? ""}
                        // Layouts bundled in a pack ("<pack>/<id>") cannot travel with an exported skin.
                        options={[{ value: "", label: t("skins.ed.layoutKeep") }, ...layouts.filter((l) => !l.id.includes("/")).map((l) => ({ value: l.id, label: layoutName(t, l) }))]}
                        onChange={(v) => edit((d) => setStyleOption(d, { layout: v || undefined }))}
                    />
                </>
            );
    }
}

// ── panel ───────────────────────────────────────────────────────────────────────────────────

function noteText(t: Translate, note: EditorNote | null): string {
    if (!note) return "";
    switch (note.kind) {
        case "saved":
            return t("skins.ed.saved", { name: note.name, version: note.version });
        case "draftKept":
            return t("skins.ed.draftKept");
        case "exported":
            return t("skins.ed.exported", { path: note.path });
        case "exportCancelled":
            return t("skins.ed.exportCancelled");
        case "notNative":
            return t("skins.ed.notNative");
        case "nameNeeded":
            return t("skins.ed.nameNeeded");
        case "failed":
            return t("skins.ed.failed", { detail: note.detail });
    }
}

function clampPos(x: number, y: number, w: number): { x: number; y: number } {
    return { x: Math.round(Math.min(Math.max(4, x), Math.max(4, window.innerWidth - w - 4))), y: Math.round(Math.min(Math.max(4, y), Math.max(4, window.innerHeight - 44))) };
}

function isShown(el: HTMLElement | null): el is HTMLElement {
    return !!el && el.isConnected && el.getClientRects().length > 0;
}

/**
 * Where focus goes when the editor closes and the element that opened it is gone (the button
 * lives in the Settings dialog, which the same click closed): the title bar's Settings button.
 */
function focusFallback(): HTMLElement | null {
    const bar = document.querySelector<HTMLElement>(".mixai-titlebar");
    return bar?.querySelector<HTMLElement>("[data-settings-button], button:has(svg.lucide-settings)") ?? bar?.querySelector<HTMLElement>("button:not([disabled])") ?? null;
}

function SkinEditorPanel() {
    const t = useT();
    const uid = useId();
    const draft = useSkinEditor((s) => s.draft);
    const basedOn = useSkinEditor((s) => s.basedOn);
    const name = useSkinEditor((s) => s.name);
    const group = useSkinEditor((s) => s.group);
    const pos = useSkinEditor((s) => s.pos);
    const busy = useSkinEditor((s) => s.busy);
    const note = useSkinEditor((s) => s.note);
    const installed = usePackStore((s) => s.installed);
    const { edit, startFrom, reset, setName, setGroup, setPos, setOpen, save, exportPack } = useSkinEditor.getState();
    const lookVersion = useLookVersion();

    const panel = useRef<HTMLElement | null>(null);
    const nameInput = useRef<HTMLInputElement | null>(null);
    const drag = useRef<{ dx: number; dy: number; last: { x: number; y: number } | null } | null>(null);
    const at = pos ?? clampPos(window.innerWidth - PANEL_W - 12, 44, PANEL_W);

    // Focus moves into the panel when it opens and back to where it was when it closes.
    useEffect(() => {
        const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
        return () => {
            // Only when focus was in the panel (or nowhere): never steal it from the app.
            const now = document.activeElement;
            if (now && now !== document.body && !panel.current?.contains(now) && isShown(now as HTMLElement)) return;
            const to = isShown(before) && before !== document.body ? before : focusFallback();
            // After this commit: the panel is still in the document while the cleanup runs.
            queueMicrotask(() => to?.focus());
        };
    }, []);

    // Unset colours are read from the running app, so the list follows every look change.
    const issues = useMemo(() => {
        void lookVersion;
        return draftProblems(draft, effectiveColor);
    }, [draft, lookVersion]);

    const skins = useMemo(() => {
        const own = installed.filter((p) => (p.manifest.kind === "skin" || p.manifest.kind === "bundle") && !!p.tokens && !BUILTIN_SKINS.some((b) => b.manifest.id === p.manifest.id));
        return [...BUILTIN_SKINS, ...own].map((p) => ({ value: p.manifest.id, label: skinName(t, p) }));
    }, [installed, t]);

    const id = skinId(name);
    const meta = { author: t("skins.ed.author"), description: t("skins.ed.madeIn") };
    const onSave = () => {
        if (!id) nameInput.current?.focus();
        void save(meta);
    };
    const onExport = () => {
        if (!id) nameInput.current?.focus();
        void exportPack(meta);
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
    };
    const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const i = GROUPS.indexOf(group);
        const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? GROUPS.length - 1 : null;
        if (next === null) return;
        e.preventDefault();
        const g = GROUPS[(next + GROUPS.length) % GROUPS.length]!;
        setGroup(g);
        e.currentTarget.querySelector<HTMLElement>(`[data-group="${g}"]`)?.focus();
    };
    const onHeadDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        const el = panel.current;
        if (!el || e.button !== 0 || (e.target as HTMLElement).closest("button, select, input")) return;
        const r = el.getBoundingClientRect();
        drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, last: null };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onHeadMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        const el = panel.current;
        if (!d || !el) return;
        // Written straight to the element while dragging; committed to the store on release.
        d.last = clampPos(e.clientX - d.dx, e.clientY - d.dy, PANEL_W);
        el.style.left = `${d.last.x}px`;
        el.style.top = `${d.last.y}px`;
        el.style.setProperty("--ske-top", `${d.last.y}px`);
    };
    const onHeadUp = () => {
        const d = drag.current;
        drag.current = null;
        if (d?.last) setPos(d.last);
    };
    const onMoveKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
        const step = e.shiftKey ? 64 : 16;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        setPos(clampPos(at.x + dx, at.y + dy, PANEL_W));
    };

    return (
        <section ref={panel} className="ske" role="dialog" aria-modal="false" aria-labelledby={`${uid}-title`} style={{ left: at.x, top: at.y, "--ske-top": `${at.y}px` } as CSSProperties} onKeyDown={onKeyDown} data-skin-editor="">
            <div className="ske-head" onPointerDown={onHeadDown} onPointerMove={onHeadMove} onPointerUp={onHeadUp} onPointerCancel={onHeadUp}>
                <button type="button" className="ske-icon" aria-label={t("skins.ed.move")} title={t("skins.ed.move")} onKeyDown={onMoveKey}>
                    <Move aria-hidden />
                </button>
                <h2 id={`${uid}-title`} className="ske-title">
                    {t("skins.ed.title")}
                </h2>
                <button type="button" className="ske-icon" aria-label={t("skins.ed.close")} title={t("skins.ed.close")} onClick={() => setOpen(false)}>
                    <X aria-hidden />
                </button>
            </div>

            <div className="ske-from">
                <label htmlFor={`${uid}-from`} className="dk-label">
                    {t("skins.ed.from")}
                </label>
                <select id={`${uid}-from`} className="ske-select" value={basedOn ?? ""} title={t("skins.ed.fromHint")} onChange={(e) => startFrom(e.target.value || null)}>
                    <option value="">{t("skins.b.default.name")}</option>
                    {skins.map((s) => (
                        <option key={s.value} value={s.value}>
                            {s.label}
                        </option>
                    ))}
                </select>
            </div>

            <div className="ske-tabs" role="tablist" aria-label={t("skins.ed.groups")} onKeyDown={onTabKey}>
                {GROUPS.map((g) => (
                    <button key={g} type="button" role="tab" id={`${uid}-tab-${g}`} data-group={g} className="dk-tab" aria-selected={g === group} aria-controls={`${uid}-body`} tabIndex={g === group ? 0 : -1} onClick={() => setGroup(g)}>
                        {t(`skins.g.${g}` as MessageKey)}
                    </button>
                ))}
            </div>
            <div className="ske-body" role="tabpanel" id={`${uid}-body`} aria-labelledby={`${uid}-tab-${group}`}>
                <GroupBody key={group} group={group} draft={draft} edit={edit} />
            </div>

            <div className="ske-contrast" role="status" data-ok={issues.length === 0}>
                {issues.length === 0 ? (
                    <p className="ske-contrast-line">
                        <Check aria-hidden /> {t("skins.ed.contrastOk")}
                    </p>
                ) : (
                    <>
                        <p className="ske-contrast-line ske-contrast-title">
                            <TriangleAlert aria-hidden /> {t("skins.ed.contrastTitle", { n: issues.length })}
                        </p>
                        <ul>
                            {issues.slice(0, ISSUES_SHOWN).map((p) => (
                                <li key={`${fieldProp(p.fg)}/${fieldProp(p.bg)}`}>{t("skins.ed.contrastItem", { fg: fieldLabel(t, p.fg), bg: fieldLabel(t, p.bg), ratio: p.ratio.toFixed(1), need: p.need })}</li>
                            ))}
                            {issues.length > ISSUES_SHOWN ? <li>{t("skins.ed.contrastMore", { n: issues.length - ISSUES_SHOWN })}</li> : null}
                        </ul>
                    </>
                )}
            </div>

            <div className="ske-foot">
                <div className="ske-from">
                    <label htmlFor={`${uid}-name`} className="dk-label">
                        {t("skins.ed.name")}
                    </label>
                    <input
                        ref={nameInput}
                        id={`${uid}-name`}
                        type="text"
                        className="ske-text ske-nameinput"
                        autoComplete="off"
                        maxLength={NAME_MAX}
                        value={name}
                        placeholder={t("skins.ed.namePlaceholder")}
                        aria-describedby={`${uid}-id`}
                        aria-invalid={note?.kind === "nameNeeded" || undefined}
                        onChange={(e) => setName(e.target.value)}
                    />
                </div>
                <p id={`${uid}-id`} className="ske-id">
                    {id ? t("skins.ed.idLine", { id }) : t("skins.ed.unsaved")}
                </p>
                <div className="ske-actions">
                    <button type="button" className="dk-btn ske-save" data-on="true" disabled={busy !== null} onClick={onSave}>
                        <Save aria-hidden /> {t("skins.ed.save")}
                    </button>
                    <button type="button" className="dk-btn" disabled={busy !== null} onClick={onExport}>
                        <Download aria-hidden /> {t("skins.ed.export")}
                    </button>
                    <button type="button" className="dk-btn" title={t("skins.ed.resetHint")} onClick={reset}>
                        <RotateCcw aria-hidden /> {t("skins.ed.reset")}
                    </button>
                </div>
                <p className="ske-note" role="status" data-kind={note?.kind ?? ""}>
                    {noteText(t, note)}
                </p>
            </div>
        </section>
    );
}
