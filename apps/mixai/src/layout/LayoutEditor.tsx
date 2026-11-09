/**
 * Layout editor (drag-and-drop on a grid). Edits a copy of the active layout:
 * - drag a panel chip from the palette or from the grid onto a cell to place it;
 *   drag a placed panel's corner handle to change its span;
 * - +/- column and row counts, weight sliders per column/row;
 * - live solver preview at the current window size with the tier per panel;
 * - Save refuses invalid layouts (validator) and shows the minimum window size.
 * Keyboard: every placed panel is a button; arrows move it, Shift+arrows resize,
 * Delete removes it; palette chips place at the first free cell on Enter.
 */
import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Minus, Plus, X } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Slider } from "@mmo/ui";
import { layoutEditorBridge } from "./editor-bridge";
import { useLayoutStore } from "./layout-store";
import { minimumSize, solve, validateLayout } from "./solver";
import { PANEL_SPECS } from "./presets";
import { PANEL_IDS, type LayoutArea, type LayoutDoc, type PanelId } from "./types";
import { placeArea, resizeArea, setTrackCount } from "./editor-ops";
import { localLayoutId } from "@/packs/pack-layouts";
import { useMotionOK } from "@/shell/motion";
import { useT } from "@/i18n";

function slugify(name: string): string {
    return (
        name
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "layout"
    );
}

