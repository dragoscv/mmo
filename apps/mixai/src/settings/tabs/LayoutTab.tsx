import { useState } from "react";
import { Check, Pencil, Plus, X } from "lucide-react";
import { Button, Input, Kbd } from "@mmo/ui";
import { useT } from "@/i18n";
import { useAllLayouts, useLayoutStore } from "@/layout/layout-store";
import { openLayoutEditor } from "@/layout/editor-bridge";
import type { LayoutDoc } from "@/layout/types";
import { cn } from "@mmo/ui";
import { Section } from "../sections/shared";

export const nativeSelect =
    "h-control-sm rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30";

const SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;

/** Normalised cumulative offsets of weighted tracks: [0, …, 1]. */
function offsets(weights: number[]): number[] {
    const total = weights.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const out = [0];
    for (const w of weights) out.push((out[out.length - 1] ?? 0) + Math.max(0, w) / total);
    return out;
}

/** Tiny picture of a layout drawn from its grid (decks highlighted). */
export function MiniGrid({ layout, className }: { layout: LayoutDoc; className?: string }) {
    const cs = offsets(layout.columns);
    const rs = offsets(layout.rows);
    const at = (arr: number[], i: number) => arr[Math.min(i, arr.length - 1)] ?? 1;
    return (
        <div aria-hidden className={cn("relative aspect-video w-full overflow-hidden rounded-md bg-muted", className)}>
            {layout.areas.map((a) => {
                const l = at(cs, a.col);
                const r = at(cs, a.col + (a.colSpan ?? 1));
                const tp = at(rs, a.row);
                const b = at(rs, a.row + (a.rowSpan ?? 1));
                const deck = a.panel.startsWith("deck");
                return (
                    <div
                        key={`${a.panel}-${a.col}-${a.row}`}
                        className="absolute p-[2px]"
                        style={{ left: `${l * 100}%`, top: `${tp * 100}%`, width: `${(r - l) * 100}%`, height: `${(b - tp) * 100}%` }}
                    >
                        <div className={cn("size-full rounded-[3px]", deck ? "bg-primary/45" : "bg-foreground/15")} />
                    </div>
                );
            })}
        </div>
    );
}

export function LayoutTab() {
    const t = useT();
    const layouts = useAllLayouts();
    const activeId = useLayoutStore((s) => s.activeId);
    const setActive = useLayoutStore((s) => s.setActive);
    const snapshots = useLayoutStore((s) => s.snapshots);
    const setSnapshot = useLayoutStore((s) => s.setSnapshot);
    const controllerLayouts = useLayoutStore((s) => s.controllerLayouts);
    const setControllerLayout = useLayoutStore((s) => s.setControllerLayout);
    const [device, setDevice] = useState("");
    const [deviceLayout, setDeviceLayout] = useState(activeId);

    const addMapping = () => {
        const name = device.trim();
        if (!name) return;
        setControllerLayout(name, deviceLayout);
        setDevice("");
    };

    return (
        <div className="grid gap-6">
            <Section title={t("settings.layoutList")} settingId="layout.list">
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                    {layouts.map((l) => {
                        const active = l.id === activeId;
                        return (
                            <button
                                key={l.id}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setActive(l.id)}
                                className={cn(
                                    "grid gap-2 rounded-lg border p-2 text-left text-sm transition-colors duration-(--dur-fast) outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
                                    active ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-muted",
                                )}
                            >
                                <MiniGrid layout={l} />
                                <span className="flex items-center justify-between gap-1 font-medium">
                                    <span className="truncate">{l.name}</span>
                                    {active && (
                                        <span className="inline-flex items-center gap-1 text-xs text-primary">
                                            <Check className="size-3" aria-hidden /> {t("settings.active")}
                                        </span>
                                    )}
                                </span>
                            </button>
                        );
                    })}
                </div>
                <div>
                    <Button variant="outline" size="sm" onClick={() => openLayoutEditor()} data-setting-id="layout.editor">
                        <Pencil aria-hidden /> {t("settings.layoutEdit")}
                    </Button>
                </div>
            </Section>

            <Section title={t("settings.layoutSnapshots")} settingId="layout.snapshots">
                <p className="text-xs text-muted-foreground">
                    {t("settings.layoutSnapshotsHint")} <Kbd>Alt</Kbd>+<Kbd>1…8</Kbd>
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                    {SLOTS.map((slot) => (
                        <label key={slot} className="grid gap-1 text-xs text-muted-foreground">
                            {t("settings.layoutSlot", { n: slot })}
                            <select
                                className={nativeSelect}
                                value={snapshots[slot] ?? ""}
                                onChange={(e) => setSnapshot(slot, e.target.value || null)}
                            >
                                <option value="">{t("settings.layoutNone")}</option>
                                {layouts.map((l) => (
                                    <option key={l.id} value={l.id}>
                                        {l.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ))}
                </div>
            </Section>

            <Section title={t("settings.layoutControllers")} settingId="layout.controllers">
                <p className="text-xs text-muted-foreground">{t("settings.layoutControllersHint")}</p>
                {Object.keys(controllerLayouts).length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("settings.layoutMappingsEmpty")}</p>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="py-1 font-medium">{t("settings.layoutDevice")}</th>
                                <th className="py-1 font-medium">{t("settings.layoutList")}</th>
                                <th className="w-10 py-1">
                                    <span className="sr-only">{t("settings.remove")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {Object.entries(controllerLayouts).map(([name, id]) => (
                                <tr key={name} className="border-t border-border">
                                    <td className="py-1.5 pr-2">{name}</td>
                                    <td className="py-1.5 pr-2">
                                        <select
                                            aria-label={`${t("settings.layoutList")} · ${name}`}
                                            className={nativeSelect}
                                            value={id}
                                            onChange={(e) => setControllerLayout(name, e.target.value)}
                                        >
                                            {layouts.map((l) => (
                                                <option key={l.id} value={l.id}>
                                                    {l.name}
                                                </option>
                                            ))}
                                        </select>
                                    </td>
                                    <td className="py-1.5">
                                        <Button variant="ghost" size="icon-sm" aria-label={`${t("settings.remove")} · ${name}`} onClick={() => setControllerLayout(name, null)}>
                                            <X aria-hidden />
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <div className="flex flex-wrap items-end gap-2">
                    <label className="grid gap-1 text-xs text-muted-foreground">
                        {t("settings.layoutDevice")}
                        <Input size="sm" value={device} placeholder="DDJ-FLX4" onChange={(e) => setDevice(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addMapping()} className="w-48" />
                    </label>
                    <label className="grid gap-1 text-xs text-muted-foreground">
                        {t("settings.layoutList")}
                        <select className={nativeSelect} value={deviceLayout} onChange={(e) => setDeviceLayout(e.target.value)}>
                            {layouts.map((l) => (
                                <option key={l.id} value={l.id}>
                                    {l.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <Button variant="outline" size="sm" onClick={addMapping} disabled={!device.trim()}>
                        <Plus aria-hidden /> {t("settings.layoutAdd")}
                    </Button>
                </div>
            </Section>
        </div>
    );
}
