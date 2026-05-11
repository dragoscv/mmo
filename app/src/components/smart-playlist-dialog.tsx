"use client";

/**
 * Smart playlist authoring dialog — Batch 40.
 *
 * Four modes in tabs (Builder / SQL / Graph / AI). Each emits the
 * same SmartRules discriminated union, validated client-side via
 * smartRulesSchema before submit. Save → createSmartPlaylist server
 * action → companion creates the playlist + cloud row stores rules
 * + initial population runs.
 *
 * Builder is full-featured (the 80% case).
 * SQL is a single textarea + live parse error.
 * Graph + AI are minimal scaffolds — deeper editors land later.
 */

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Plus, Trash2, Sparkles, Code2, Workflow, ListFilter, Loader2 } from "lucide-react";

import {
    smartRulesSchema,
    type SmartRules,
    type Condition,
    type Group,
    type Field,
    type Operator,
} from "@/lib/smart-rules";
import {
    createSmartPlaylist,
    previewSmartRules,
} from "@/actions/smart-playlists";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated?: (playlistId: number) => void;
}

const FIELD_OPTIONS: Array<{ value: Field; label: string }> = [
    { value: "bpm", label: "BPM" },
    { value: "energy", label: "Energy" },
    { value: "rating", label: "Rating" },
    { value: "isFavorite", label: "Favourite" },
    { value: "genre", label: "Genre" },
    { value: "subgenre", label: "Subgenre" },
    { value: "mood", label: "Mood" },
    { value: "keyCamelot", label: "Key (Camelot)" },
    { value: "keyMusical", label: "Key (Musical)" },
    { value: "artist", label: "Artist" },
    { value: "title", label: "Title" },
    { value: "album", label: "Album" },
    { value: "label", label: "Label" },
    { value: "duration", label: "Duration (s)" },
    { value: "year", label: "Year" },
    { value: "loudnessLufs", label: "Loudness (LUFS)" },
];

const OPERATOR_OPTIONS: Array<{ value: Operator; label: string }> = [
    { value: "eq", label: "is" },
    { value: "neq", label: "is not" },
    { value: "lt", label: "<" },
    { value: "lte", label: "≤" },
    { value: "gt", label: ">" },
    { value: "gte", label: "≥" },
    { value: "between", label: "between" },
    { value: "in", label: "in" },
    { value: "notIn", label: "not in" },
    { value: "contains", label: "contains" },
    { value: "startsWith", label: "starts with" },
    { value: "endsWith", label: "ends with" },
    { value: "isSet", label: "is set" },
    { value: "isNotSet", label: "is empty" },
    { value: "withinDays", label: "within (days)" },
];

function newCondition(): Condition {
    return { type: "condition", field: "bpm", operator: "between", value: [120, 130] };
}

const SQL_PLACEHOLDER = `bpm BETWEEN 120 AND 130 AND genre IN ('techno', 'tech-house')
OR (rating >= 4 AND energy > 0.7)`;

