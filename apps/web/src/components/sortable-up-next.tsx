"use client";

/** Sortable Up Next list using @dnd-kit. Pulls queue from PlayerContext;
 *  drag to reorder, click to play, X to remove. */

import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Heart, X } from "lucide-react";
import { usePlayer } from "@/components/player-context";
import type { Track } from "@/db/schema";
import { cn } from "@/lib/utils";

function formatDuration(s: number | null | undefined): string {
    if (s == null || !isFinite(s)) return "—";
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
}

function Row({ track, queueIndex }: { track: Track; queueIndex: number }) {
    const player = usePlayer();
    const id = `${track.id}-${queueIndex}`;
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={cn(
                "flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors group cursor-pointer",
                isDragging && "ring-1 ring-purple-500/40 bg-white/[0.04]"
            )}
            onClick={() => player.playFromQueue(queueIndex)}
        >
            <button
                type="button"
                {...attributes}
                {...listeners}
                onClick={(e) => e.stopPropagation()}
                className="touch-none cursor-grab active:cursor-grabbing text-white/20 hover:text-white/60 transition-colors p-1"
                aria-label="Drag to reorder"
            >
                <GripVertical className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{track.title || track.filename}</p>
                <p className="text-xs text-white/40 truncate">{track.artist || "Unknown"}</p>
            </div>
            {track.isFavorite && <Heart className="h-3 w-3 fill-rose-500 text-rose-500 shrink-0" />}
            <span className="text-xs text-white/30 tabular-nums shrink-0">{formatDuration(track.duration)}</span>
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); player.removeFromQueue(queueIndex); }}
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded transition-all cursor-pointer"
                aria-label="Remove from queue"
            >
                <X className="h-3 w-3 text-white/50" />
            </button>
        </div>
    );
}

export function SortableUpNext({ items, startIndex }: { items: Track[]; startIndex: number }) {
    const player = usePlayer();
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );
    const ids = items.map((t, i) => `${t.id}-${startIndex + i}`);

    const onDragEnd = (e: DragEndEvent) => {
        const { active, over } = e;
        if (!over || active.id === over.id) return;
        const oldIdx = ids.indexOf(String(active.id));
        const newIdx = ids.indexOf(String(over.id));
        if (oldIdx < 0 || newIdx < 0) return;
        // Map to absolute queue indices
        const absFrom = startIndex + oldIdx;
        const absTo = startIndex + newIdx;
        player.moveInQueue(absFrom, absTo);
        // Pre-update local order via arrayMove so the UI doesn't flash; the
        // player state push will then converge to the same order.
        void arrayMove(items, oldIdx, newIdx);
    };

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {items.map((track, idx) => (
                    <Row key={ids[idx]} track={track} queueIndex={startIndex + idx} />
                ))}
            </SortableContext>
        </DndContext>
    );
}
