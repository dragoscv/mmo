"use client";

import { useState, useRef, type KeyboardEvent } from "react";
import { X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface TagInputProps {
    tags: string[];
    onChange?: (tags: string[]) => void;
    readonly?: boolean;
    placeholder?: string;
    suggestions?: string[];
}

const TAG_COLORS = [
    "bg-purple-500/20 text-purple-300 border-purple-500/30",
    "bg-blue-500/20 text-blue-300 border-blue-500/30",
    "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    "bg-amber-500/20 text-amber-300 border-amber-500/30",
    "bg-rose-500/20 text-rose-300 border-rose-500/30",
    "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
    "bg-orange-500/20 text-orange-300 border-orange-500/30",
    "bg-pink-500/20 text-pink-300 border-pink-500/30",
];

function getTagColor(tag: string) {
    let hash = 0;
    for (let i = 0; i < tag.length; i++) {
        hash = tag.charCodeAt(i) + ((hash << 5) - hash);
    }
    return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export function TagInput({
    tags,
    onChange,
    readonly = false,
    placeholder = "Add tag...",
    suggestions = [],
}: TagInputProps) {
    const [input, setInput] = useState("");
    const [showSuggestions, setShowSuggestions] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const filteredSuggestions = suggestions.filter(
        (s) =>
            s.toLowerCase().includes(input.toLowerCase()) &&
            !tags.includes(s) &&
            input.length > 0
    );

    const addTag = (tag: string) => {
        const trimmed = tag.trim().toLowerCase();
        if (trimmed && !tags.includes(trimmed) && onChange) {
            onChange([...tags, trimmed]);
        }
        setInput("");
        setShowSuggestions(false);
        inputRef.current?.focus();
    };

    const removeTag = (tag: string) => {
        if (onChange) {
            onChange(tags.filter((t) => t !== tag));
        }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && input.trim()) {
            e.preventDefault();
            addTag(input);
        } else if (e.key === "Backspace" && !input && tags.length > 0) {
            removeTag(tags[tags.length - 1]);
        } else if (e.key === "Escape") {
            setShowSuggestions(false);
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                    <span
                        key={tag}
                        className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
                            "animate-[fadeIn_200ms_ease-out]",
                            getTagColor(tag)
                        )}
                    >
                        {tag}
                        {!readonly && (
                            <button
                                type="button"
                                onClick={() => removeTag(tag)}
                                className="ml-0.5 rounded-full p-0.5 hover:bg-muted transition-colors cursor-pointer"
                            >
                                <X className="h-2.5 w-2.5" />
                            </button>
                        )}
                    </span>
                ))}
            </div>
            {!readonly && (
                <div className="relative">
                    <div className="flex items-center gap-1.5 rounded-md border border-[var(--input)] bg-transparent px-2 py-1.5">
                        <Plus className="h-3.5 w-3.5 text-zinc-500" />
                        <input
                            ref={inputRef}
                            type="text"
                            value={input}
                            onChange={(e) => {
                                setInput(e.target.value);
                                setShowSuggestions(true);
                            }}
                            onKeyDown={handleKeyDown}
                            onFocus={() => setShowSuggestions(true)}
                            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                            placeholder={placeholder}
                            className="flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-600"
                        />
                    </div>
                    {showSuggestions && filteredSuggestions.length > 0 && (
                        <div className="absolute top-full left-0 right-0 z-10 mt-1 rounded-md border border-[var(--border)] bg-[var(--popover)] py-1 shadow-lg">
                            {filteredSuggestions.slice(0, 8).map((s) => (
                                <button
                                    key={s}
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => addTag(s)}
                                    className="w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--accent)] transition-colors cursor-pointer"
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export function TagBadges({ tags }: { tags: string[] }) {
    if (!tags || tags.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-1">
            {tags.slice(0, 3).map((tag) => (
                <span
                    key={tag}
                    className={cn(
                        "rounded-full border px-2 py-0 text-[10px] font-medium",
                        getTagColor(tag)
                    )}
                >
                    {tag}
                </span>
            ))}
            {tags.length > 3 && (
                <span className="text-[10px] text-zinc-500">+{tags.length - 3}</span>
            )}
        </div>
    );
}