export function SmartPlaylistDialog({ open, onOpenChange, onCreated }: Props) {
    const [mode, setMode] = useState<"builder" | "sql" | "graph" | "ai">("builder");
    const [name, setName] = useState("");
    const [pending, startTransition] = useTransition();
    const [previewCount, setPreviewCount] = useState<number | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    // Builder state
    const [conditions, setConditions] = useState<Condition[]>([newCondition()]);
    const [combinator, setCombinator] = useState<"and" | "or">("and");

    // SQL state
    const [sqlQuery, setSqlQuery] = useState("bpm BETWEEN 120 AND 130");

    // Graph state — exposed as JSON for now; visual editor is future.
    const [graphJson, setGraphJson] = useState(`{
  "nodes": [
    { "kind": "filter", "id": "f1", "condition": { "type": "condition", "field": "genre", "operator": "eq", "value": "techno" } },
    { "kind": "sort", "id": "s1", "sort": { "field": "bpm", "direction": "asc" } },
    { "kind": "limit", "id": "l1", "limit": 100 }
  ]
}`);

    // AI state
    const [aiPrompt, setAiPrompt] = useState("");

    // Build the current SmartRules from whichever tab is active.
    const currentRules = useMemo<{ rules: SmartRules; error: string | null }>(() => {
        try {
            if (mode === "builder") {
                const root: Group = { type: "group", combinator, children: conditions };
                return { rules: smartRulesSchema.parse({ kind: "builder", root }), error: null };
            }
            if (mode === "sql") {
                return { rules: smartRulesSchema.parse({ kind: "sql", query: sqlQuery }), error: null };
            }
            if (mode === "graph") {
                const parsed = JSON.parse(graphJson);
                return { rules: smartRulesSchema.parse({ kind: "graph", ...parsed }), error: null };
            }
            return { rules: smartRulesSchema.parse({ kind: "ai", prompt: aiPrompt }), error: null };
        } catch (e) {
            return { rules: null as unknown as SmartRules, error: e instanceof Error ? e.message : "Invalid rules" };
        }
    }, [mode, combinator, conditions, sqlQuery, graphJson, aiPrompt]);

    function handlePreview() {
        if (currentRules.error || !currentRules.rules) {
            toast.error(currentRules.error ?? "Invalid rules");
            return;
        }
        setPreviewLoading(true);
        setPreviewCount(null);
        void previewSmartRules(currentRules.rules)
            .then((r) => {
                if (!r.success) toast.error(r.error ?? "Preview failed");
                else setPreviewCount(r.total ?? 0);
            })
            .finally(() => setPreviewLoading(false));
    }

    function handleSave() {
        if (!name.trim()) {
            toast.error("Playlist name is required");
            return;
        }
        if (currentRules.error || !currentRules.rules) {
            toast.error(currentRules.error ?? "Invalid rules");
            return;
        }
        startTransition(async () => {
            const r = await createSmartPlaylist(name.trim(), currentRules.rules, mode);
            if (r.success && r.id) {
                toast.success(`Created "${name}" with ${r.count ?? 0} tracks`);
                onCreated?.(r.id);
                onOpenChange(false);
                // Reset state for next time.
                setName("");
                setConditions([newCondition()]);
                setPreviewCount(null);
            } else {
                toast.error(r.error ?? "Create failed");
            }
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-primary" />
                        New Smart Playlist
                    </DialogTitle>
                    <DialogDescription>
                        Choose how to define which tracks the playlist auto-collects.
                        It re-evaluates whenever you click Refresh.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-2">
                    <Label htmlFor="smart-name">Name</Label>
                    <Input
                        id="smart-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. Peak Time Techno"
                        maxLength={200}
                    />
                </div>

                <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                    <TabsList className="grid grid-cols-4 w-full">
                        <TabsTrigger value="builder"><ListFilter className="h-4 w-4 mr-1" /> Builder</TabsTrigger>
                        <TabsTrigger value="sql"><Code2 className="h-4 w-4 mr-1" /> SQL</TabsTrigger>
                        <TabsTrigger value="graph"><Workflow className="h-4 w-4 mr-1" /> Graph</TabsTrigger>
                        <TabsTrigger value="ai"><Sparkles className="h-4 w-4 mr-1" /> AI</TabsTrigger>
                    </TabsList>

                    {/* Builder tab — visual AND/OR rule editor */}
                    <TabsContent value="builder" className="space-y-3">
                        <div className="flex items-center gap-2">
                            <span className="text-sm text-muted-foreground">Match</span>
                            <Select
                                value={combinator}
                                onChange={(e) => setCombinator(e.target.value as "and" | "or")}
                                className="w-24"
                                size="sm"
                            >
                                <option value="and">all</option>
                                <option value="or">any</option>
                            </Select>
                            <span className="text-sm text-muted-foreground">of the conditions:</span>
                        </div>
                        {conditions.map((c, i) => (
                            <ConditionRow
                                key={i}
                                condition={c}
                                onChange={(next) => {
                                    const copy = conditions.slice();
                                    copy[i] = next;
                                    setConditions(copy);
                                }}
                                onRemove={conditions.length > 1 ? () => {
                                    setConditions(conditions.filter((_, idx) => idx !== i));
                                } : undefined}
                            />
                        ))}
                        <Button variant="outline" size="sm" onClick={() => setConditions([...conditions, newCondition()])}>
                            <Plus className="h-3 w-3 mr-1" /> Add condition
                        </Button>
                    </TabsContent>

                    {/* SQL tab */}
                    <TabsContent value="sql" className="space-y-2">
                        <Label htmlFor="sql-query">WHERE expression</Label>
                        <Textarea
                            id="sql-query"
                            value={sqlQuery}
                            onChange={(e) => setSqlQuery(e.target.value)}
                            placeholder={SQL_PLACEHOLDER}
                            className="font-mono text-sm min-h-[140px]"
                        />
                        <p className="text-xs text-muted-foreground">
                            Mini-SQL: <code>field op value</code>, <code>BETWEEN</code>, <code>IN (…)</code>, <code>AND</code>, <code>OR</code>, parentheses.
                            No joins, no functions — strictly safe.
                        </p>
                    </TabsContent>

                    {/* Graph tab — JSON IR for now; visual editor is future work */}
                    <TabsContent value="graph" className="space-y-2">
                        <Label htmlFor="graph-json">Pipeline (JSON)</Label>
                        <Textarea
                            id="graph-json"
                            value={graphJson}
                            onChange={(e) => setGraphJson(e.target.value)}
                            className="font-mono text-xs min-h-[200px]"
                        />
                        <p className="text-xs text-muted-foreground">
                            Visual node editor coming soon. For now, edit the JSON pipeline directly:
                            an array of <code>filter</code>, <code>sort</code>, and <code>limit</code> nodes.
                        </p>
                    </TabsContent>

                    {/* AI tab */}
                    <TabsContent value="ai" className="space-y-2">
                        <Label htmlFor="ai-prompt">Describe the playlist</Label>
                        <Textarea
                            id="ai-prompt"
                            value={aiPrompt}
                            onChange={(e) => setAiPrompt(e.target.value)}
                            placeholder="Energetic techno around 130 BPM with strong basslines, suitable for peak-time"
                            className="min-h-[120px]"
                        />
                        <p className="text-xs text-muted-foreground">
                            AI compilation is wired in a later release. Saving now stores the prompt
                            so it auto-fills when an AI provider becomes available; the playlist starts
                            with all your tracks until then.
                        </p>
                    </TabsContent>
                </Tabs>

                {currentRules.error && (
                    <p className="text-sm text-destructive">⚠ {currentRules.error}</p>
                )}

                <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={handlePreview} disabled={previewLoading || !!currentRules.error}>
                        {previewLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                        Preview match count
                    </Button>
                    {previewCount !== null && (
                        <span className="text-sm">
                            <strong>{previewCount.toLocaleString()}</strong> tracks match
                        </span>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={pending || !!currentRules.error}>
                        {pending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                        Create &amp; populate
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─── Builder row ────────────────────────────────────────────────────

function ConditionRow({
    condition,
    onChange,
    onRemove,
}: {
    condition: Condition;
    onChange: (next: Condition) => void;
    onRemove?: () => void;
}) {
    const op = condition.operator;
    const needsValue = op !== "isSet" && op !== "isNotSet";
    const isRange = op === "between";
    const isList = op === "in" || op === "notIn";

    return (
        <div className="flex items-center gap-2">
            <Select
                value={condition.field}
                onChange={(e) => onChange({ ...condition, field: e.target.value as Field })}
                className="w-36"
                size="sm"
            >
                {FIELD_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                ))}
            </Select>
            <Select
                value={op}
                onChange={(e) => onChange({ ...condition, operator: e.target.value as Operator })}
                className="w-32"
                size="sm"
            >
                {OPERATOR_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </Select>
            {needsValue && !isRange && !isList && (
                <Input
                    value={condition.value == null ? "" : String(condition.value)}
                    onChange={(e) => {
                        // Try numeric coerce when the operator is comparison-ish
                        const raw = e.target.value;
                        const numeric = ["lt", "lte", "gt", "gte", "withinDays"].includes(op);
                        const v = numeric ? (raw === "" ? "" : Number(raw)) : raw;
                        onChange({ ...condition, value: v as Condition["value"] });
                    }}
                    className="flex-1"
                    placeholder="value"
                />
            )}
            {isRange && (
                <div className="flex items-center gap-1 flex-1">
                    <Input
                        type="number"
                        value={Array.isArray(condition.value) ? condition.value[0] : ""}
                        onChange={(e) => {
                            const lo = Number(e.target.value);
                            const hi = Array.isArray(condition.value) ? condition.value[1] : 0;
                            onChange({ ...condition, value: [lo, hi] as [number, number] });
                        }}
                        placeholder="min"
                    />
                    <span className="text-xs text-muted-foreground">to</span>
                    <Input
                        type="number"
                        value={Array.isArray(condition.value) ? condition.value[1] : ""}
                        onChange={(e) => {
                            const lo = Array.isArray(condition.value) ? condition.value[0] : 0;
                            const hi = Number(e.target.value);
                            onChange({ ...condition, value: [lo, hi] as [number, number] });
                        }}
                        placeholder="max"
                    />
                </div>
            )}
            {isList && (
                <Input
                    value={Array.isArray(condition.value) ? (condition.value as string[]).join(", ") : ""}
                    onChange={(e) => {
                        const items = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                        onChange({ ...condition, value: items });
                    }}
                    className="flex-1"
                    placeholder="value1, value2, value3"
                />
            )}
            {onRemove && (
                <Button variant="ghost" size="icon" onClick={onRemove}>
                    <Trash2 className="h-4 w-4" />
                </Button>
            )}
        </div>
    );
}
