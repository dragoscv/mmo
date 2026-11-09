/**
 * Export (section picking) and import (diff preview, per-section apply)
 * dialogs for the versioned settings file. Rendered once by SettingsModal;
 * any tab opens them through `useFileDialogs`.
 */
import { useMemo, useState } from "react";
import { create } from "zustand";
import { ArrowRight, Download, TriangleAlert } from "lucide-react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@mmo/ui";
import { useT, type MessageKey } from "@/i18n";
import {
    SECTION_IDS,
    SENSITIVE_SECTIONS,
    buildFile,
    defaultExportSections,
    diff,
    exportFileName,
    formatValue,
    groupDiff,
    migrate,
    pickSections,
    type DiffEntry,
    type SectionId,
    type Sections,
    type SettingsFile,
} from "./settings-io";
import { apply, collect } from "./settings-live";
import { useUndoStore } from "./undo-store";
import { APP_VERSION } from "./app-info";

export const SECTION_LABEL: Record<SectionId, MessageKey> = {
    appearance: "settings.sectionAppearance",
    layout: "settings.sectionLayout",
    audio: "settings.sectionAudio",
    midi: "settings.sectionMidi",
    hid: "settings.sectionHid",
    keyboard: "settings.sectionKeyboard",
    plugins: "settings.sectionPlugins",
    library: "settings.sectionLibrary",
};

interface ImportState {
    file: SettingsFile;
    current: Sections;
}

interface FileDialogs {
    exportOpen: boolean;
    importState: ImportState | null;
    setExportOpen: (open: boolean) => void;
    setImportState: (s: ImportState | null) => void;
}

export const useFileDialogs = create<FileDialogs>((set) => ({
    exportOpen: false,
    importState: null,
    setExportOpen: (exportOpen) => set({ exportOpen }),
    setImportState: (importState) => set({ importState }),
}));

/** Open a file picker for a settings JSON (`<input type=file>`). */
function pickJsonFile(): Promise<string | null> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.onchange = () => {
            const f = input.files?.[0];
            if (!f) return resolve(null);
            f.text().then(resolve, () => resolve(null));
        };
        input.oncancel = () => resolve(null);
        input.click();
    });
}

/** Pick a file, validate/migrate it and open the import preview. */
export async function startImport(onInvalid: () => void): Promise<void> {
    const text = await pickJsonFile();
    if (text === null) return;
    const file = migrate(text);
    if (!file) return onInvalid();
    const current = await collect({ includeLibrary: true });
    useFileDialogs.getState().setImportState({ file, current });
}

function download(name: string, json: string): void {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SectionChecks({
    ids,
    picked,
    onChange,
    counts,
}: {
    ids: readonly SectionId[];
    picked: SectionId[];
    onChange: (next: SectionId[]) => void;
    counts?: Record<SectionId, number>;
}) {
    const t = useT();
    return (
        <div className="grid grid-cols-2 gap-2">
            {ids.map((id) => {
                const on = picked.includes(id);
                const domId = `settings-file-${id}`;
                return (
                    <label key={id} htmlFor={domId} className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
                        <Checkbox id={domId} checked={on} onCheckedChange={(c) => onChange(c ? [...picked, id] : picked.filter((x) => x !== id))} />
                        <span className="flex-1">{t(SECTION_LABEL[id])}</span>
                        {counts && <span className="text-xs text-muted-foreground tabular-nums">{t("settings.importCount", { n: counts[id] })}</span>}
                    </label>
                );
            })}
        </div>
    );
}

function LibraryWarning() {
    const t = useT();
    return (
        <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="note">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t("settings.exportLibraryWarn")}
        </p>
    );
}

