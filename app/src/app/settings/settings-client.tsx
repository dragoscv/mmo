"use client";

import { useState, useTransition, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { updateSetting } from "@/actions/settings";
import { importRekordboxAction, checkFileExists, getFileSize } from "@/actions/import";
import { useRenderCount } from "@/lib/dev-debugger";
import {
    Save,
    Loader2,
    FolderOpen,
    Music,
    FileDown,
    CheckCircle,
    Upload,
    Trash2,
    Plus,
    AlertCircle,
    HardDrive,
    Settings,
    FileText,
    X,
    FolderSearch,
    ArrowRight,
    MonitorPlay,
    RotateCcw,
    CloudOff,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { resetUserPreferences } from "@/actions/user-preferences";
import { clearSyncableLocalStorage } from "@/lib/syncable-keys";
import { useOfflineMode } from "@/hooks/use-offline";
import { ProfilesTab } from "@/components/settings/profiles-tab";
import { UserCircle2 } from "lucide-react";

interface SettingsClientProps {
    settings: Record<string, string>;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SettingsClient({ settings }: SettingsClientProps) {
    useRenderCount("Page:/settings");
    const [isPending, startTransition] = useTransition();
    const [activeTab, setActiveTab] = useState("general");
    const offline = useOfflineMode();

    // General settings
    const [musicRoot, setMusicRoot] = useState(settings.music_root || "H:\\Music");
    const [inboxFolder, setInboxFolder] = useState(settings.inbox_folder || "H:\\Music\\_Inbox");
    const [recordingsFolder, setRecordingsFolder] = useState(
        settings.recordings_folder || `${(settings.music_root || "H:\\Music")}\\Recordings`
    );
    const [restoreNowPlaying, setRestoreNowPlaying] = useState(() => {
        if (typeof window === "undefined") return false;
        return localStorage.getItem("mmo-restore-now-playing") === "true";
    });

    // Watch folders
    const [watchFolders, setWatchFolders] = useState<string[]>(
        settings.watch_folders ? JSON.parse(settings.watch_folders) : []
    );
    const [newWatchFolder, setNewWatchFolder] = useState("");

    // Genre mapping
    const [genreMapping, setGenreMapping] = useState<Record<string, string>>(
        settings.genre_folders ? JSON.parse(settings.genre_folders) : {}
    );
    const [newGenre, setNewGenre] = useState("");
    const [newGenreFolder, setNewGenreFolder] = useState("");

    // Import
    const [rekordboxPath, setRekordboxPath] = useState(settings.rekordbox_xml_path || "");
    const [importResult, setImportResult] = useState<{
        imported: number;
        updated: number;
        playlistsCreated: number;
    } | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [fileInfo, setFileInfo] = useState<{ exists: boolean; size: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Check file when path changes
    const checkFile = useCallback(async (path: string) => {
        if (!path) {
            setFileInfo(null);
            return;
        }
        const exists = await checkFileExists(path);
        const size = exists ? await getFileSize(path) : 0;
        setFileInfo({ exists, size });
    }, []);

    function handleSaveGeneral() {
        startTransition(async () => {
            await updateSetting("music_root", musicRoot);
            await updateSetting("inbox_folder", inboxFolder);
            await updateSetting("recordings_folder", recordingsFolder);
            toast.success("General settings saved!");
        });
    }

    function handleSaveFolders() {
        startTransition(async () => {
            await updateSetting("watch_folders", JSON.stringify(watchFolders));
            await updateSetting("genre_folders", JSON.stringify(genreMapping));
            toast.success("Folder settings saved!");
        });
    }

    function addWatchFolder() {
        const trimmed = newWatchFolder.trim();
        if (trimmed && !watchFolders.includes(trimmed)) {
            setWatchFolders([...watchFolders, trimmed]);
            setNewWatchFolder("");
        }
    }

    function removeWatchFolder(index: number) {
        setWatchFolders(watchFolders.filter((_, i) => i !== index));
    }

    function addGenreMapping() {
        if (newGenre.trim() && newGenreFolder.trim()) {
            setGenreMapping({ ...genreMapping, [newGenre.trim()]: newGenreFolder.trim() });
            setNewGenre("");
            setNewGenreFolder("");
        }
    }

    function removeGenreMapping(genre: string) {
        const next = { ...genreMapping };
        delete next[genre];
        setGenreMapping(next);
    }

    async function handleImport() {
        setIsImporting(true);
        setImportResult(null);
        try {
            const result = await importRekordboxAction(rekordboxPath || undefined);
            if (result.success) {
                setImportResult({
                    imported: result.imported,
                    updated: result.updated,
                    playlistsCreated: result.playlistsCreated,
                });
                toast.success(
                    `Import complete: ${result.imported} new, ${result.updated} updated, ${result.playlistsCreated} playlists`
                );
            } else {
                toast.error(result.error || "Import failed");
            }
        } catch (e) {
            toast.error(`Import error: ${e instanceof Error ? e.message : "Unknown"}`);
        } finally {
            setIsImporting(false);
        }
    }

    function handleSaveImportPath() {
        startTransition(async () => {
            if (rekordboxPath) {
                await updateSetting("rekordbox_xml_path", rekordboxPath);
                toast.success("Import path saved!");
            }
        });
    }

    function handleDrop(e: React.DragEvent) {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith(".xml")) {
            // For drag & drop we get the file object but need the path
            // In Electron context we'd have file.path, but in browser we can only get the name
            // Since this is a local app, use the webkitRelativePath or show file name
            const path = (file as unknown as { path?: string }).path;
            if (path) {
                setRekordboxPath(path);
                checkFile(path);
            } else {
                toast.info(`File "${file.name}" detected. Please enter the full path manually.`);
            }
        }
    }

    return (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="max-w-3xl">
            <TabsList className="mb-6 w-full grid grid-cols-5">
                <TabsTrigger value="general" className="gap-2">
                    <Settings className="h-3.5 w-3.5" />
                    General
                </TabsTrigger>
                <TabsTrigger value="profiles" className="gap-2">
                    <UserCircle2 className="h-3.5 w-3.5" />
                    Profiles
                </TabsTrigger>
                <TabsTrigger value="folders" className="gap-2">
                    <FolderOpen className="h-3.5 w-3.5" />
                    Folders
                </TabsTrigger>
                <TabsTrigger value="import" className="gap-2">
                    <FileDown className="h-3.5 w-3.5" />
                    Import
                </TabsTrigger>
                <TabsTrigger value="offline" className="gap-2">
                    <CloudOff className="h-3.5 w-3.5" />
                    Offline
                </TabsTrigger>
            </TabsList>

            {/* ===== PROFILES TAB ===== */}
            <TabsContent value="profiles">
                <ProfilesTab />
            </TabsContent>

            {/* ===== GENERAL TAB ===== */}
            <TabsContent value="general" className="space-y-4 animate-[fadeIn_200ms_ease-out]">
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Music className="h-4 w-4 text-purple-400" />
                            Music Root
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="flex gap-2">
                            <Input
                                value={musicRoot}
                                onChange={(e) => setMusicRoot(e.target.value)}
                                placeholder="H:\Music"
                                className="flex-1"
                            />
                            <Button
                                variant="outline"
                                size="icon"
                                className="shrink-0"
                                onClick={() => {
                                    // Open native folder dialog via a hidden input
                                    const input = document.createElement("input");
                                    input.type = "file";
                                    input.setAttribute("webkitdirectory", "");
                                    input.onchange = () => {
                                        const files = input.files;
                                        if (files && files.length > 0) {
                                            // Extract the folder path from the first file's webkitRelativePath
                                            const relativePath = files[0].webkitRelativePath;
                                            const folderName = relativePath.split("/")[0];
                                            setMusicRoot(folderName);
                                            toast.info(`Selected folder: ${folderName}. You may need to enter the full path.`);
                                        }
                                    };
                                    input.click();
                                }}
                            >
                                <FolderSearch className="h-4 w-4" />
                            </Button>
                        </div>
                        <p className="text-xs text-[var(--muted-foreground)]">
                            Main folder where all your music is stored.
                        </p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <FolderOpen className="h-4 w-4 text-blue-400" />
                            Inbox Folder
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="flex gap-2">
                            <Input
                                value={inboxFolder}
                                onChange={(e) => setInboxFolder(e.target.value)}
                                placeholder="H:\Music\_Inbox"
                                className="flex-1"
                            />
                            <Button variant="outline" size="icon" className="shrink-0">
                                <FolderSearch className="h-4 w-4" />
                            </Button>
                        </div>
                        <p className="text-xs text-[var(--muted-foreground)]">
                            Where new tracks arrive before processing.
                        </p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <FolderOpen className="h-4 w-4 text-rose-400" />
                            Recordings Folder
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="flex gap-2">
                            <Input
                                value={recordingsFolder}
                                onChange={(e) => setRecordingsFolder(e.target.value)}
                                placeholder="H:\Music\Recordings"
                                className="flex-1"
                            />
                            <Button variant="outline" size="icon" className="shrink-0">
                                <FolderSearch className="h-4 w-4" />
                            </Button>
                        </div>
                        <p className="text-xs text-[var(--muted-foreground)]">
                            Auto-saved sessions from Live, Mixer, DAW, and Editor land here. Folder is created if it doesn&apos;t exist.
                        </p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <MonitorPlay className="h-4 w-4 text-cyan-400" />
                            Playback
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <p className="text-sm font-medium">
                                    Restore Now Playing on refresh
                                </p>
                                <p className="text-xs text-[var(--muted-foreground)]">
                                    When enabled, the Now Playing view will reopen automatically after a page refresh.
                                </p>
                            </div>
                            <button
                                onClick={() => {
                                    const next = !restoreNowPlaying;
                                    setRestoreNowPlaying(next);
                                    localStorage.setItem("mmo-restore-now-playing", String(next));
                                    toast.success(next ? "Now Playing will restore on refresh" : "Now Playing won't restore on refresh");
                                }}
                                className={cn(
                                    "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200",
                                    restoreNowPlaying ? "bg-purple-500" : "bg-[var(--muted)]"
                                )}
                            >
                                <span
                                    className={cn(
                                        "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform duration-200",
                                        restoreNowPlaying ? "translate-x-5" : "translate-x-0"
                                    )}
                                />
                            </button>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <RotateCcw className="h-4 w-4 text-red-400" />
                            Reset Preferences
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <p className="text-xs text-[var(--muted-foreground)]">
                            Reset all UI preferences (theme, personalization, DAW settings, MIDI, FX presets) to their default values.
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-2 text-red-400 hover:text-red-300 hover:border-red-500/50"
                            onClick={async () => {
                                clearSyncableLocalStorage();
                                try {
                                    await resetUserPreferences();
                                } catch { /* ignore if not authenticated */ }
                                toast.success("All preferences reset to defaults. Reload to apply.");
                            }}
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Reset All to Defaults
                        </Button>
                    </CardContent>
                </Card>

                <Button
                    onClick={handleSaveGeneral}
                    disabled={isPending}
                    className="w-full"
                >
                    {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save General Settings
                </Button>
            </TabsContent>

            {/* ===== FOLDERS TAB ===== */}
            <TabsContent value="folders" className="space-y-4 animate-[fadeIn_200ms_ease-out]">
                {/* Watch Folders */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <HardDrive className="h-4 w-4 text-emerald-400" />
                            Watch Folders
                            <span className="ml-auto text-xs font-normal text-[var(--muted-foreground)]">
                                {watchFolders.length} folder{watchFolders.length !== 1 ? "s" : ""}
                            </span>
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {watchFolders.length > 0 ? (
                            <div className="space-y-1.5">
                                {watchFolders.map((folder, idx) => (
                                    <div
                                        key={idx}
                                        className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 group transition-colors hover:border-[var(--ring)]"
                                    >
                                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
                                        <span className="text-sm font-mono truncate flex-1">{folder}</span>
                                        <button
                                            onClick={() => removeWatchFolder(idx)}
                                            className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--destructive)] hover:text-red-400 cursor-pointer"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-center py-4 text-sm text-[var(--muted-foreground)]">
                                No watch folders configured. Add one below.
                            </div>
                        )}

                        <div className="flex gap-2">
                            <Input
                                value={newWatchFolder}
                                onChange={(e) => setNewWatchFolder(e.target.value)}
                                placeholder="Enter folder path..."
                                className="flex-1"
                                onKeyDown={(e) => e.key === "Enter" && addWatchFolder()}
                            />
                            <Button variant="outline" size="icon" onClick={addWatchFolder} className="shrink-0">
                                <Plus className="h-4 w-4" />
                            </Button>
                        </div>
                        <p className="text-xs text-[var(--muted-foreground)]">
                            These folders appear as quick-scan buttons in the Scanner page.
                        </p>
                    </CardContent>
                </Card>

                {/* Genre → Folder Mapping */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <FileText className="h-4 w-4 text-amber-400" />
                            Genre → Folder Mapping
                            <span className="ml-auto text-xs font-normal text-[var(--muted-foreground)]">
                                {Object.keys(genreMapping).length} mapping{Object.keys(genreMapping).length !== 1 ? "s" : ""}
                            </span>
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {Object.keys(genreMapping).length > 0 ? (
                            <div className="space-y-1.5">
                                {Object.entries(genreMapping).map(([genre, folder]) => (
                                    <div
                                        key={genre}
                                        className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 group transition-colors hover:border-[var(--ring)]"
                                    >
                                        <span className="text-sm font-medium min-w-[100px]">{genre}</span>
                                        <ArrowRight className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
                                        <span className="text-sm font-mono text-[var(--muted-foreground)] truncate flex-1">{folder}</span>
                                        <button
                                            onClick={() => removeGenreMapping(genre)}
                                            className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--destructive)] hover:text-red-400 cursor-pointer"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-center py-4 text-sm text-[var(--muted-foreground)]">
                                No genre mappings configured.
                            </div>
                        )}

                        <div className="flex flex-wrap gap-2">
                            <Input
                                value={newGenre}
                                onChange={(e) => setNewGenre(e.target.value)}
                                placeholder="Genre name"
                                className="w-28 sm:w-36"
                            />
                            <Input
                                value={newGenreFolder}
                                onChange={(e) => setNewGenreFolder(e.target.value)}
                                placeholder="Relative folder path"
                                className="flex-1"
                                onKeyDown={(e) => e.key === "Enter" && addGenreMapping()}
                            />
                            <Button variant="outline" size="icon" onClick={addGenreMapping} className="shrink-0">
                                <Plus className="h-4 w-4" />
                            </Button>
                        </div>
                        <p className="text-xs text-[var(--muted-foreground)]">
                            Maps genres to sub-folders relative to Music Root.
                        </p>
                    </CardContent>
                </Card>

                <Button
                    onClick={handleSaveFolders}
                    disabled={isPending}
                    className="w-full"
                >
                    {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save Folder Settings
                </Button>
            </TabsContent>

            {/* ===== IMPORT TAB ===== */}
            <TabsContent value="import" className="space-y-4 animate-[fadeIn_200ms_ease-out]">
                <Card className="border-purple-500/30">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <FileDown className="h-4 w-4 text-purple-400" />
                            Rekordbox XML Import
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {/* Drag & Drop Zone */}
                        <div
                            onDrop={handleDrop}
                            onDragOver={(e) => {
                                e.preventDefault();
                                setDragOver(true);
                            }}
                            onDragLeave={() => setDragOver(false)}
                            className={cn(
                                "rounded-xl border-2 border-dashed py-8 px-4 text-center transition-all duration-200 cursor-pointer",
                                dragOver
                                    ? "border-purple-500 bg-purple-500/10 scale-[1.01]"
                                    : "border-[var(--border)] hover:border-[var(--muted-foreground)] hover:bg-[var(--accent)]"
                            )}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".xml"
                                className="hidden"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) {
                                        const path = (file as unknown as { path?: string }).path;
                                        if (path) {
                                            setRekordboxPath(path);
                                            checkFile(path);
                                        } else {
                                            toast.info(`File "${file.name}" selected. Please verify the full path below.`);
                                        }
                                    }
                                }}
                            />
                            <Upload className={cn(
                                "h-10 w-10 mx-auto mb-3 transition-colors",
                                dragOver ? "text-purple-400" : "text-[var(--muted-foreground)]"
                            )} />
                            <p className="text-sm font-medium">
                                {dragOver ? "Drop XML file here" : "Click or drag & drop a rekordbox XML"}
                            </p>
                            <p className="text-xs text-[var(--muted-foreground)] mt-1">
                                File → Export Collection in xml format from rekordbox
                            </p>
                        </div>

                        {/* Path Input */}
                        <div className="space-y-2">
                            <label className="text-xs font-medium text-[var(--muted-foreground)]">
                                Or enter the file path directly:
                            </label>
                            <div className="flex gap-2">
                                <Input
                                    value={rekordboxPath}
                                    onChange={(e) => {
                                        setRekordboxPath(e.target.value);
                                        checkFile(e.target.value);
                                    }}
                                    placeholder="H:\rekordbox\exports\playlists\all collection.xml"
                                    className="flex-1 font-mono text-xs"
                                />
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleSaveImportPath}
                                    disabled={isPending || !rekordboxPath}
                                    className="shrink-0"
                                >
                                    <Save className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                        </div>

                        {/* File Info */}
                        {fileInfo && (
                            <div className={cn(
                                "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all animate-[fadeIn_200ms_ease-out]",
                                fileInfo.exists
                                    ? "bg-green-500/10 border border-green-500/20 text-green-400"
                                    : "bg-red-500/10 border border-red-500/20 text-red-400"
                            )}>
                                {fileInfo.exists ? (
                                    <>
                                        <CheckCircle className="h-4 w-4 shrink-0" />
                                        <span>File found — {formatBytes(fileInfo.size)}</span>
                                    </>
                                ) : (
                                    <>
                                        <AlertCircle className="h-4 w-4 shrink-0" />
                                        <span>File not found at this path</span>
                                    </>
                                )}
                            </div>
                        )}

                        {/* Import Button */}
                        <Button
                            onClick={handleImport}
                            disabled={isImporting || !rekordboxPath}
                            className="w-full"
                            size="lg"
                        >
                            {isImporting ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Importing... (this may take a while for large collections)
                                </>
                            ) : (
                                <>
                                    <FileDown className="mr-2 h-4 w-4" />
                                    Import from Rekordbox
                                </>
                            )}
                        </Button>

                        {/* Import Result */}
                        {importResult && (
                            <div className="rounded-xl bg-green-500/10 border border-green-500/20 p-4 animate-[fadeIn_200ms_ease-out]">
                                <div className="flex items-center gap-2 mb-3">
                                    <CheckCircle className="h-5 w-5 text-green-500" />
                                    <span className="text-sm font-semibold text-green-500">Import Complete!</span>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
                                    <div className="rounded-lg bg-[var(--background)] p-3">
                                        <p className="text-2xl font-bold">{importResult.imported}</p>
                                        <p className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider">New Tracks</p>
                                    </div>
                                    <div className="rounded-lg bg-[var(--background)] p-3">
                                        <p className="text-2xl font-bold">{importResult.updated}</p>
                                        <p className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider">Updated</p>
                                    </div>
                                    <div className="rounded-lg bg-[var(--background)] p-3">
                                        <p className="text-2xl font-bold">{importResult.playlistsCreated}</p>
                                        <p className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider">Playlists</p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Quick Paths */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium text-[var(--muted-foreground)]">
                            Common Rekordbox XML Locations
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1.5">
                        {[
                            "C:\\Users\\vladu\\AppData\\Roaming\\Pioneer\\rekordbox\\rekordbox.xml",
                            "H:\\rekordbox\\exports\\playlists\\all collection.xml",
                        ].map((p) => (
                            <button
                                key={p}
                                onClick={() => {
                                    setRekordboxPath(p);
                                    checkFile(p);
                                }}
                                className="w-full text-left rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs font-mono text-[var(--muted-foreground)] hover:border-purple-500/50 hover:text-[var(--foreground)] transition-colors cursor-pointer"
                            >
                                {p}
                            </button>
                        ))}
                    </CardContent>
                </Card>
            </TabsContent>

            {/* ===== OFFLINE TAB ===== */}
            <TabsContent value="offline" className="space-y-4 animate-[fadeIn_200ms_ease-out]">
                {/* Offline Toggle */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <CloudOff className="h-4 w-4 text-blue-400" />
                            Offline Mode
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium">Enable Offline Mode</p>
                                <p className="text-xs text-muted-foreground">
                                    Cache audio files locally for offline playback
                                </p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={offline.settings.enabled}
                                onClick={() => offline.updateSettings({ enabled: !offline.settings.enabled })}
                                className={cn(
                                    "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200",
                                    offline.settings.enabled ? "bg-purple-500" : "bg-[var(--muted)]"
                                )}
                            >
                                <span
                                    className={cn(
                                        "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform duration-200",
                                        offline.settings.enabled ? "translate-x-5" : "translate-x-0"
                                    )}
                                />
                            </button>
                        </div>

                        {/* Storage allocation */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Storage Limit</label>
                            <div className="flex items-center gap-3">
                                <input
                                    type="range"
                                    min="256"
                                    max="10240"
                                    step="256"
                                    value={offline.settings.maxStorageMB}
                                    onChange={(e) => offline.updateSettings({ maxStorageMB: parseInt(e.target.value) })}
                                    className="flex-1 accent-purple-500"
                                    disabled={!offline.settings.enabled}
                                />
                                <span className="text-sm font-mono w-16 text-right">
                                    {offline.settings.maxStorageMB >= 1024
                                        ? `${(offline.settings.maxStorageMB / 1024).toFixed(1)} GB`
                                        : `${offline.settings.maxStorageMB} MB`}
                                </span>
                            </div>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span>256 MB</span>
                                <span>10 GB</span>
                            </div>
                        </div>

                        {/* Auto download count */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Auto-Download Tracks</label>
                            <p className="text-xs text-muted-foreground">
                                Automatically cache your most recently played tracks for offline use
                            </p>
                            <div className="flex items-center gap-3">
                                <input
                                    type="range"
                                    min="0"
                                    max="200"
                                    step="10"
                                    value={offline.settings.autoDownloadCount}
                                    onChange={(e) => offline.updateSettings({ autoDownloadCount: parseInt(e.target.value) })}
                                    className="flex-1 accent-purple-500"
                                    disabled={!offline.settings.enabled}
                                />
                                <span className="text-sm font-mono w-16 text-right">
                                    {offline.settings.autoDownloadCount} tracks
                                </span>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Cache Status */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <HardDrive className="h-4 w-4 text-emerald-400" />
                            Cache Status
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="grid grid-cols-3 gap-3">
                            <div className="rounded-lg bg-muted/50 p-3 text-center">
                                <p className="text-2xl font-bold">{offline.cachedTracks.length}</p>
                                <p className="text-xs text-muted-foreground">Cached Tracks</p>
                            </div>
                            <div className="rounded-lg bg-muted/50 p-3 text-center">
                                <p className="text-2xl font-bold">
                                    {offline.totalSize >= 1024 * 1024 * 1024
                                        ? `${(offline.totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB`
                                        : `${(offline.totalSize / (1024 * 1024)).toFixed(0)} MB`}
                                </p>
                                <p className="text-xs text-muted-foreground">Used Space</p>
                            </div>
                            <div className="rounded-lg bg-muted/50 p-3 text-center">
                                <p className="text-2xl font-bold">
                                    {Math.round(
                                        (offline.totalSize / (offline.settings.maxStorageMB * 1024 * 1024)) * 100
                                    ) || 0}%
                                </p>
                                <p className="text-xs text-muted-foreground">Capacity</p>
                            </div>
                        </div>

                        {/* Progress bar */}
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                            <div
                                className="h-full bg-purple-500 rounded-full transition-all duration-300"
                                style={{
                                    width: `${Math.min(
                                        100,
                                        (offline.totalSize / (offline.settings.maxStorageMB * 1024 * 1024)) * 100
                                    )}%`,
                                }}
                            />
                        </div>

                        {offline.isDownloading && offline.downloadProgress && (
                            <div className="flex items-center gap-3 rounded-lg border border-purple-500/20 bg-purple-500/5 p-3">
                                <Loader2 className="h-4 w-4 animate-spin text-purple-400" />
                                <div className="flex-1">
                                    <p className="text-sm">
                                        Downloading... {offline.downloadProgress.current}/{offline.downloadProgress.total}
                                    </p>
                                </div>
                                <Button size="xs" variant="ghost" onClick={offline.cancelDownload}>
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        )}

                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-2 text-red-400 hover:text-red-300 hover:border-red-500/50"
                            onClick={() => {
                                if (confirm("Clear all offline cached tracks?")) {
                                    offline.clearAll();
                                    toast.success("Offline cache cleared");
                                }
                            }}
                            disabled={offline.cachedTracks.length === 0}
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            Clear Offline Cache
                        </Button>
                    </CardContent>
                </Card>
            </TabsContent>
        </Tabs>
    );
}
