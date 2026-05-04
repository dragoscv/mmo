"use client";

/**
 * PluginsClient — `/plugins` page.
 *
 * Catalog/manager for the companion's audio plugin host. The actual
 * "use a plugin on a track" UX lives in the DAW / Sound Editor / Live
 * page widgets that build on the shared `<PluginRack/>` component.
 */

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
    ArrowLeft,
    Boxes,
    Cpu,
    Filter,
    Loader2,
    Music2,
    Plug,
    RefreshCw,
    Search,
    Settings2,
    SlidersHorizontal,
    Sparkles,
} from "lucide-react";
import { scanPlugins } from "@/actions/plugins";
import type { PluginDescriptor, PluginScanResult } from "@/lib/companion-plugins";
import { cn } from "@/lib/utils";

interface Props {
    initialCached: PluginScanResult | null;
}

type FormatFilter = "all" | "VST3" | "AU" | "LV2";
type RoleFilter = "all" | "effect" | "instrument";

export function PluginsClient({ initialCached }: Props) {
    const [cached, setCached] = useState<PluginScanResult | null>(initialCached);
    const [scanning, startScanTransition] = useTransition();
    const [scanError, setScanError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [formatFilter, setFormatFilter] = useState<FormatFilter>("all");
    const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
    const [selected, setSelected] = useState<PluginDescriptor | null>(null);

    const inventory = cached?.inventory ?? [];
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return inventory.filter((p) => {
            if (formatFilter !== "all" && p.format !== formatFilter) return false;
            if (roleFilter === "effect" && !p.isEffect) return false;
            if (roleFilter === "instrument" && !p.isInstrument) return false;
            if (!q) return true;
            return (
                p.name.toLowerCase().includes(q)
                || p.manufacturer.toLowerCase().includes(q)
                || p.path.toLowerCase().includes(q)
            );
        });
    }, [inventory, search, formatFilter, roleFilter]);

    const triggerScan = () => {
        setScanError(null);
        startScanTransition(async () => {
            const r = await scanPlugins();
            if (!r.ok || !r.result) {
                setScanError(r.error ?? "Scan failed");
                return;
            }
            setCached(r.result);
            // Keep the selected plugin in sync if it survived the rescan.
            if (selected) {
                const next = r.result.inventory.find((p) => p.path === selected.path);
                setSelected(next ?? null);
            }
        });
    };

    const counts = useMemo(() => {
        const out = { total: inventory.length, vst3: 0, au: 0, lv2: 0, fx: 0, instrument: 0 };
        for (const p of inventory) {
            if (p.format === "VST3") out.vst3++;
            if (p.format === "AU") out.au++;
            if (p.format === "LV2") out.lv2++;
            if (p.isEffect) out.fx++;
            if (p.isInstrument) out.instrument++;
        }
        return out;
    }, [inventory]);

    return (
        <div className="flex h-full flex-col overflow-y-auto bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 text-white">
            {/* Header */}
            <div className="border-b border-white/10 bg-black/40 backdrop-blur sticky top-0 z-30">
                <div className="container mx-auto px-6 py-4 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <Link
                            href="/"
                            className="text-white/60 hover:text-white inline-flex items-center gap-2 text-sm"
                        >
                            <ArrowLeft className="h-4 w-4" /> Dashboard
                        </Link>
                        <span className="text-white/30">/</span>
                        <h1 className="text-xl font-semibold flex items-center gap-2">
                            <Plug className="h-5 w-5 text-violet-400" /> Plugins
                        </h1>
                        <span className="text-xs text-white/50">
                            VST3 / AU / LV2 host
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={triggerScan}
                            disabled={scanning}
                            className={cn(
                                "rounded-md px-3 py-1.5 text-sm font-medium",
                                "bg-violet-500 hover:bg-violet-400 text-white",
                                "disabled:opacity-50 disabled:cursor-not-allowed",
                                "inline-flex items-center gap-2 transition",
                            )}
                        >
                            {scanning
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <RefreshCw className="h-4 w-4" />}
                            {cached ? "Rescan" : "Scan plugins"}
                        </button>
                    </div>
                </div>
            </div>

            <div className="container mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[280px_1fr_360px] gap-6">
                {/* Sidebar — stats + filters */}
                <aside className="space-y-4">
                    <Card title="Inventory" icon={<Boxes className="h-4 w-4" />}>
                        <Stat label="Total" value={counts.total} />
                        <Stat label="VST3" value={counts.vst3} />
                        <Stat label="AU" value={counts.au} />
                        <Stat label="LV2" value={counts.lv2} />
                        <div className="my-2 h-px bg-white/10" />
                        <Stat label="Effects" value={counts.fx} />
                        <Stat label="Instruments" value={counts.instrument} />
                        {cached?.scannedAt
                            ? <p className="text-[10px] text-white/40 mt-3">
                                Scanned {new Date(cached.scannedAt * 1000).toLocaleString()}
                            </p>
                            : <p className="text-[10px] text-white/40 mt-3">
                                Never scanned
                            </p>}
                    </Card>

                    <Card title="Filters" icon={<Filter className="h-4 w-4" />}>
                        <div className="space-y-3">
                            <FilterGroup
                                label="Format"
                                value={formatFilter}
                                onChange={setFormatFilter}
                                options={[
                                    { value: "all", label: "All" },
                                    { value: "VST3", label: "VST3" },
                                    { value: "AU", label: "AU" },
                                    { value: "LV2", label: "LV2" },
                                ]}
                            />
                            <FilterGroup
                                label="Role"
                                value={roleFilter}
                                onChange={setRoleFilter}
                                options={[
                                    { value: "all", label: "All" },
                                    { value: "effect", label: "Effects" },
                                    { value: "instrument", label: "Instruments" },
                                ]}
                            />
                        </div>
                    </Card>

                    {cached && cached.failures.length > 0 ? (
                        <Card title={`Failures (${cached.failures.length})`} icon={<Sparkles className="h-4 w-4" />}>
                            <ul className="space-y-1 text-[11px] text-white/60 max-h-48 overflow-auto">
                                {cached.failures.slice(0, 30).map((f) => (
                                    <li key={f.path} className="truncate" title={`${f.path}\n${f.error}`}>
                                        {f.path.split(/[\\/]/).pop()}
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    ) : null}

                    {cached && cached.roots.length > 0 ? (
                        <Card title="Scan roots" icon={<Cpu className="h-4 w-4" />}>
                            <ul className="space-y-1 text-[11px] text-white/60">
                                {cached.roots.map((r) => (
                                    <li key={r} className="truncate" title={r}>{r}</li>
                                ))}
                            </ul>
                        </Card>
                    ) : null}
                </aside>

                {/* Main list */}
                <main className="space-y-3">
                    <div className="relative">
                        <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search by name, vendor, path…"
                            className={cn(
                                "w-full rounded-md bg-white/5 border border-white/10",
                                "pl-9 pr-3 py-2 text-sm text-white",
                                "focus:outline-none focus:ring-1 focus:ring-violet-400 focus:border-violet-400",
                            )}
                        />
                    </div>

                    {scanError ? (
                        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
                            Scan failed: {scanError}
                        </div>
                    ) : null}

                    {!cached ? (
                        <EmptyState onScan={triggerScan} scanning={scanning} />
                    ) : filtered.length === 0 ? (
                        <div className="rounded-md border border-white/10 bg-white/5 p-8 text-center text-sm text-white/60">
                            No plugins match the current filters.
                        </div>
                    ) : (
                        <ul className="space-y-1.5">
                            <AnimatePresence initial={false}>
                                {filtered.map((p) => (
                                    <PluginRow
                                        key={p.path}
                                        plugin={p}
                                        active={selected?.path === p.path}
                                        onClick={() => setSelected(p)}
                                    />
                                ))}
                            </AnimatePresence>
                        </ul>
                    )}
                </main>

                {/* Detail panel */}
                <aside>
                    {selected
                        ? <PluginDetail plugin={selected} />
                        : (
                            <div className="rounded-md border border-white/10 bg-white/[0.02] p-6 text-sm text-white/50 text-center">
                                <SlidersHorizontal className="h-6 w-6 mx-auto mb-3 text-white/30" />
                                Select a plugin to inspect its parameters.
                            </div>
                        )}
                </aside>
            </div>
        </div>
    );
}

// ─── Small components ───────────────────────────────────────────────

function Card({
    title,
    icon,
    children,
}: {
    title: string;
    icon?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
            <h3 className="text-[11px] uppercase tracking-wider text-white/50 mb-2 flex items-center gap-1.5">
                {icon} {title}
            </h3>
            <div>{children}</div>
        </div>
    );
}

function Stat({ label, value }: { label: string; value: number }) {
    return (
        <div className="flex items-center justify-between text-sm py-0.5">
            <span className="text-white/60">{label}</span>
            <span className="font-medium tabular-nums">{value.toLocaleString()}</span>
        </div>
    );
}

function FilterGroup<T extends string>({
    label,
    value,
    onChange,
    options,
}: {
    label: string;
    value: T;
    onChange: (v: T) => void;
    options: Array<{ value: T; label: string }>;
}) {
    return (
        <div>
            <p className="text-[10px] uppercase tracking-wider text-white/40 mb-1">{label}</p>
            <div className="flex flex-wrap gap-1">
                {options.map((opt) => (
                    <button
                        key={opt.value}
                        onClick={() => onChange(opt.value)}
                        className={cn(
                            "rounded px-2 py-0.5 text-[11px] border transition",
                            value === opt.value
                                ? "bg-violet-500/30 border-violet-400/60 text-white"
                                : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10",
                        )}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

function PluginRow({
    plugin,
    active,
    onClick,
}: {
    plugin: PluginDescriptor;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <motion.li
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
        >
            <button
                onClick={onClick}
                className={cn(
                    "w-full text-left rounded-md border px-3 py-2 transition",
                    active
                        ? "bg-violet-500/15 border-violet-400/50"
                        : "bg-white/[0.02] border-white/10 hover:bg-white/[0.06]",
                )}
            >
                <div className="flex items-center gap-3">
                    <div className={cn(
                        "h-9 w-9 rounded shrink-0 flex items-center justify-center text-[10px] font-bold",
                        plugin.isInstrument ? "bg-amber-400/20 text-amber-300" : "bg-violet-400/20 text-violet-200",
                    )}>
                        {plugin.format}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{plugin.name}</p>
                        <p className="text-[11px] text-white/50 truncate">
                            {plugin.manufacturer || "—"}
                            <span className="mx-1.5 text-white/20">•</span>
                            {plugin.parameters.length} param{plugin.parameters.length === 1 ? "" : "s"}
                            <span className="mx-1.5 text-white/20">•</span>
                            {plugin.isInstrument ? "Instrument" : "Effect"}
                        </p>
                    </div>
                </div>
            </button>
        </motion.li>
    );
}

function PluginDetail({ plugin }: { plugin: PluginDescriptor }) {
    return (
        <div className="rounded-md border border-white/10 bg-white/[0.03]">
            <div className="p-4 border-b border-white/10">
                <div className="flex items-center gap-2 mb-1">
                    <span className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-bold",
                        plugin.isInstrument ? "bg-amber-400/20 text-amber-300" : "bg-violet-400/20 text-violet-200",
                    )}>
                        {plugin.format}
                    </span>
                    <span className="text-[10px] text-white/50">
                        {plugin.isInstrument ? "Instrument" : "Effect"}
                    </span>
                </div>
                <h3 className="text-base font-semibold">{plugin.name}</h3>
                <p className="text-xs text-white/50">{plugin.manufacturer || "Unknown vendor"}</p>
                <p className="text-[10px] text-white/30 mt-1 truncate" title={plugin.path}>
                    {plugin.path}
                </p>
            </div>
            <div className="p-3">
                <p className="text-[10px] uppercase tracking-wider text-white/50 mb-2 flex items-center gap-1.5">
                    <Settings2 className="h-3 w-3" /> Parameters ({plugin.parameters.length})
                </p>
                {plugin.parameters.length === 0 ? (
                    <p className="text-xs text-white/40 py-4 text-center">
                        No introspectable parameters.
                    </p>
                ) : (
                    <ul className="space-y-1 max-h-[60vh] overflow-auto pr-1">
                        {plugin.parameters.map((param) => (
                            <li
                                key={param.id}
                                className="rounded border border-white/5 bg-black/20 px-2 py-1.5 text-xs"
                            >
                                <div className="flex items-baseline justify-between gap-2">
                                    <span className="font-medium truncate">{param.name}</span>
                                    {param.string_value !== undefined ? (
                                        <span className="text-white/50 text-[10px] tabular-nums shrink-0">
                                            {param.string_value}{param.label ?? ""}
                                        </span>
                                    ) : null}
                                </div>
                                {(param.min_value !== undefined && param.max_value !== undefined) ? (
                                    <p className="text-[10px] text-white/30 mt-0.5">
                                        Range {param.min_value} – {param.max_value}
                                    </p>
                                ) : param.valid_values && param.valid_values.length ? (
                                    <p className="text-[10px] text-white/30 mt-0.5 truncate">
                                        {param.valid_values.slice(0, 4).join(" / ")}
                                        {param.valid_values.length > 4 ? "…" : ""}
                                    </p>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

function EmptyState({ onScan, scanning }: { onScan: () => void; scanning: boolean }) {
    return (
        <div className="rounded-md border border-white/10 bg-white/[0.03] p-10 text-center">
            <Music2 className="h-10 w-10 mx-auto text-white/30 mb-4" />
            <h2 className="text-lg font-semibold mb-1">No scan yet</h2>
            <p className="text-sm text-white/50 max-w-md mx-auto mb-5">
                Click <span className="text-white/80">Scan plugins</span> to walk your
                operating-system VST3 / AU / LV2 directories and catalog every installed
                plugin. Scans usually take 5–60 seconds depending on library size.
            </p>
            <button
                onClick={onScan}
                disabled={scanning}
                className={cn(
                    "rounded-md px-4 py-2 text-sm font-medium",
                    "bg-violet-500 hover:bg-violet-400 text-white",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    "inline-flex items-center gap-2",
                )}
            >
                {scanning
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <RefreshCw className="h-4 w-4" />}
                {scanning ? "Scanning…" : "Scan plugins"}
            </button>
        </div>
    );
}
