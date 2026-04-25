"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    Check,
    Copy,
    Download,
    Loader2,
    Pencil,
    Plus,
    Trash2,
    Upload,
    UserCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
    activateProfile,
    createProfile,
    deleteProfile,
    duplicateProfile,
    exportProfile,
    importProfile,
    listProfiles,
    renameProfile,
    type ProfileSummary,
} from "@/actions/profiles";
import { applyActiveProfileToLocalStorage } from "@/hooks/use-preferences-sync";

type EditState = { id: string; name: string; description: string } | null;

export function ProfilesTab() {
    const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [isPending, startTransition] = useTransition();
    const [createOpen, setCreateOpen] = useState(false);
    const [createName, setCreateName] = useState("");
    const [createDescription, setCreateDescription] = useState("");
    const [editState, setEditState] = useState<EditState>(null);
    const [duplicateState, setDuplicateState] = useState<{ id: string; name: string } | null>(null);
    const [deleteState, setDeleteState] = useState<ProfileSummary | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    async function refresh() {
        try {
            const list = await listProfiles();
            setProfiles(list);
        } catch {
            toast.error("Failed to load profiles");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void refresh();
    }, []);

    function handleCreate() {
        startTransition(async () => {
            const result = await createProfile(createName, createDescription);
            if (result.success) {
                toast.success(`Created profile "${createName}"`);
                setCreateOpen(false);
                setCreateName("");
                setCreateDescription("");
                await refresh();
            } else {
                toast.error(result.error || "Failed to create profile");
            }
        });
    }

    function handleRename() {
        if (!editState) return;
        startTransition(async () => {
            const result = await renameProfile(editState.id, editState.name, editState.description);
            if (result.success) {
                toast.success("Profile updated");
                setEditState(null);
                await refresh();
            } else {
                toast.error(result.error || "Failed to update");
            }
        });
    }

    function handleActivate(p: ProfileSummary) {
        if (p.isActive) return;
        startTransition(async () => {
            const result = await activateProfile(p.id);
            if (result.success) {
                await applyActiveProfileToLocalStorage();
                toast.success(`Switched to "${p.name}"`);
                await refresh();
            } else {
                toast.error(result.error || "Failed to switch");
            }
        });
    }

    function handleDuplicate() {
        if (!duplicateState) return;
        startTransition(async () => {
            const result = await duplicateProfile(duplicateState.id, duplicateState.name);
            if (result.success) {
                toast.success("Profile duplicated");
                setDuplicateState(null);
                await refresh();
            } else {
                toast.error(result.error || "Failed to duplicate");
            }
        });
    }

    function handleDelete() {
        if (!deleteState) return;
        const target = deleteState;
        startTransition(async () => {
            const result = await deleteProfile(target.id);
            if (result.success) {
                if (result.newActiveId) {
                    await applyActiveProfileToLocalStorage();
                }
                toast.success(`Deleted "${target.name}"`);
                setDeleteState(null);
                await refresh();
            } else {
                toast.error(result.error || "Failed to delete");
            }
        });
    }

    async function handleExport(p: ProfileSummary) {
        const result = await exportProfile(p.id);
        if (!result.success || !result.data) {
            toast.error(result.error || "Export failed");
            return;
        }
        const blob = new Blob([JSON.stringify(result.data, null, 2)], {
            type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const safeName = p.name.replace(/[^a-z0-9-_]+/gi, "_");
        const stamp = new Date().toISOString().slice(0, 10);
        const a = document.createElement("a");
        a.href = url;
        a.download = `profile-${safeName}-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.success(`Exported "${p.name}"`);
    }

    function handleImportClick() {
        fileInputRef.current?.click();
    }

    async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        try {
            const text = await file.text();
            const payload = JSON.parse(text);
            const baseName =
                typeof payload?.name === "string" ? payload.name : file.name.replace(/\.json$/i, "");
            const result = await importProfile(payload, { name: baseName });
            if (result.success) {
                toast.success(`Imported "${baseName}"`);
                await refresh();
            } else {
                toast.error(result.error || "Import failed");
            }
        } catch {
            toast.error("Invalid profile file");
        }
    }

    return (
        <div className="space-y-4 animate-[fadeIn_200ms_ease-out]">
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <UserCircle2 className="h-4 w-4 text-purple-400" />
                        Profiles
                        <span className="ml-auto text-xs font-normal text-[var(--muted-foreground)]">
                            {profiles.length} profile{profiles.length !== 1 ? "s" : ""}
                        </span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <p className="text-xs text-[var(--muted-foreground)]">
                        A profile bundles all your UI state — window/panel layouts, mixer & EQ
                        settings, FX chains, MIDI mapping, theme, sidebar, DAW projects layout, and
                        every other per-app preference. Switch profiles to instantly load a different
                        set-up; export to back up or move between machines.
                    </p>

                    {loading ? (
                        <div className="flex items-center justify-center py-6 text-sm text-[var(--muted-foreground)]">
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
                        </div>
                    ) : profiles.length === 0 ? (
                        <div className="text-center py-6 text-sm text-[var(--muted-foreground)]">
                            Sign in to manage profiles.
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {profiles.map((p) => (
                                <div
                                    key={p.id}
                                    className={cn(
                                        "group rounded-lg border bg-[var(--background)] p-3 transition-colors",
                                        p.isActive
                                            ? "border-purple-500/60 bg-purple-500/5"
                                            : "border-[var(--border)] hover:border-[var(--ring)]",
                                    )}
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="text-sm font-medium truncate">
                                                    {p.name}
                                                </span>
                                                {p.isActive && (
                                                    <Badge
                                                        variant="outline"
                                                        className="text-[10px] py-0 h-4 border-purple-500/60 text-purple-300"
                                                    >
                                                        <Check className="h-2.5 w-2.5 mr-0.5" /> Active
                                                    </Badge>
                                                )}
                                                <span className="text-[10px] text-[var(--muted-foreground)]">
                                                    {p.entryCount} {p.entryCount === 1 ? "setting" : "settings"}
                                                </span>
                                            </div>
                                            {p.description && (
                                                <p className="text-xs text-[var(--muted-foreground)] mt-1 line-clamp-2">
                                                    {p.description}
                                                </p>
                                            )}
                                        </div>

                                        <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                                            {!p.isActive && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => handleActivate(p)}
                                                    disabled={isPending}
                                                    className="h-7 px-2 text-xs"
                                                    title="Activate"
                                                >
                                                    <Check className="h-3 w-3 mr-1" /> Activate
                                                </Button>
                                            )}
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() =>
                                                    setEditState({
                                                        id: p.id,
                                                        name: p.name,
                                                        description: p.description ?? "",
                                                    })
                                                }
                                                title="Rename"
                                            >
                                                <Pencil className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() => setDuplicateState({ id: p.id, name: `${p.name} (copy)` })}
                                                title="Duplicate"
                                            >
                                                <Copy className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() => handleExport(p)}
                                                title="Export"
                                            >
                                                <Download className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7 text-red-400 hover:text-red-300"
                                                onClick={() => setDeleteState(p)}
                                                disabled={profiles.length <= 1}
                                                title={profiles.length <= 1 ? "Cannot delete the last profile" : "Delete"}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                            size="sm"
                            onClick={() => setCreateOpen(true)}
                            className="gap-1.5"
                        >
                            <Plus className="h-3.5 w-3.5" /> New Profile
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={handleImportClick}
                            className="gap-1.5"
                        >
                            <Upload className="h-3.5 w-3.5" /> Import
                        </Button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".json,application/json"
                            className="hidden"
                            onChange={handleImportFile}
                        />
                    </div>
                </CardContent>
            </Card>

            {/* Create dialog */}
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>New Profile</DialogTitle>
                        <DialogDescription>
                            A new empty profile. Activate it to start saving your current
                            UI state into it.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <label className="text-xs font-medium">Name</label>
                            <Input
                                value={createName}
                                onChange={(e) => setCreateName(e.target.value)}
                                placeholder="Studio, Live Set, Travel…"
                                autoFocus
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-medium">Description (optional)</label>
                            <Textarea
                                value={createDescription}
                                onChange={(e) => setCreateDescription(e.target.value)}
                                placeholder="What this profile is for"
                                rows={2}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setCreateOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleCreate} disabled={isPending || !createName.trim()}>
                            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            Create
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Rename dialog */}
            <Dialog open={editState !== null} onOpenChange={(o) => !o && setEditState(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Edit Profile</DialogTitle>
                    </DialogHeader>
                    {editState && (
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <label className="text-xs font-medium">Name</label>
                                <Input
                                    value={editState.name}
                                    onChange={(e) =>
                                        setEditState({ ...editState, name: e.target.value })
                                    }
                                    autoFocus
                                />
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs font-medium">Description</label>
                                <Textarea
                                    value={editState.description}
                                    onChange={(e) =>
                                        setEditState({ ...editState, description: e.target.value })
                                    }
                                    rows={2}
                                />
                            </div>
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setEditState(null)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handleRename}
                            disabled={isPending || !editState?.name.trim()}
                        >
                            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Duplicate dialog */}
            <Dialog
                open={duplicateState !== null}
                onOpenChange={(o) => !o && setDuplicateState(null)}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Duplicate Profile</DialogTitle>
                        <DialogDescription>
                            Creates a copy of all settings under a new name.
                        </DialogDescription>
                    </DialogHeader>
                    {duplicateState && (
                        <div className="space-y-1">
                            <label className="text-xs font-medium">New name</label>
                            <Input
                                value={duplicateState.name}
                                onChange={(e) =>
                                    setDuplicateState({ ...duplicateState, name: e.target.value })
                                }
                                autoFocus
                            />
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDuplicateState(null)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handleDuplicate}
                            disabled={isPending || !duplicateState?.name.trim()}
                        >
                            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            Duplicate
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete confirmation */}
            <AlertDialog open={deleteState !== null} onOpenChange={(o) => !o && setDeleteState(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete profile?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {deleteState?.name
                                ? `This permanently removes "${deleteState.name}" and all of its saved settings. This cannot be undone.`
                                : ""}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleDelete}
                            disabled={isPending}
                            className="bg-red-600 hover:bg-red-700"
                        >
                            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
