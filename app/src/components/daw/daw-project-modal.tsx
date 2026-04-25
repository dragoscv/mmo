"use client";

import { useState, useEffect } from "react";
import { useDAW } from "./daw-context";
import { cn } from "@/lib/utils";
import { X, Plus, FolderOpen, Trash2, Copy, Music, Clock, Layers, Search } from "lucide-react";
import { listProjects, deleteProject, loadProject, saveProject, createId } from "@/lib/daw-engine";
import type { DAWProject } from "@/lib/daw-engine";

type ProjectInfo = { id: string; name: string; modifiedAt: number; tempo: number; trackCount: number };

export function DAWProjectModal() {
    const daw = useDAW();
    const [projects, setProjects] = useState<ProjectInfo[]>([]);
    const [tab, setTab] = useState<"open" | "new">("open");
    const [newName, setNewName] = useState("");
    const [search, setSearch] = useState("");
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    useEffect(() => {
        if (daw.showProjectModal) {
            setProjects(listProjects());
            setSearch("");
            setConfirmDeleteId(null);
        }
    }, [daw.showProjectModal]);

    if (!daw.showProjectModal) return null;

    const filtered = search
        ? projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
        : projects;

    const handleNew = () => {
        const name = newName.trim() || "Untitled Project";
        daw.newProject(name);
        daw.setProjectModal(false);
    };

    const handleOpen = (id: string) => {
        daw.openProject(id);
        daw.setProjectModal(false);
    };

    const handleDuplicate = (p: ProjectInfo) => {
        const original = loadProject(p.id);
        if (!original) return;
        const dup: DAWProject = {
            ...original,
            id: createId(),
            name: `${original.name} (Copy)`,
            createdAt: Date.now(),
            modifiedAt: Date.now(),
        };
        saveProject(dup);
        setProjects(listProjects());
    };

    const handleDelete = (id: string) => {
        if (confirmDeleteId === id) {
            deleteProject(id);
            setProjects(listProjects());
            setConfirmDeleteId(null);
        } else {
            setConfirmDeleteId(id);
        }
    };

    const formatDate = (ts: number) => {
        const diff = Date.now() - ts;
        if (diff < 60000) return "Just now";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3 sm:p-4" onClick={() => daw.setProjectModal(false)}>
            <div
                className="w-full max-w-[520px] max-h-[calc(100dvh-1.5rem)] sm:max-h-[80vh] bg-[var(--daw-bg)] border border-[var(--daw-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                    <h2 className="text-sm font-medium text-white/80">Project Manager</h2>
                    <button
                        onClick={() => daw.setProjectModal(false)}
                        className="w-6 h-6 rounded flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-white/10">
                    {(["open", "new"] as const).map(t => (
                        <button
                            key={t}
                            onClick={() => setTab(t)}
                            className={cn(
                                "flex-1 h-9 text-xs transition-colors",
                                tab === t ? "text-white/80 border-b-2 border-purple-500" : "text-white/30 hover:text-white/50"
                            )}
                        >
                            {t === "open" ? "Open Project" : "New Project"}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto">
                    {tab === "new" ? (
                        <div className="p-4 space-y-4">
                            <div>
                                <label className="text-[10px] text-white/30 uppercase block mb-1">Project Name</label>
                                <input
                                    type="text"
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                    placeholder="My New Project"
                                    className="w-full h-8 px-3 bg-black/30 border border-white/10 rounded text-sm text-white/70 placeholder:text-white/20 focus:outline-none focus:border-purple-500/50"
                                    autoFocus
                                    onKeyDown={e => e.key === "Enter" && handleNew()}
                                />
                            </div>

                            <div className="text-[10px] text-white/20">
                                Creates a new project with default tracks (Audio, MIDI, Synth, Drums, Return).
                            </div>

                            <button
                                onClick={handleNew}
                                className="w-full h-9 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5"
                            >
                                <Plus className="h-3.5 w-3.5" /> Create Project
                            </button>
                        </div>
                    ) : (
                        <div className="p-3">
                            {/* Search */}
                            {projects.length > 3 && (
                                <div className="relative mb-3">
                                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/20" />
                                    <input
                                        type="text"
                                        value={search}
                                        onChange={e => setSearch(e.target.value)}
                                        placeholder="Search projects..."
                                        className="w-full h-7 pl-8 pr-3 bg-black/20 border border-white/[0.06] rounded text-xs text-white/60 placeholder:text-white/15 focus:outline-none focus:border-purple-500/30"
                                    />
                                </div>
                            )}

                            {filtered.length === 0 ? (
                                <div className="text-center py-10">
                                    <Music className="h-8 w-8 text-white/10 mx-auto mb-2" />
                                    <p className="text-xs text-white/20">{search ? "No matching projects" : "No saved projects"}</p>
                                    <p className="text-[10px] text-white/10 mt-1">Create a new project to get started</p>
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    {filtered.map(p => {
                                        const isCurrent = p.id === daw.project.id;
                                        return (
                                            <div
                                                key={p.id}
                                                className={cn(
                                                    "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer group transition-all",
                                                    isCurrent
                                                        ? "bg-purple-500/10 border border-purple-500/20"
                                                        : "hover:bg-white/5 border border-transparent"
                                                )}
                                                onClick={() => !isCurrent && handleOpen(p.id)}
                                            >
                                                <div className={cn(
                                                    "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0",
                                                    isCurrent ? "bg-purple-500/20" : "bg-white/5"
                                                )}>
                                                    <FolderOpen className={cn("h-4 w-4", isCurrent ? "text-purple-400" : "text-white/20")} />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1.5">
                                                        <p className="text-xs text-white/70 truncate">{p.name}</p>
                                                        {isCurrent && (
                                                            <span className="text-[8px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 flex-shrink-0">
                                                                Current
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-0.5">
                                                        <span className="text-[9px] text-white/20 flex items-center gap-0.5">
                                                            <Clock className="h-2.5 w-2.5" /> {formatDate(p.modifiedAt)}
                                                        </span>
                                                        <span className="text-[9px] text-white/20">{p.tempo} BPM</span>
                                                        <span className="text-[9px] text-white/20 flex items-center gap-0.5">
                                                            <Layers className="h-2.5 w-2.5" /> {p.trackCount}
                                                        </span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button
                                                        onClick={e => { e.stopPropagation(); handleDuplicate(p); }}
                                                        className="w-7 h-7 flex items-center justify-center rounded text-white/20 hover:text-purple-400 hover:bg-purple-500/10 transition-colors"
                                                        title="Duplicate"
                                                    >
                                                        <Copy className="h-3.5 w-3.5" />
                                                    </button>
                                                    <button
                                                        onClick={e => { e.stopPropagation(); handleDelete(p.id); }}
                                                        className={cn(
                                                            "w-7 h-7 flex items-center justify-center rounded transition-colors",
                                                            confirmDeleteId === p.id
                                                                ? "bg-red-500/20 text-red-400"
                                                                : "text-white/20 hover:text-red-400 hover:bg-red-500/10"
                                                        )}
                                                        title={confirmDeleteId === p.id ? "Click again to confirm" : "Delete"}
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-2.5 border-t border-white/[0.06] flex items-center justify-between">
                    <span className="text-[9px] text-white/15">{projects.length} project{projects.length !== 1 ? "s" : ""} saved</span>
                    {daw.isDirty && (
                        <span className="text-[9px] text-amber-400/60">Current project has unsaved changes</span>
                    )}
                </div>
            </div>
        </div>
    );
}