export function ExportDialog() {
    const t = useT();
    const open = useFileDialogs((s) => s.exportOpen);
    const setOpen = useFileDialogs((s) => s.setExportOpen);
    const setStatus = useUndoStore((s) => s.setStatus);
    const [picked, setPicked] = useState<SectionId[]>(() => defaultExportSections());
    const [busy, setBusy] = useState(false);

    const doExport = async () => {
        setBusy(true);
        try {
            const sections = await collect({ includeLibrary: picked.includes("library") });
            const file = buildFile(sections, { app: APP_VERSION, picked });
            download(exportFileName(), JSON.stringify(file, null, 2));
            setStatus(t("settings.exportDone"));
            setOpen(false);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent size="md" mobile="center">
                <DialogHeader>
                    <DialogTitle>{t("settings.exportTitle")}</DialogTitle>
                    <DialogDescription>{t("settings.exportDesc")}</DialogDescription>
                </DialogHeader>
                <SectionChecks ids={SECTION_IDS} picked={picked} onChange={setPicked} />
                {picked.some((id) => SENSITIVE_SECTIONS.includes(id)) && <LibraryWarning />}
                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>
                        {t("common.cancel")}
                    </Button>
                    <Button onClick={() => void doExport()} disabled={picked.length === 0} loading={busy}>
                        <Download aria-hidden /> {t("settings.exportDownload")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

const MAX_ROWS = 40;

function show(e: DiffEntry, v: DiffEntry["before"]): string {
    if (/token|secret|password/i.test(e.path) && typeof v === "string" && v) return "••••";
    return formatValue(v);
}

function DiffList({ entries }: { entries: DiffEntry[] }) {
    const t = useT();
    if (entries.length === 0) return <p className="px-1 text-xs text-muted-foreground">{t("settings.importSame")}</p>;
    return (
        <ul className="grid gap-1">
            {entries.slice(0, MAX_ROWS).map((e) => (
                <li key={e.path || "_"} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded bg-muted/40 px-2 py-1 font-mono text-xs">
                    <span className="truncate text-muted-foreground" title={e.path}>
                        {e.path || t("settings.importWhole")}
                    </span>
                    <span className="truncate line-through decoration-muted-foreground/60" title={show(e, e.before)}>
                        <span className="sr-only">{t("settings.importBefore")} </span>
                        {show(e, e.before)}
                    </span>
                    <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
                    <span className="truncate text-foreground" title={show(e, e.after)}>
                        <span className="sr-only">{t("settings.importAfter")} </span>
                        {show(e, e.after)}
                    </span>
                </li>
            ))}
            {entries.length > MAX_ROWS && <li className="px-2 text-xs text-muted-foreground">{t("settings.importMore", { n: entries.length - MAX_ROWS })}</li>}
        </ul>
    );
}

export function ImportDialog() {
    const t = useT();
    const state = useFileDialogs((s) => s.importState);
    const setState = useFileDialogs((s) => s.setImportState);
    const run = useUndoStore((s) => s.run);
    const setStatus = useUndoStore((s) => s.setStatus);
    const present = useMemo(() => (state ? SECTION_IDS.filter((id) => state.file.sections[id] !== undefined) : []), [state]);
    const entries = useMemo(() => (state ? diff(state.current, state.file.sections) : []), [state]);
    const grouped = useMemo(() => groupDiff(entries, present), [entries, present]);
    const counts = useMemo(() => Object.fromEntries(SECTION_IDS.map((id) => [id, grouped[id].length])) as Record<SectionId, number>, [grouped]);
    const [picked, setPicked] = useState<SectionId[] | null>(null);
    const ticked = picked ?? present.filter((id) => !SENSITIVE_SECTIONS.includes(id) && counts[id] > 0);
    const [busy, setBusy] = useState(false);

    const close = () => {
        setState(null);
        setPicked(null);
    };

    const doApply = async () => {
        if (!state) return;
        setBusy(true);
        try {
            await run(t("settings.undoImport"), () => apply(pickSections(state.file.sections, ticked)));
            setStatus(t("settings.importDone", { n: ticked.length }));
            close();
        } finally {
            setBusy(false);
        }
    };

    const date = state?.file.exportedAt ? new Date(state.file.exportedAt).toLocaleString() : "—";

    return (
        <Dialog open={state !== null} onOpenChange={(o) => !o && close()}>
            <DialogContent size="lg" mobile="center" className="max-h-[88vh]">
                <DialogHeader>
                    <DialogTitle>{t("settings.importTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("settings.importDesc", { app: state?.file.app || "—", date })}
                    </DialogDescription>
                </DialogHeader>
                {entries.length === 0 ? (
                    <p className="text-sm text-muted-foreground" role="status">
                        {t("settings.importNoChanges")}
                    </p>
                ) : null}
                <SectionChecks ids={present} picked={ticked} onChange={setPicked} counts={counts} />
                {ticked.some((id) => SENSITIVE_SECTIONS.includes(id)) && <LibraryWarning />}
                <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                    <div className="grid gap-4">
                        {present
                            .filter((id) => ticked.includes(id))
                            .map((id) => (
                                <section key={id} aria-label={t(SECTION_LABEL[id])} className="grid gap-1.5">
                                    <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                                        {t(SECTION_LABEL[id])} · {t("settings.importCount", { n: counts[id] })}
                                    </h3>
                                    <DiffList entries={grouped[id]} />
                                </section>
                            ))}
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={close}>
                        {t("common.cancel")}
                    </Button>
                    <Button onClick={() => void doApply()} disabled={ticked.length === 0} loading={busy}>
                        {t("settings.importApply")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
