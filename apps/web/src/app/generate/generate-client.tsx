"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
    deleteGeneratedAsset,
    generateAsset,
    listAvailableAceLoras,
    listGeneratedAssets,
    pollPendingT0Generations,
    pollPendingT1Generations,
    sendGeneratedAssetToDaw,
    type GenerateInput,
} from "@/actions/generate";
import {
    GEN_KINDS,
    GEN_TIERS,
    GEN_TIER_LABELS,
    type GeneratedAssetDto,
    type GenKind,
    type GenTier,
} from "@/lib/generate/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FeedbackButtons } from "@/components/maestro/feedback-buttons";
import { Loader2, Trash2, Upload, Send } from "lucide-react";
import { StemsMiniPlayers } from "@/components/generate/stems-mini-players";

interface Props {
    initialAssets: GeneratedAssetDto[];
}

export function GenerateClient({ initialAssets }: Props) {
    const router = useRouter();
    const [assets, setAssets] = useState<GeneratedAssetDto[]>(initialAssets);
    const [tier, setTier] = useState<GenTier>("T1");
    const [kind, setKind] = useState<GenKind>("loop");
    const [prompt, setPrompt] = useState("");
    const [duration, setDuration] = useState(8);
    const [model, setModel] = useState("");
    const [trackId, setTrackId] = useState("");
    const [loraPath, setLoraPath] = useState("");
    const [loraWeight, setLoraWeight] = useState(1.0);
    const [availableLoras, setAvailableLoras] = useState<Array<{ exp: string; absPath: string; name: string }>>([]);
    const [pending, startTransition] = useTransition();
    const [uploadKind, setUploadKind] = useState<GenKind>("one-shot");
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploadPrompt, setUploadPrompt] = useState("");

    const refresh = () => {
        listGeneratedAssets().then(setAssets).catch(() => {});
    };

    // Load trained ACE-Step LoRAs whenever the user switches to T0+song.
    useEffect(() => {
        if (tier !== "T0" || kind !== "song") return;
        listAvailableAceLoras()
            .then((loras) => {
                const flat = loras.flatMap((l) => l.ckpts.map((c) => ({ exp: l.exp, absPath: c.absPath, name: c.name })));
                setAvailableLoras(flat);
            })
            .catch(() => setAvailableLoras([]));
    }, [tier, kind]);

    const onSubmit = () => {
        if (!prompt.trim()) {
            toast.error("Prompt is required");
            return;
        }
        const input: GenerateInput = {
            tier,
            kind,
            prompt: prompt.trim(),
            durationSec: duration,
            ...(model.trim() ? { model: model.trim() } : {}),
            ...(trackId.trim() && /^\d+$/.test(trackId.trim()) ? { trackId: Number(trackId.trim()) } : {}),
            ...(tier === "T0" && kind === "song" && loraPath
                ? { loraPath, loraWeight }
                : {}),
        };
        startTransition(async () => {
            try {
                const created = await generateAsset(input);
                setAssets((prev) => [created, ...prev.filter((a) => a.id !== created.id)]);
                if (created.status === "ready") toast.success("Generated");
                else if (created.status === "failed") toast.error(created.error ?? "Failed");
                else toast.info(created.error ?? "Pending");
            } catch (err) {
                toast.error(err instanceof Error ? err.message : "Generation failed");
            }
        });
    };

    const onDelete = (id: string) => {
        startTransition(async () => {
            try {
                await deleteGeneratedAsset(id);
                setAssets((prev) => prev.filter((a) => a.id !== id));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : "Delete failed");
            }
        });
    };

    const onPoll = () => {
        startTransition(async () => {
            try {
                const [t1, t0] = await Promise.all([
                    pollPendingT1Generations(),
                    pollPendingT0Generations(),
                ]);
                toast.success(
                    `Polled T1:${t1.checked} (ready ${t1.ready}/fail ${t1.failed}) · T0:${t0.checked} (ready ${t0.ready}/fail ${t0.failed})`,
                );
                refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : "Poll failed");
            }
        });
    };

    const onUpload = () => {
        if (!uploadFile) {
            toast.error("Pick a file first");
            return;
        }
        const fd = new FormData();
        fd.set("file", uploadFile);
        fd.set("kind", uploadKind);
        if (uploadPrompt.trim()) fd.set("prompt", uploadPrompt.trim());
        startTransition(async () => {
            try {
                const res = await fetch("/api/generated/upload", { method: "POST", body: fd });
                if (!res.ok) throw new Error(await res.text());
                toast.success("Uploaded");
                setUploadFile(null);
                setUploadPrompt("");
                refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : "Upload failed");
            }
        });
    };

    return (
        <div className="container mx-auto max-w-5xl space-y-6 p-6">
            <header>
                <h1 className="text-2xl font-semibold">Generate</h1>
                <p className="text-sm text-muted-foreground">
                    Create one-shots, loops, stems and full tracks. T1 uses Replicate (MusicGen by default).
                    Set <code>REPLICATE_API_TOKEN</code> in env.
                </p>
            </header>

            <Card>
                <CardHeader>
                    <CardTitle>New generation</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <div className="space-y-1.5">
                            <Label>Tier</Label>
                            <Select value={tier} onValueChange={(v) => setTier(v as GenTier)}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {GEN_TIERS.map((t) => (
                                        <SelectItem key={t} value={t}>{t} — {GEN_TIER_LABELS[t]}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label>Kind</Label>
                            <Select value={kind} onValueChange={(v) => setKind(v as GenKind)}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {GEN_KINDS.map((k) => (
                                        <SelectItem key={k} value={k}>{k}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="duration">Duration (s)</Label>
                            <Input
                                id="duration"
                                type="number"
                                min={1}
                                max={300}
                                value={duration}
                                onChange={(e) => setDuration(Number(e.target.value) || 8)}
                            />
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="prompt">Prompt</Label>
                        <Textarea
                            id="prompt"
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder="e.g. driving tech-house drum loop at 126 bpm, deep sub kick, crisp hats"
                            rows={3}
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="model">Model (optional override)</Label>
                        <Input
                            id="model"
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            placeholder="meta/musicgen"
                        />
                    </div>

                    {tier === "T0" && kind === "stem" ? (
                        <div className="space-y-1.5">
                            <Label htmlFor="trackId">Track ID (library) — required for T0 stems</Label>
                            <Input
                                id="trackId"
                                type="number"
                                min={1}
                                value={trackId}
                                onChange={(e) => setTrackId(e.target.value)}
                                placeholder="e.g. 12345"
                            />
                        </div>
                    ) : null}

                    {tier === "T0" && kind === "song" ? (
                        <div className="grid grid-cols-1 gap-4 rounded-md border bg-muted/30 p-3 sm:grid-cols-[2fr_1fr]">
                            <div className="space-y-1.5">
                                <Label>Trained LoRA (optional)</Label>
                                <Select value={loraPath || "__none__"} onValueChange={(v) => setLoraPath(v === "__none__" ? "" : v)}>
                                    <SelectTrigger><SelectValue placeholder="Base ACE-Step model" /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="__none__">Base ACE-Step (no LoRA)</SelectItem>
                                        {availableLoras.map((l) => (
                                            <SelectItem key={l.absPath} value={l.absPath}>
                                                {l.exp} / {l.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                    Train new LoRAs with <code>scripts/train-acestep-lora.ps1</code>. Output is always split into 4 stems by Demucs.
                                </p>
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="lora-weight">LoRA weight</Label>
                                <Input
                                    id="lora-weight"
                                    type="number"
                                    step={0.1}
                                    min={0}
                                    max={2}
                                    value={loraWeight}
                                    onChange={(e) => setLoraWeight(Number(e.target.value) || 1.0)}
                                    disabled={!loraPath}
                                />
                            </div>
                        </div>
                    ) : null}

                    <div className="flex items-center justify-end gap-2">
                        <Button variant="outline" onClick={onPoll} disabled={pending}>Poll pending</Button>
                        <Button variant="outline" onClick={refresh} disabled={pending}>Refresh</Button>
                        <Button onClick={onSubmit} disabled={pending}>
                            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            Generate
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Upload (T2)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label>Kind</Label>
                            <Select value={uploadKind} onValueChange={(v) => setUploadKind(v as GenKind)}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {GEN_KINDS.map((k) => (
                                        <SelectItem key={k} value={k}>{k}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="upload-file">Audio file</Label>
                            <Input
                                id="upload-file"
                                type="file"
                                accept="audio/*"
                                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                            />
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="upload-prompt">Description (optional)</Label>
                        <Textarea
                            id="upload-prompt"
                            value={uploadPrompt}
                            onChange={(e) => setUploadPrompt(e.target.value)}
                            placeholder="What is this sample? Where did it come from?"
                            rows={2}
                        />
                    </div>
                    <div className="flex items-center justify-end">
                        <Button onClick={onUpload} disabled={pending || !uploadFile}>
                            <Upload className="mr-2 h-4 w-4" /> Upload
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <section className="space-y-3">
                <h2 className="text-lg font-medium">History</h2>
                {assets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No generations yet.</p>
                ) : (
                    <div className="space-y-2">
                        {assets.map((a) => (
                            <Card key={a.id}>
                                <CardContent className="flex flex-col gap-2 p-4">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant="secondary">{a.tier}</Badge>
                                        <Badge variant="outline">{a.kind}</Badge>
                                        {a.model ? <span className="text-xs text-muted-foreground">{a.model}</span> : null}
                                        <StatusBadge status={a.status} />
                                        <span className="ml-auto text-xs text-muted-foreground">
                                            {new Date(a.createdAt).toLocaleString()}
                                        </span>
                                        {a.status === "ready" && (a.kind === "song" || a.kind === "loop" || a.kind === "stem") ? (
                                            <SendToDawButton assetId={a.id} pending={pending} onSent={(id) => router.push(`/daw/${id}`)} />
                                        ) : null}
                                        {a.status === "ready" ? (
                                            <FeedbackButtons assetId={a.id} compact />
                                        ) : null}
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => onDelete(a.id)}
                                            disabled={pending}
                                            aria-label="Delete"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                    {a.prompt ? (
                                        <p className="text-sm text-muted-foreground">{a.prompt}</p>
                                    ) : null}
                                    {a.error ? (
                                        <p className="text-xs text-destructive">{a.error}</p>
                                    ) : null}
                                    {a.fileUrl ? (
                                        <audio controls src={a.fileUrl} className="w-full" preload="none" />
                                    ) : null}
                                    {a.stemTrackId != null ? (
                                        <StemsMiniPlayers stemTrackId={a.stemTrackId} />
                                    ) : null}
                                    {a.songStems ? (
                                        <div className="space-y-1 rounded-md border bg-muted/30 p-2">
                                            <p className="text-xs font-medium text-muted-foreground">Stems</p>
                                            <div className="grid gap-1 sm:grid-cols-2">
                                                {Object.entries(a.songStems).map(([name, url]) => (
                                                    <div key={name} className="flex items-center gap-2">
                                                        <Badge variant="outline" className="w-16 justify-center text-[10px] uppercase">{name}</Badge>
                                                        <audio controls src={url} className="h-8 flex-1" preload="none" />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ) : null}
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}

function StatusBadge({ status }: { status: GeneratedAssetDto["status"] }) {
    if (status === "ready") return <Badge>ready</Badge>;
    if (status === "failed") return <Badge variant="destructive">failed</Badge>;
    return <Badge variant="outline">pending</Badge>;
}

function SendToDawButton({
    assetId,
    pending,
    onSent,
}: {
    assetId: string;
    pending: boolean;
    onSent: (projectExternalId: string) => void;
}) {
    const [busy, setBusy] = useState(false);
    const send = async () => {
        if (busy || pending) return;
        setBusy(true);
        try {
            // Read currently-open project from the daw-context cookie/local-storage.
            // Fall back to "create" when nothing is open.
            const current = typeof window !== "undefined"
                ? localStorage.getItem("mmo:daw:currentProjectExternalId") ?? undefined
                : undefined;
            const mode: "append" | "create" = current ? "append" : "create";
            const r = await sendGeneratedAssetToDaw(assetId, mode, current);
            if (!r.ok) {
                toast.error(r.error);
                return;
            }
            toast.success(r.appended ? `Added ${r.trackIds.length} stem tracks to project` : `Created new project`);
            onSent(r.projectExternalId);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Button
            size="sm"
            variant="outline"
            onClick={send}
            disabled={busy || pending}
            aria-label="Send to DAW"
        >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
            DAW
        </Button>
    );
}
