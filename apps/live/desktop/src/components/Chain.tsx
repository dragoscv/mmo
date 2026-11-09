/**
 * Signal chain as horizontal cards. Motion `Reorder` + `layout` for drag/morph animations; drag end
 * sends `move_insert`. Every drag action also has buttons (WCAG 2.5.7 dragging alternative).
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, Reorder, motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, GripVertical, Plus, Trash2 } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger, Switch, cn } from "@mmo/ui";
import { useT } from "../i18n";
import type { InsertState } from "../lib/protocol";
import { EMPTY_CHAIN, useStore } from "../store";
import { GrBar } from "./Meters";
import { fxLabel, paramLabel, valueLabel } from "./fx-labels";

function Summary({ insert }: { insert: InsertState }) {
    const t = useT();
    const catalogue = useStore((s) => s.catalogue);
    const specs = catalogue.find((f) => f.id === insert.fx)?.params ?? [];
    const top = specs.filter((s) => s.unit !== "toggle").slice(0, 2);
    return (
        <dl className="grid grid-cols-2 gap-x-2 text-[11px]">
            {top.map((s) => {
                const v = insert.params.find(([id]) => id === s.id)?.[1] ?? s.default;
                return (
                    <div key={s.id} className="min-w-0">
                        <dt className="truncate text-muted-foreground">{paramLabel(t, s.id)}</dt>
                        <dd className="truncate font-medium tabular-nums">{valueLabel(t, s, v)}</dd>
                    </div>
                );
            })}
        </dl>
    );
}

function Card({ insert, index, count, onMove }: { insert: InsertState; index: number; count: number; onMove: (to: number) => void }) {
    const t = useT();
    const send = useStore((s) => s.send);
    const selected = useStore((s) => s.selectedInsert === insert.id);
    const select = useStore((s) => s.selectInsert);
    const name = fxLabel(t, insert.fx);
    return (
        <div
            className={cn(
                "group relative flex h-full w-44 shrink-0 flex-col gap-2 rounded-xl border bg-card p-3 text-card-foreground shadow-xs transition-[border-color,box-shadow,opacity] duration-(--dur-fast)",
                selected ? "border-primary ring-3 ring-ring/30" : "border-border hover:border-ring/60",
                !insert.enabled && "opacity-60",
            )}
        >
            <div className="flex items-center gap-1.5">
                <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" aria-hidden />
                <button
                    type="button"
                    className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                    aria-pressed={selected}
                    onClick={() => select(selected ? null : insert.id)}
                >
                    {name}
                </button>
                <Switch
                    size="sm"
                    checked={insert.enabled}
                    aria-label={`${t("chain.enabled")}: ${name}`}
                    onCheckedChange={(on) => send({ type: "set_enabled", insert: insert.id, on })}
                />
            </div>
            <button type="button" tabIndex={-1} className="min-h-0 flex-1 text-left" onClick={() => select(selected ? null : insert.id)}>
                <Summary insert={insert} />
            </button>
            <GrBar index={index} label={`${t("chain.gr")}: ${name}`} />
            <div className="flex items-center justify-between opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <Button variant="ghost" size="icon-xs" aria-label={`${t("chain.moveLeft")}: ${name}`} disabled={index === 0} onClick={() => onMove(index - 1)}>
                    <ChevronLeft />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${t("chain.remove")}: ${name}`}
                    className="hover:text-destructive"
                    onClick={() => {
                        if (selected) select(null);
                        send({ type: "remove_insert", insert: insert.id });
                    }}
                >
                    <Trash2 />
                </Button>
                <Button variant="ghost" size="icon-xs" aria-label={`${t("chain.moveRight")}: ${name}`} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
                    <ChevronRight />
                </Button>
            </div>
        </div>
    );
}

function AddEffect({ at }: { at: number }) {
    const t = useT();
    const catalogue = useStore((s) => s.catalogue);
    const error = useStore((s) => s.catalogueError);
    const send = useStore((s) => s.send);
    const [open, setOpen] = useState(false);
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
                render={
                    <Button variant="outline" className="h-full w-28 shrink-0 flex-col gap-1 rounded-xl border-dashed" title={t("chain.addTitle")}>
                        <Plus className="size-5" />
                        <span className="text-xs">{t("chain.add")}</span>
                    </Button>
                }
            />
            <PopoverContent side="top" className="w-80">
                {error ? <p className="text-sm text-destructive">{t("chain.catalogueError")}</p> : null}
                <div className="grid grid-cols-2 gap-1.5">
                    {catalogue.map((f) => (
                        <Button
                            key={f.id}
                            variant="secondary"
                            size="sm"
                            className="justify-start"
                            onClick={() => {
                                send({ type: "add_insert", fx: f.id, at });
                                setOpen(false);
                            }}
                        >
                            {fxLabel(t, f.id)}
                        </Button>
                    ))}
                </div>
            </PopoverContent>
        </Popover>
    );
}

export function Chain() {
    const t = useT();
    const chain = useStore((s) => s.proto.state?.chain ?? EMPTY_CHAIN);
    const send = useStore((s) => s.send);
    const reduced = useReducedMotion();
    const [order, setOrder] = useState<number[]>(() => chain.map((c) => c.id));
    const dragging = useRef(false);
    const key = chain.map((c) => c.id).join(",");

    useEffect(() => {
        if (!dragging.current) setOrder(key ? key.split(",").map(Number) : []);
    }, [key]);

    const byId = new Map(chain.map((c) => [c.id, c]));
    const items = order.map((id) => byId.get(id)).filter((x): x is InsertState => !!x);
    const move = (id: number, to: number) => send({ type: "move_insert", insert: id, to });
    const spring = reduced ? { duration: 0 } : { type: "spring" as const, stiffness: 420, damping: 36 };

    return (
        <section aria-label={t("chain.title")} className="flex min-h-0 flex-col gap-2">
            <header className="flex items-baseline gap-3">
                <h2 className="font-heading text-sm font-semibold tracking-wide text-muted-foreground uppercase">{t("chain.title")}</h2>
                <span className="text-xs text-muted-foreground">{t("chain.dragHint")}</span>
            </header>
            <div className="flex h-40 min-h-0 gap-3 overflow-x-auto pb-1">
                {items.length === 0 ? (
                    <p className="flex flex-1 items-center rounded-xl border border-dashed px-4 text-sm text-muted-foreground">{t("chain.empty")}</p>
                ) : (
                    <Reorder.Group as="ol" axis="x" values={order} onReorder={setOrder} className="flex h-full gap-3">
                        <AnimatePresence initial={false}>
                            {items.map((ins, i) => (
                                <Reorder.Item
                                    as="li"
                                    key={ins.id}
                                    value={ins.id}
                                    layout
                                    transition={spring}
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.9 }}
                                    whileDrag={{ scale: 1.04, zIndex: 10 }}
                                    onDragStart={() => (dragging.current = true)}
                                    onDragEnd={() => {
                                        dragging.current = false;
                                        const from = chain.findIndex((c) => c.id === ins.id);
                                        const to = order.indexOf(ins.id);
                                        if (to >= 0 && from !== to) move(ins.id, to);
                                    }}
                                    className="h-full"
                                >
                                    <Card insert={ins} index={i} count={items.length} onMove={(to) => move(ins.id, to)} />
                                </Reorder.Item>
                            ))}
                        </AnimatePresence>
                    </Reorder.Group>
                )}
                <motion.div layout transition={spring} className="h-full">
                    <AddEffect at={chain.length} />
                </motion.div>
            </div>
        </section>
    );
}