export function LayoutEditor() {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<LayoutDoc | null>(null);
    const [errors, setErrors] = useState<string[]>([]);
    const [selected, setSelected] = useState<PanelId | null>(null);
    const [drag, setDrag] = useState<PanelId | null>(null);
    const motionOK = useMotionOK();

    useEffect(() => {
        layoutEditorBridge.open = () => {
            const active = useLayoutStore.getState().active();
            const builtin = !useLayoutStore.getState().user.some((u) => u.id === active.id);
            // Pack layouts carry `<packId>/<id>`; a fork gets a plain slug from the local part.
            setDraft({ ...structuredClone(active), id: builtin ? `${localLayoutId(active.id)}-custom` : active.id, name: builtin ? `${active.name} +` : active.name });
            setErrors([]);
            setSelected(null);
            setOpen(true);
        };
        return () => {
            layoutEditorBridge.open = () => {};
        };
    }, []);

    const preview = useMemo(() => {
        if (!draft) return null;
        const w = Math.max(960, window.innerWidth - 16);
        const h = Math.max(560, window.innerHeight - 56);
        return { w, h, sol: solve(draft, { w, h }, PANEL_SPECS), min: minimumSize(draft, PANEL_SPECS) };
    }, [draft]);

    if (!draft || !preview) return null;
    const unplaced = PANEL_IDS.filter((p) => !draft.areas.some((a) => a.panel === p));
    const update = (l: LayoutDoc) => {
        setDraft(l);
        setErrors([]);
    };
    const firstFree = (): [number, number] | null => {
        for (let r = 0; r < draft.rows.length; r++)
            for (let c = 0; c < draft.columns.length; c++)
                if (!draft.areas.some((a) => c >= a.col && c < a.col + (a.colSpan ?? 1) && r >= a.row && r < a.row + (a.rowSpan ?? 1))) return [c, r];
        return null;
    };
    const save = () => {
        const errs = validateLayout(draft, PANEL_IDS);
        if (errs.length) return setErrors(errs);
        const res = useLayoutStore.getState().saveUser(draft);
        if (res.length) return setErrors(res);
        useLayoutStore.getState().setActive(draft.id);
        setOpen(false);
    };
    const colTpl = draft.columns.map((w) => `${w}fr`).join(" ");
    const rowTpl = draft.rows.map((w) => `${w}fr`).join(" ");
    const tierOf = (p: PanelId) => preview.sol.placements.find((x) => x.panel === p)?.tier ?? (preview.sol.docked.includes(p) ? "dock" : "");

    const onPanelKey = (e: React.KeyboardEvent, a: LayoutArea) => {
        const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const v = d[e.key];
        if (v) {
            e.preventDefault();
            if (e.shiftKey) update(resizeArea(draft, a.panel, v[0], v[1]));
            else {
                const c = Math.max(0, Math.min(draft.columns.length - 1, a.col + v[0]));
                const r = Math.max(0, Math.min(draft.rows.length - 1, a.row + v[1]));
                update(placeArea(draft, a.panel, c, r));
            }
        } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            update({ ...draft, areas: draft.areas.filter((x) => x.panel !== a.panel) });
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent size="full" className="grid h-[min(88vh,820px)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{t("shell.editor.title")}</DialogTitle>
                    <DialogDescription>{t("shell.editor.description")}</DialogDescription>
                </DialogHeader>

                <div className="grid min-h-0 grid-cols-[16rem_minmax(0,1fr)] gap-4">
                    <aside className="grid min-h-0 content-start gap-3 overflow-hidden">
                        <div className="grid gap-1">
                            <Label htmlFor="le-name">{t("shell.editor.name")}</Label>
                            <Input
                                id="le-name"
                                value={draft.name}
                                maxLength={60}
                                onChange={(e) => update({ ...draft, name: e.target.value, id: useLayoutStore.getState().user.some((u) => u.id === draft.id) ? draft.id : slugify(e.target.value) })}
                            />
                        </div>
                        {(["columns", "rows"] as const).map((axis) => (
                            <div key={axis} className="grid gap-1">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium">{t(axis === "columns" ? "shell.editor.columns" : "shell.editor.rows")}</span>
                                    <div className="flex items-center gap-1">
                                        <Button size="icon-sm" variant="outline" aria-label={t(axis === "columns" ? "shell.editor.lessColumns" : "shell.editor.lessRows")} onClick={() => update(setTrackCount(draft, axis, draft[axis].length - 1))}>
                                            <Minus aria-hidden />
                                        </Button>
                                        <span className="mono w-5 text-center text-sm">{draft[axis].length}</span>
                                        <Button size="icon-sm" variant="outline" aria-label={t(axis === "columns" ? "shell.editor.moreColumns" : "shell.editor.moreRows")} onClick={() => update(setTrackCount(draft, axis, draft[axis].length + 1))}>
                                            <Plus aria-hidden />
                                        </Button>
                                    </div>
                                </div>
                                <div className="grid gap-1.5">
                                    {draft[axis].map((w, i) => (
                                        <Slider
                                            key={i}
                                            min={1}
                                            max={12}
                                            step={1}
                                            value={[w]}
                                            aria-label={t(axis === "columns" ? "shell.editor.weight" : "shell.editor.rowWeight", { n: i + 1 })}
                                            onValueChange={(v) => {
                                                const n = Array.isArray(v) ? Number(v[0]) : Number(v);
                                                update({ ...draft, [axis]: draft[axis].map((x, j) => (j === i ? n : x)) });
                                            }}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))}
                        <div className="grid gap-1">
                            <span className="text-sm font-medium">{t("shell.editor.palette")}</span>
                            <div className="flex flex-wrap gap-1.5">
                                {unplaced.map((p) => (
                                    <button
                                        key={p}
                                        type="button"
                                        draggable
                                        onDragStart={() => setDrag(p)}
                                        onDragEnd={() => setDrag(null)}
                                        onClick={() => {
                                            const f = firstFree();
                                            if (f) update(placeArea(draft, p, f[0], f[1]));
                                        }}
                                        className="rounded-md border border-border bg-muted px-2 py-1 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                    >
                                        {t(`shell.panel.${p}` as const)}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">{t("shell.editor.minSize", { w: preview.min.w + 16, h: preview.min.h + 56 })}</p>
                    </aside>

                    <div className="relative min-h-0 overflow-hidden rounded-lg border border-border bg-background/40 p-2">
                        <div className="grid h-full w-full gap-2" style={{ gridTemplateColumns: colTpl, gridTemplateRows: rowTpl }}>
                            {draft.rows.flatMap((_, r) =>
                                draft.columns.map((_, c) => (
                                    <div
                                        key={`${c}-${r}`}
                                        style={{ gridColumn: c + 1, gridRow: r + 1 }}
                                        className={"rounded-md border border-dashed " + (drag ? "border-primary/60 bg-primary/5" : "border-border/60")}
                                        onDragOver={(e) => e.preventDefault()}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            if (drag) update(placeArea(draft, drag, c, r));
                                            setDrag(null);
                                        }}
                                    />
                                )),
                            )}
                            {draft.areas.map((a) => (
                                <motion.div
                                    key={a.panel}
                                    layout={motionOK}
                                    transition={{ duration: motionOK ? 0.18 : 0 }}
                                    style={{ gridColumn: `${a.col + 1} / span ${a.colSpan ?? 1}`, gridRow: `${a.row + 1} / span ${a.rowSpan ?? 1}` }}
                                    className={
                                        "relative z-10 flex min-h-0 min-w-0 flex-col items-center justify-center gap-1 rounded-md border bg-card text-center shadow-sm " +
                                        (selected === a.panel ? "border-primary ring-2 ring-primary/40" : "border-border")
                                    }
                                    draggable
                                    onDragStartCapture={() => setDrag(a.panel)}
                                    onDragEnd={() => setDrag(null)}
                                    onDragOver={(e) => e.preventDefault()}
                                >
                                    <button
                                        type="button"
                                        className="absolute inset-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                        onClick={() => setSelected(a.panel)}
                                        onKeyDown={(e) => onPanelKey(e, a)}
                                        aria-label={`${t(`shell.panel.${a.panel}` as const)} ${tierOf(a.panel)}`}
                                    />
                                    <span className="pointer-events-none text-sm font-semibold">{t(`shell.panel.${a.panel}` as const)}</span>
                                    <span className="mono pointer-events-none text-[10px] uppercase text-muted-foreground">{tierOf(a.panel)}</span>
                                    <button
                                        type="button"
                                        aria-label={t("shell.editor.remove")}
                                        className="absolute top-1 right-1 z-10 inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                        onClick={() => update({ ...draft, areas: draft.areas.filter((x) => x.panel !== a.panel) })}
                                    >
                                        <X className="size-3.5" aria-hidden />
                                    </button>
                                    <span
                                        aria-hidden
                                        className="absolute right-0.5 bottom-0.5 z-10 size-3 cursor-se-resize rounded-sm bg-primary/70"
                                        onPointerDown={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            const grid = (e.currentTarget.closest(".grid") as HTMLElement).getBoundingClientRect();
                                            const cw = grid.width / draft.columns.length;
                                            const rh = grid.height / draft.rows.length;
                                            const x0 = e.clientX;
                                            const y0 = e.clientY;
                                            let applied = [0, 0];
                                            const move = (ev: PointerEvent) => {
                                                const dc = Math.round((ev.clientX - x0) / cw);
                                                const dr = Math.round((ev.clientY - y0) / rh);
                                                if (dc !== applied[0] || dr !== applied[1]) {
                                                    setDraft((d) => (d ? resizeArea(d, a.panel, dc - applied[0]!, dr - applied[1]!) : d));
                                                    applied = [dc, dr];
                                                }
                                            };
                                            const up = () => {
                                                window.removeEventListener("pointermove", move);
                                                window.removeEventListener("pointerup", up);
                                            };
                                            window.addEventListener("pointermove", move);
                                            window.addEventListener("pointerup", up);
                                        }}
                                    />
                                </motion.div>
                            ))}
                        </div>
                    </div>
                </div>

                <DialogFooter className="items-center">
                    {errors.length > 0 && (
                        <p role="alert" className="me-auto max-w-[60ch] truncate text-sm text-destructive" title={errors.join("; ")}>
                            {t("shell.editor.invalid", { reason: errors[0]! })}
                        </p>
                    )}
                    <Button variant="outline" onClick={() => setOpen(false)}>
                        {t("shell.editor.cancel")}
                    </Button>
                    <Button onClick={save}>{t("shell.editor.save")}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
