"use client";

/**
 * Voice Wizard — train, audition, and manage personal voice clones.
 *
 * Multi-step flow:
 *   1. Pick engine (XTTS-v2 / F5-TTS) + target language
 *   2. Record 3–6 clips (6–10s each, clean room, no music) OR upload WAV/MP3
 *   3. Stage clips on the companion + pick the canonical reference
 *   4. Test spoken synth with a sample phrase
 *   5. Test melodic singing (one-bar do-re-mi)
 *   6. Save with name → returns to the voices list
 *
 * Voices live on the user's local companion. The reference WAV and
 * raw samples never leave the machine.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
    appendClonedVoiceSamples,
    deleteClonedVoice,
    finalizeClonedVoice,
    getVoiceWizardSnapshot,
    previewClonedVoice,
    previewClonedVoiceSinging,
    renameClonedVoice,
    setClonedVoiceReference,
    stageVoiceSample,
    analyzeStagedVoiceSample,
    analyzeVoicePitchCoverage,
    type VoiceWizardSnapshot,
} from "@/actions/voice-clone";
import { coachVoiceSample } from "@/actions/voice-coach";
import { listVoiceConversionModels, convertAssetWithRVC } from "@/actions/voice-convert";
import { listGeneratedAssets } from "@/actions/generate";
import type { VoiceMeta, VoiceEngine, VoiceSampleAnalysis, PitchCoverageReport, RVCModelMeta } from "@/lib/companion-voice";
import type { GeneratedAssetDto } from "@/lib/generate/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
    buildPromptQueue,
    buildSungPromptQueue,
    INTENT_META,
    type PromptIntent,
    type SungPhrasePrompt,
    type TrainingPrompt,
} from "./training-prompts";

// Supported wizard languages. Keys match XTTS-v2 tags; `ro` is shown
// even though XTTS falls back to Italian phonetics for it (the companion
// router performs the mapping). F5-TTS doesn't help — its base model is
// en/zh only — so XTTS is the best zero-shot option for Romanian today.
const LANGUAGES: Array<{ code: string; label: string; note?: string }> = [
    { code: "en", label: "English" },
    { code: "ro", label: "Română", note: "XTTS uses Italian phonetics for Romanian (closest match in zero-shot)." },
    { code: "es", label: "Español" },
    { code: "fr", label: "Français" },
    { code: "de", label: "Deutsch" },
    { code: "it", label: "Italiano" },
    { code: "pt", label: "Português" },
    { code: "pl", label: "Polski" },
    { code: "nl", label: "Nederlands" },
    { code: "cs", label: "Čeština" },
    { code: "tr", label: "Türkçe" },
    { code: "ru", label: "Русский" },
    { code: "ja", label: "日本語" },
    { code: "zh-cn", label: "中文 (简体)" },
];

const SAMPLE_PHRASES: Record<string, string> = {
    en: "The river slowed and bent west, but the song stayed in my chest.",
    ro: "Râul s-a domolit și a cotit spre apus, dar cântecul a rămas în pieptul meu.",
    es: "El río se calmó y giró al oeste, pero la canción se quedó en mi pecho.",
    fr: "La rivière a ralenti et a tourné vers l’ouest, mais la chanson est restée dans ma poitrine.",
    de: "Der Fluss verlangsamte sich und wand sich nach Westen, doch das Lied blieb in meiner Brust.",
    it: "Il fiume rallentò e si piegò a ovest, ma la canzone restò nel mio petto.",
    pt: "O rio diminuiu e curvou para oeste, mas a canção ficou no meu peito.",
};

// Major scale, one note per beat, fits inside one 4/4 bar at 4 beats.
const SAMPLE_MELODY = [60, 62, 64, 65, 67, 69, 71, 72].map((midi, i) => ({
    beat: i * 0.5,
    durationBeats: 0.5,
    midiPitch: midi,
}));

interface StagedClip {
    stagedId: string;
    label: string;
    durationSec: number;
    bytes: number;
    blobUrl: string;
    // Optional training metadata (UI-only — not persisted server-side).
    promptId?: string;
    promptText?: string;
    promptIntent?: PromptIntent;
    promptLanguage?: string;
    /** "speak" or "sing" — sung clips skip text-based analysis. */
    promptKind?: "speak" | "sing";
    /** Pitch tier of the sung clip (when promptKind === "sing"). */
    sungTier?: "low" | "mid" | "high";
}

interface ClipAnalysisState {
    loading: boolean;
    analysis?: VoiceSampleAnalysis;
    coachNote?: string;
    coachLoading?: boolean;
    error?: string;
    coachError?: string;
}

type WizardStep = "engine" | "record" | "review" | "speak" | "sing" | "name";

export function VoiceWizardClient({ snapshot }: { snapshot: VoiceWizardSnapshot }) {
    const [tab, setTab] = useState<"voices" | "new" | "convert">(snapshot.voices.length ? "voices" : "new");
    const [snap, setSnap] = useState(snapshot);
    const [, startTransition] = useTransition();

    const refresh = useCallback(() => {
        startTransition(async () => {
            const next = await getVoiceWizardSnapshot();
            setSnap(next);
        });
    }, []);

    if (!snap.hasCompanion) {
        return (
            <div className="mx-auto max-w-3xl p-6">
                <h1 className="text-3xl font-semibold tracking-tight">Voice Wizard</h1>
                <p className="text-muted-foreground mt-2">
                    Voice cloning runs entirely on your own computer through the MuzicAI
                    Companion app. Pair this browser with a companion to continue.
                </p>
                <Card className="mt-6 p-6">
                    <h2 className="text-lg font-medium">No companion paired</h2>
                    <p className="text-sm text-muted-foreground mt-2">
                        Open the companion app and pair this browser from Settings →
                        Devices. Once paired, this page will detect the local sidecar
                        and let you train a new voice.
                    </p>
                </Card>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-5xl p-6 space-y-6">
            <header className="flex items-end justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-semibold tracking-tight">Voice Wizard</h1>
                    <p className="text-muted-foreground mt-1 text-sm">
                        Train a personal voice clone on your own machine. Used by
                        Maestro, the DAW vocals lane, and any generative voice job.
                    </p>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {snap.health ? (
                        <>
                            <EngineBadge label="XTTS-v2" ready={snap.health.engines.xtts} />
                            <EngineBadge label="F5-TTS" ready={snap.health.engines.f5} />
                            <Badge variant={snap.health.sidecarReady ? "default" : "secondary"}>
                                {snap.health.sidecarReady ? "sidecar ready" : "sidecar idle"}
                            </Badge>
                        </>
                    ) : (
                        <Badge variant="secondary">health unknown</Badge>
                    )}
                </div>
            </header>

            <div className="flex items-center gap-2">
                <Button variant={tab === "voices" ? "default" : "outline"} onClick={() => setTab("voices")}>
                    Your voices ({snap.voices.length})
                </Button>
                <Button variant={tab === "new" ? "default" : "outline"} onClick={() => setTab("new")}>
                    Train new voice
                </Button>
                <Button variant={tab === "convert" ? "default" : "outline"} onClick={() => setTab("convert")}>
                    Convert sample (RVC)
                </Button>
                {!snap.canTrain && (
                    <span className="text-xs text-amber-500 ml-2">
                        No voice engine detected. On the companion machine run:&nbsp;
                        <code className="rounded bg-muted px-1.5 py-0.5">pip install coqui-tts soundfile numpy librosa</code>
                    </span>
                )}
            </div>

            {tab === "voices" && <VoicesList voices={snap.voices} onChange={refresh} />}
            {tab === "new" && (
                <NewVoiceWizard
                    availableEngines={{
                        xtts: !!snap.health?.engines.xtts,
                        f5: !!snap.health?.engines.f5,
                    }}
                    onSaved={() => {
                        refresh();
                        setTab("voices");
                    }}
                />
            )}
            {tab === "convert" && <RVCConvertPanel />}
        </div>
    );
}

function EngineBadge({ label, ready }: { label: string; ready: boolean }) {
    return (
        <Badge variant={ready ? "default" : "outline"} title={ready ? `${label} ready` : `${label} not installed`}>
            {label}: {ready ? "ready" : "—"}
        </Badge>
    );
}

// ────────────────────────────────────────────────────────────────────
// VOICES LIST
// ────────────────────────────────────────────────────────────────────

function VoicesList({ voices, onChange }: { voices: VoiceMeta[]; onChange: () => void }) {
    if (!voices.length) {
        return (
            <Card className="p-8 text-center text-sm text-muted-foreground">
                No cloned voices yet. Switch to <strong>Train new voice</strong> to get started.
            </Card>
        );
    }
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {voices.map((v) => (
                <VoiceCard key={v.id} voice={v} onChange={onChange} />
            ))}
        </div>
    );
}

function VoiceCard({ voice, onChange }: { voice: VoiceMeta; onChange: () => void }) {
    const [busy, setBusy] = useState(false);
    const [name, setName] = useState(voice.name);
    const [previewLang, setPreviewLang] = useState(voice.language);
    const [phrase, setPhrase] = useState(SAMPLE_PHRASES[voice.language] ?? SAMPLE_PHRASES.en);
    const [playUrl, setPlayUrl] = useState<string | null>(null);
    const [managing, setManaging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // Keep phrase in sync when the user switches preview language, but only
    // overwrite if they haven't customized it (i.e. it still matches some
    // canonical phrase). Otherwise respect their edit.
    const onPickLang = useCallback((lang: string) => {
        setPreviewLang(lang);
        const wasCanonical = Object.values(SAMPLE_PHRASES).some((p) => p === phrase);
        if (wasCanonical || !phrase.trim()) {
            setPhrase(SAMPLE_PHRASES[lang] ?? SAMPLE_PHRASES.en);
        }
    }, [phrase]);

    const previewSpeak = useCallback(async () => {
        setBusy(true);
        try {
            const r = await previewClonedVoice({ voiceId: voice.id, text: phrase, language: previewLang });
            setPlayUrl(`${r.playUrl}&t=${Date.now()}`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [voice.id, previewLang, phrase]);

    const previewSing = useCallback(async () => {
        setBusy(true);
        try {
            const r = await previewClonedVoiceSinging({
                voiceId: voice.id,
                text: "la la la la la la la la",
                language: previewLang,
                tempo: 100,
                melody: SAMPLE_MELODY,
            });
            setPlayUrl(`${r.playUrl}&t=${Date.now()}`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [voice.id, previewLang]);

    const rename = useCallback(async () => {
        if (!name.trim() || name === voice.name) return;
        setBusy(true);
        try {
            await renameClonedVoice(voice.id, name.trim());
            onChange();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [voice.id, voice.name, name, onChange]);

    const remove = useCallback(async () => {
        if (!confirm(`Delete voice "${voice.name}"? Reference clip and samples are removed from your companion.`)) return;
        setBusy(true);
        try {
            const ok = await deleteClonedVoice(voice.id);
            if (ok) onChange();
            else toast.error("Failed to delete voice on companion.");
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [voice.id, voice.name, onChange]);

    const uploadMoreSamples = useCallback(async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        setBusy(true);
        try {
            const stagedIds: string[] = [];
            for (const f of Array.from(files)) {
                const buf = await f.arrayBuffer();
                const staged = await stageVoiceSample(buf, f.name);
                stagedIds.push(staged.stagedId);
            }
            const updated = await appendClonedVoiceSamples(voice.id, stagedIds);
            if (updated) {
                toast.success(`Added ${stagedIds.length} sample${stagedIds.length === 1 ? "" : "s"}.`);
                onChange();
            } else {
                toast.error("Companion rejected the append.");
            }
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }, [voice.id, onChange]);

    const promote = useCallback(async (sampleIndex: number) => {
        setBusy(true);
        try {
            const updated = await setClonedVoiceReference(voice.id, sampleIndex);
            if (updated) {
                toast.success("Reference clip updated.");
                onChange();
            } else {
                toast.error("Failed to set reference on companion.");
            }
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [voice.id, onChange]);

    return (
        <Card className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} className="font-medium" />
                    <div className="text-xs text-muted-foreground mt-1 truncate">
                        id: <code>{voice.id}</code>
                    </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                    <Badge variant="outline">{voice.engine.toUpperCase()}</Badge>
                    <Badge variant="secondary">trained: {voice.language}</Badge>
                </div>
            </div>
            <div className="text-xs text-muted-foreground">
                {voice.samples.length} sample{voice.samples.length === 1 ? "" : "s"} · updated {new Date(voice.updatedAt).toLocaleString()}
            </div>

            <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                <Label className="text-xs text-muted-foreground">Preview lang</Label>
                <Select value={previewLang} onValueChange={onPickLang}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                        {LANGUAGES.map((l) => (
                            <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <Textarea value={phrase} onChange={(e) => setPhrase(e.target.value)} rows={2} className="text-sm" />
            <div className="flex items-center gap-2 flex-wrap">
                <Button size="sm" disabled={busy} onClick={previewSpeak}>Preview spoken</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={previewSing}>Preview sung</Button>
                <Button size="sm" variant="ghost" onClick={() => setManaging((m) => !m)}>
                    {managing ? "Hide samples" : "Manage samples"}
                </Button>
                <Button size="sm" variant="ghost" className="ml-auto text-destructive" disabled={busy} onClick={remove}>Delete</Button>
            </div>

            {managing && (
                <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-3">
                    <div className="text-xs text-muted-foreground">
                        Sample 0 is the reference clip used by the engine. Promote any sample to become the new reference,
                        or add more clips (any language) to broaden the voice.
                    </div>
                    <ol className="space-y-1.5 text-xs">
                        {voice.samples.map((s, i) => (
                            <li key={`${s}-${i}`} className="flex items-center gap-2">
                                <span className="font-mono text-muted-foreground w-6 text-right">{i}</span>
                                <span className="flex-1 truncate">{s}</span>
                                {i === 0 ? (
                                    <Badge variant="default" className="text-[10px] py-0">reference</Badge>
                                ) : (
                                    <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled={busy} onClick={() => promote(i)}>
                                        Use as reference
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ol>
                    <div className="flex items-center gap-2 pt-1">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="audio/*"
                            multiple
                            className="hidden"
                            onChange={(e) => uploadMoreSamples(e.target.files)}
                        />
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => fileInputRef.current?.click()}>
                            + Add sample files
                        </Button>
                        <span className="text-[11px] text-muted-foreground">
                            WAV / MP3, 6–10s each. Cleaner clips = better voice.
                        </span>
                    </div>
                </div>
            )}

            {playUrl && (
                // The proxy route handles auth + companion fetch; the audio element only sees a same-origin URL.
                <audio key={playUrl} src={playUrl} controls className="w-full h-9" autoPlay />
            )}
        </Card>
    );
}

// ────────────────────────────────────────────────────────────────────
// NEW VOICE WIZARD
// ────────────────────────────────────────────────────────────────────

function NewVoiceWizard({ availableEngines, onSaved }: { availableEngines: { xtts: boolean; f5: boolean }; onSaved: () => void }) {
    const [step, setStep] = useState<WizardStep>("engine");
    const [engine, setEngine] = useState<VoiceEngine>(availableEngines.xtts ? "xtts" : (availableEngines.f5 ? "f5" : "xtts"));
    const [language, setLanguage] = useState("en");
    const [trainingLanguages, setTrainingLanguages] = useState<string[]>(["en"]);
    const [name, setName] = useState("My voice");
    const [notes, setNotes] = useState("");
    const [clips, setClips] = useState<StagedClip[]>([]);
    const [referenceIdx, setReferenceIdx] = useState(0);
    const [busy, setBusy] = useState(false);
    const [savedVoiceId, setSavedVoiceId] = useState<string | null>(null);
    const [playUrl, setPlayUrl] = useState<string | null>(null);
    const [promptIdx, setPromptIdx] = useState(0);
    const [sungPromptIdx, setSungPromptIdx] = useState(0);
    const [recordMode, setRecordMode] = useState<"speak" | "sing">("speak");
    const [analyses, setAnalyses] = useState<Record<string, ClipAnalysisState>>({});

    const phrase = SAMPLE_PHRASES[language] ?? SAMPLE_PHRASES.en;

    const promptQueue = useMemo(
        () => buildPromptQueue(trainingLanguages.length ? trainingLanguages : [language]),
        [trainingLanguages, language],
    );
    const currentPrompt: TrainingPrompt | undefined = promptQueue[promptIdx % Math.max(1, promptQueue.length)];

    const sungPromptQueue = useMemo(
        () => buildSungPromptQueue(trainingLanguages.length ? trainingLanguages : [language]),
        [trainingLanguages, language],
    );
    const currentSungPrompt: SungPhrasePrompt | undefined =
        sungPromptQueue[sungPromptIdx % Math.max(1, sungPromptQueue.length)];

    // Keep training languages in sync when the primary language changes:
    // ensure it is always in the set so the user has at least one bank.
    useEffect(() => {
        setTrainingLanguages((prev) => (prev.includes(language) ? prev : [language, ...prev]));
    }, [language]);

    const stepIndex = (["engine", "record", "review", "speak", "sing", "name"] as WizardStep[]).indexOf(step);

    const onClipAdded = useCallback((clip: StagedClip) => {
        setClips((prev) => [...prev, clip]);
        if (!clip.promptText || !clip.promptIntent || !clip.promptLanguage) return;
        setAnalyses((prev) => ({ ...prev, [clip.stagedId]: { loading: true } }));
        (async () => {
            try {
                const analysis = await analyzeStagedVoiceSample({
                    stagedId: clip.stagedId,
                    expectedText: clip.promptText,
                    language: clip.promptLanguage,
                    intent: clip.promptIntent,
                });
                if (!analysis) {
                    setAnalyses((prev) => ({ ...prev, [clip.stagedId]: { loading: false, error: "Companion unreachable" } }));
                    return;
                }
                setAnalyses((prev) => ({
                    ...prev,
                    [clip.stagedId]: { loading: false, analysis, coachLoading: true },
                }));
                const coach = await coachVoiceSample({
                    prompt: clip.promptText!,
                    intent: clip.promptIntent!,
                    language: clip.promptLanguage!,
                    uiLanguage: typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : clip.promptLanguage,
                    analysis,
                });
                setAnalyses((prev) => ({
                    ...prev,
                    [clip.stagedId]: {
                        loading: false,
                        analysis,
                        coachLoading: false,
                        coachNote: coach.text ?? undefined,
                        coachError: coach.error,
                    },
                }));
            } catch (e) {
                setAnalyses((prev) => ({
                    ...prev,
                    [clip.stagedId]: { loading: false, error: e instanceof Error ? e.message : String(e) },
                }));
            }
        })();
    }, []);
    const removeClip = useCallback((stagedId: string) => {
        setClips((prev) => prev.filter((c) => c.stagedId !== stagedId));
        setReferenceIdx((idx) => Math.min(idx, Math.max(0, clips.length - 2)));
        setAnalyses((prev) => {
            const next = { ...prev };
            delete next[stagedId];
            return next;
        });
    }, [clips.length]);

    const rerecordPrompt = useCallback((promptId: string) => {
        const i = promptQueue.findIndex((p) => p.id === promptId);
        if (i >= 0) setPromptIdx(i);
        toast.info("Prompt cued — record this take again when ready.");
    }, [promptQueue]);

    const reorderReference = useCallback(async (newIdx: number) => {
        if (!savedVoiceId) {
            // Pre-save: just reorder in memory by swapping element 0 with newIdx
            // so the companion uses the user's pick as the canonical reference
            // when finalizing.
            setClips((prev) => {
                if (newIdx === 0 || newIdx >= prev.length) return prev;
                const copy = prev.slice();
                const [picked] = copy.splice(newIdx, 1);
                copy.unshift(picked);
                return copy;
            });
            setReferenceIdx(0);
            return;
        }
        // Post-save: ask the companion to swap reference.wav
        setBusy(true);
        try {
            await setClonedVoiceReference(savedVoiceId, newIdx);
            setReferenceIdx(newIdx);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [savedVoiceId]);

    const finalize = useCallback(async () => {
        if (clips.length === 0) { toast.error("Add at least one clip first."); return; }
        setBusy(true);
        try {
            const meta = await finalizeClonedVoice({
                name: name.trim() || "Untitled voice",
                engine,
                language,
                notes: notes.trim() || undefined,
                stagedIds: clips.map((c) => c.stagedId),
            });
            setSavedVoiceId(meta.id);
            toast.success(`Saved "${meta.name}"`);
            onSaved();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [clips, name, engine, language, notes, onSaved]);

    const doPreviewSpeak = useCallback(async () => {
        if (!savedVoiceId) {
            // Live-preview path: ask the companion to do a quick spoken
            // synth using the staged clips. To avoid an extra round-trip
            // we save the voice now (it's the user's first concrete commit).
            await finalize();
            return;
        }
        setBusy(true);
        try {
            const r = await previewClonedVoice({ voiceId: savedVoiceId, text: phrase, language });
            setPlayUrl(`${r.playUrl}&t=${Date.now()}`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [savedVoiceId, phrase, language, finalize]);

    const doPreviewSing = useCallback(async () => {
        if (!savedVoiceId) {
            await finalize();
            return;
        }
        setBusy(true);
        try {
            const r = await previewClonedVoiceSinging({
                voiceId: savedVoiceId,
                text: "la la la la la la la la",
                language,
                tempo: 100,
                melody: SAMPLE_MELODY,
            });
            setPlayUrl(`${r.playUrl}&t=${Date.now()}`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [savedVoiceId, language, finalize]);

    return (
        <Card className="p-6 space-y-6">
            <WizardStepper step={stepIndex} />

            {step === "engine" && (
                <section className="space-y-4">
                    <h3 className="text-lg font-medium">1. Pick engine and language</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <Label>Engine</Label>
                            <Select value={engine} onValueChange={(v) => setEngine(v as VoiceEngine)}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="xtts" disabled={!availableEngines.xtts}>
                                        XTTS-v2 — multilingual, zero-shot {availableEngines.xtts ? "" : "(not installed)"}
                                    </SelectItem>
                                    <SelectItem value="f5" disabled={!availableEngines.f5}>
                                        F5-TTS — newer, flow-matching {availableEngines.f5 ? "" : "(not installed)"}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <Label>Primary language</Label>
                            <Select value={language} onValueChange={setLanguage}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {LANGUAGES.map((l) => (
                                        <SelectItem key={l.code} value={l.code}>
                                            {l.label} ({l.code})
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {LANGUAGES.find((l) => l.code === language)?.note && (
                                <p className="text-xs text-amber-500 mt-1">
                                    {LANGUAGES.find((l) => l.code === language)?.note}
                                </p>
                            )}
                        </div>
                    </div>
                    <div>
                        <Label>Train in additional languages (optional)</Label>
                        <p className="text-xs text-muted-foreground mt-1">
                            Adds guided prompts in each language to the record step. Useful if you want this voice to switch tongues cleanly.
                        </p>
                        <div className="flex flex-wrap gap-2 mt-2">
                            {LANGUAGES.filter((l) => ["en", "ro", "es", "fr", "de", "it"].includes(l.code)).map((l) => {
                                const active = trainingLanguages.includes(l.code);
                                const isPrimary = l.code === language;
                                return (
                                    <button
                                        key={l.code}
                                        type="button"
                                        onClick={() => {
                                            if (isPrimary) return; // primary is always included
                                            setTrainingLanguages((prev) =>
                                                prev.includes(l.code)
                                                    ? prev.filter((c) => c !== l.code)
                                                    : [...prev, l.code],
                                            );
                                        }}
                                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${active ? "border-primary bg-primary/15 text-primary" : "border-border hover:bg-accent"} ${isPrimary ? "opacity-90 cursor-default" : "cursor-pointer"}`}
                                    >
                                        <span>{l.label}</span>
                                        <span className="text-muted-foreground">({l.code})</span>
                                        {isPrimary && <span className="text-[10px] uppercase tracking-wide">primary</span>}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <Button onClick={() => setStep("record")}>Next: record samples</Button>
                    </div>
                </section>
            )}

            {step === "record" && (
                <RecordStep
                    onClipAdded={onClipAdded}
                    busy={busy}
                    setBusy={setBusy}
                    promptQueue={promptQueue}
                    promptIdx={promptIdx}
                    onAdvancePrompt={() => setPromptIdx((i) => i + 1)}
                    onPickPrompt={(i) => setPromptIdx(i)}
                    coveredPromptIds={new Set(clips.map((c) => c.promptId).filter((x): x is string => !!x))}
                    currentPrompt={currentPrompt}
                    mode={recordMode}
                    onModeChange={setRecordMode}
                    sungQueue={sungPromptQueue}
                    sungIdx={sungPromptIdx}
                    onAdvanceSung={() => setSungPromptIdx((i) => i + 1)}
                    onPickSung={(i) => setSungPromptIdx(i)}
                    currentSungPrompt={currentSungPrompt}
                >
                    <ClipList clips={clips} referenceIdx={referenceIdx} onPickReference={reorderReference} onRemove={removeClip} analyses={analyses} onRerecord={rerecordPrompt} />
                    <div className="flex justify-between">
                        <Button variant="ghost" onClick={() => setStep("engine")}>Back</Button>
                        <Button onClick={() => setStep("review")} disabled={!clips.length}>
                            Next: review ({clips.length} clip{clips.length === 1 ? "" : "s"})
                        </Button>
                    </div>
                </RecordStep>
            )}

            {step === "review" && (
                <section className="space-y-4">
                    <h3 className="text-lg font-medium">3. Pick the reference clip</h3>
                    <p className="text-sm text-muted-foreground">
                        XTTS-v2 clones timbre from a single 6–10s clip. Pick the
                        cleanest, most expressive sample below — the others stay as
                        backups you can swap to later.
                    </p>
                    <ClipList clips={clips} referenceIdx={referenceIdx} onPickReference={reorderReference} onRemove={removeClip} analyses={analyses} onRerecord={rerecordPrompt} />
                    <PitchCoverageBlock stagedIds={clips.map((c) => c.stagedId)} />
                    <div className="flex justify-between">
                        <Button variant="ghost" onClick={() => setStep("record")}>Back</Button>
                        <Button onClick={() => setStep("speak")} disabled={!clips.length}>Next: speak test</Button>
                    </div>
                </section>
            )}

            {step === "speak" && (
                <section className="space-y-4">
                    <h3 className="text-lg font-medium">4. Test spoken voice</h3>
                    <Textarea value={phrase} readOnly rows={2} />
                    <div className="flex items-center gap-2">
                        <Button onClick={doPreviewSpeak} disabled={busy}>
                            {savedVoiceId ? "Generate preview" : "Save & generate preview"}
                        </Button>
                        {playUrl && <audio key={playUrl} src={playUrl} controls className="flex-1 h-9" autoPlay />}
                    </div>
                    <div className="flex justify-between">
                        <Button variant="ghost" onClick={() => setStep("review")}>Back</Button>
                        <Button onClick={() => setStep("sing")}>Next: sing test</Button>
                    </div>
                </section>
            )}

            {step === "sing" && (
                <section className="space-y-4">
                    <h3 className="text-lg font-medium">5. Test melodic singing</h3>
                    <p className="text-sm text-muted-foreground">
                        Renders a one-bar major scale on “la” using your cloned
                        timbre. Each note is synthesized then pitch + time-shifted to
                        the target MIDI note — same engine Maestro uses for vocals.
                    </p>
                    <div className="flex items-center gap-2">
                        <Button onClick={doPreviewSing} disabled={busy}>
                            {savedVoiceId ? "Generate sing preview" : "Save & generate sing preview"}
                        </Button>
                        {playUrl && <audio key={playUrl} src={playUrl} controls className="flex-1 h-9" autoPlay />}
                    </div>
                    <div className="flex justify-between">
                        <Button variant="ghost" onClick={() => setStep("speak")}>Back</Button>
                        <Button onClick={() => setStep("name")}>Next: name & save</Button>
                    </div>
                </section>
            )}

            {step === "name" && (
                <section className="space-y-4">
                    <h3 className="text-lg font-medium">6. Name your voice</h3>
                    <div>
                        <Label>Voice name</Label>
                        <Input value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                    <div>
                        <Label>Notes (optional — accent, range, gender, mood)</Label>
                        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
                    </div>
                    <div className="flex justify-between">
                        <Button variant="ghost" onClick={() => setStep("sing")}>Back</Button>
                        <Button onClick={finalize} disabled={busy || !clips.length}>
                            {savedVoiceId ? "Update voice" : "Save voice"}
                        </Button>
                    </div>
                    {savedVoiceId && (
                        <p className="text-xs text-muted-foreground">
                            Saved as <code>{savedVoiceId}</code>. Use this id in Maestro:
                            <code className="ml-1">companion:{engine}:{savedVoiceId}</code>
                        </p>
                    )}
                </section>
            )}
        </Card>
    );
}

function WizardStepper({ step }: { step: number }) {
    const labels = ["Engine", "Record", "Review", "Speak", "Sing", "Save"];
    return (
        <div className="flex items-center gap-2 text-xs">
            {labels.map((l, i) => (
                <div key={l} className="flex items-center gap-2">
                    <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${i <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                        {i + 1}
                    </div>
                    <span className={i === step ? "font-medium" : "text-muted-foreground"}>{l}</span>
                    {i < labels.length - 1 && <span className="text-muted-foreground">→</span>}
                </div>
            ))}
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────
// RECORDER
// ────────────────────────────────────────────────────────────────────

function RecordStep({
    children,
    onClipAdded,
    busy,
    setBusy,
    promptQueue,
    promptIdx,
    onAdvancePrompt,
    onPickPrompt,
    coveredPromptIds,
    currentPrompt,
    mode,
    onModeChange,
    sungQueue,
    sungIdx,
    onAdvanceSung,
    onPickSung,
    currentSungPrompt,
}: {
    children: React.ReactNode;
    onClipAdded: (clip: StagedClip) => void;
    busy: boolean;
    setBusy: (b: boolean) => void;
    promptQueue: TrainingPrompt[];
    promptIdx: number;
    onAdvancePrompt: () => void;
    onPickPrompt: (i: number) => void;
    coveredPromptIds: Set<string>;
    currentPrompt: TrainingPrompt | undefined;
    mode: "speak" | "sing";
    onModeChange: (m: "speak" | "sing") => void;
    sungQueue: SungPhrasePrompt[];
    sungIdx: number;
    onAdvanceSung: () => void;
    onPickSung: (i: number) => void;
    currentSungPrompt: SungPhrasePrompt | undefined;
}) {
    const mediaRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const startedAtRef = useRef<number>(0);
    // Capture the prompt at start-time so a mid-recording advance can't
    // mis-tag the clip on stop. Tracks BOTH modes — only one is read
    // depending on `modeAtStartRef`.
    const promptAtStartRef = useRef<TrainingPrompt | undefined>(undefined);
    const sungAtStartRef = useRef<SungPhrasePrompt | undefined>(undefined);
    const modeAtStartRef = useRef<"speak" | "sing">("speak");
    const [recording, setRecording] = useState(false);
    const [secs, setSecs] = useState(0);
    const [liveStream, setLiveStream] = useState<MediaStream | null>(null);

    useEffect(() => {
        if (!recording) return;
        const t = setInterval(() => setSecs((s) => s + 0.1), 100);
        return () => clearInterval(t);
    }, [recording]);

    const startRec = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    channelCount: 1,
                },
            });
            streamRef.current = stream;
            setLiveStream(stream);
            // Prefer WAV-friendly mimeTypes; fall back to whatever the browser
            // gives us — the companion goes through librosa/ffmpeg so any
            // common container decodes fine.
            const mimePrefs = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];
            let mime = "";
            for (const m of mimePrefs) {
                if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
            }
            const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
            chunksRef.current = [];
            rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
            rec.onstop = async () => {
                const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || "audio/webm" });
                const durationSec = Math.max(0, (performance.now() - startedAtRef.current) / 1000);
                stream.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
                setLiveStream(null);
                setRecording(false);
                if (blob.size < 8_000) {
                    toast.error("Clip too short — record at least 3 seconds of clean speech.");
                    return;
                }
                setBusy(true);
                try {
                    const buf = await blob.arrayBuffer();
                    const ext = (mime.split("/")[1] || "webm").split(";")[0];
                    const filename = `clip-${Date.now()}.${ext}`;
                    const staged = await stageVoiceSample(buf, filename);
                    const startMode = modeAtStartRef.current;
                    if (startMode === "sing") {
                        const sung = sungAtStartRef.current;
                        const label = sung
                            ? `${sung.language.toUpperCase()} · sing ${sung.tier}`
                            : `Sing clip ${new Date().toLocaleTimeString()}`;
                        onClipAdded({
                            stagedId: staged.stagedId,
                            label,
                            durationSec,
                            bytes: staged.bytes,
                            blobUrl: URL.createObjectURL(blob),
                            promptId: sung?.id,
                            promptText: sung?.text,
                            promptLanguage: sung?.language,
                            promptKind: "sing",
                            sungTier: sung?.tier,
                        });
                        if (sung) {
                            toast.success(`Saved · ${sung.language.toUpperCase()} · sing ${sung.tier}`);
                            onAdvanceSung();
                        } else {
                            toast.success("Sung sample saved");
                        }
                    } else {
                        const tagged = promptAtStartRef.current;
                        const label = tagged
                            ? `${tagged.language.toUpperCase()} · ${INTENT_META[tagged.intent].label}`
                            : `Clip ${new Date().toLocaleTimeString()}`;
                        onClipAdded({
                            stagedId: staged.stagedId,
                            label,
                            durationSec,
                            bytes: staged.bytes,
                            blobUrl: URL.createObjectURL(blob),
                            promptId: tagged?.id,
                            promptText: tagged?.text,
                            promptIntent: tagged?.intent,
                            promptLanguage: tagged?.language,
                            promptKind: "speak",
                        });
                        if (tagged) {
                            toast.success(`Saved · ${tagged.language.toUpperCase()} · ${INTENT_META[tagged.intent].label}`);
                            onAdvancePrompt();
                        } else {
                            toast.success("Sample saved");
                        }
                    }
                } catch (e) {
                    toast.error(e instanceof Error ? e.message : String(e));
                } finally {
                    setBusy(false);
                }
            };
            mediaRef.current = rec;
            startedAtRef.current = performance.now();
            modeAtStartRef.current = mode;
            promptAtStartRef.current = currentPrompt;
            sungAtStartRef.current = currentSungPrompt;
            chunksRef.current = [];
            setSecs(0);
            rec.start();
            setRecording(true);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        }
    }, [onClipAdded, setBusy, currentPrompt, onAdvancePrompt, mode, currentSungPrompt, onAdvanceSung]);

    const stopRec = useCallback(() => {
        try { mediaRef.current?.stop(); } catch { /* ignore */ }
    }, []);

    const onFile = useCallback(async (file: File) => {
        if (file.size < 8_000) { toast.error("File too small."); return; }
        if (file.size > 25 * 1024 * 1024) { toast.error("File too large (max 25 MB)."); return; }
        setBusy(true);
        try {
            const buf = await file.arrayBuffer();
            const staged = await stageVoiceSample(buf, file.name);
            onClipAdded({
                stagedId: staged.stagedId,
                label: file.name,
                durationSec: 0,
                bytes: staged.bytes,
                blobUrl: URL.createObjectURL(file),
            });
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [onClipAdded, setBusy]);

    return (
        <section className="space-y-4">
            <h3 className="text-lg font-medium">2. Record or upload samples</h3>
            <p className="text-sm text-muted-foreground">
                Best results: 3–6 clips, 6–10 seconds each, clean room, no music.
                Read the prompt below the way it asks you to — that's how the model
                learns your dynamic range, not just your timbre.
            </p>

            <PromptModeToggle mode={mode} onChange={onModeChange} disabled={recording} />

            {mode === "speak" ? (
                <PromptCoach
                    queue={promptQueue}
                    idx={promptIdx}
                    covered={coveredPromptIds}
                    current={currentPrompt}
                    onSkip={onAdvancePrompt}
                    onPick={onPickPrompt}
                    recording={recording}
                />
            ) : (
                <SungPromptCoach
                    queue={sungQueue}
                    idx={sungIdx}
                    covered={coveredPromptIds}
                    current={currentSungPrompt}
                    onSkip={onAdvanceSung}
                    onPick={onPickSung}
                    recording={recording}
                />
            )}

            {recording && liveStream && <LevelMeter stream={liveStream} />}

            <div className="flex flex-wrap items-center gap-3">
                {!recording ? (
                    <Button onClick={startRec} disabled={busy} size="lg">● Record clip</Button>
                ) : (
                    <Button variant="destructive" onClick={stopRec} size="lg">■ Stop ({secs.toFixed(1)}s)</Button>
                )}
                <Label htmlFor="upload" className="cursor-pointer">
                    <span className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-accent">Upload file</span>
                </Label>
                <input
                    id="upload"
                    type="file"
                    accept="audio/wav,audio/mp3,audio/mpeg,audio/m4a,audio/x-m4a,audio/aac,audio/ogg,audio/webm,audio/flac,.wav,.mp3,.m4a,.aac,.ogg,.flac,.webm"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}
                />
                {busy && <Progress value={70} className="w-32 h-2" />}
            </div>

            {children}
        </section>
    );
}

function LevelMeter({ stream }: { stream: MediaStream }) {
    const [peakDb, setPeakDb] = useState(-60);
    const [rmsDb, setRmsDb] = useState(-60);
    useEffect(() => {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        let raf = 0;
        const tick = () => {
            analyser.getFloatTimeDomainData(buf);
            let peak = 0;
            let sumsq = 0;
            for (let i = 0; i < buf.length; i++) {
                const v = Math.abs(buf[i]);
                if (v > peak) peak = v;
                sumsq += buf[i] * buf[i];
            }
            const rms = Math.sqrt(sumsq / buf.length);
            setPeakDb(peak > 0 ? 20 * Math.log10(peak) : -60);
            setRmsDb(rms > 0 ? 20 * Math.log10(rms) : -60);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(raf);
            try { src.disconnect(); } catch { /* ignore */ }
            ctx.close().catch(() => { /* ignore */ });
        };
    }, [stream]);
    const pct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    const peakPct = pct(peakDb);
    const rmsPct = pct(rmsDb);
    const tone = peakDb >= -1 ? "bg-red-500" : peakDb >= -6 ? "bg-amber-500" : "bg-emerald-500";
    return (
        <div className="space-y-1">
            <div className="relative h-3 w-full overflow-hidden rounded bg-muted">
                <div className={`absolute inset-y-0 left-0 ${tone} transition-[width] duration-75`} style={{ width: `${peakPct}%` }} />
                <div className="absolute inset-y-0 left-0 bg-white/40" style={{ width: `${rmsPct}%` }} />
                <div className="absolute inset-y-0 border-l border-white/60" style={{ left: "90%" }} title="-6 dB safety ceiling" />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                <span>peak {peakDb.toFixed(1)} dB</span>
                <span>rms {rmsDb.toFixed(1)} dB</span>
                <span className={peakDb >= -1 ? "text-red-500" : peakDb >= -6 ? "text-amber-500" : "text-emerald-500"}>
                    {peakDb >= -1 ? "CLIPPING" : peakDb >= -6 ? "hot" : peakDb < -30 ? "too quiet" : "good"}
                </span>
            </div>
        </div>
    );
}

function ClipList({
    clips,
    referenceIdx,
    onPickReference,
    onRemove,
    analyses,
    onRerecord,
}: {
    clips: StagedClip[];
    referenceIdx: number;
    onPickReference: (idx: number) => void;
    onRemove: (stagedId: string) => void;
    analyses?: Record<string, ClipAnalysisState>;
    onRerecord?: (promptId: string) => void;
}) {
    if (!clips.length) return null;
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {clips.map((c, idx) => {
                const a = analyses?.[c.stagedId];
                return (
                <Card key={c.stagedId} className={`p-3 flex flex-col gap-2 ${idx === referenceIdx ? "border-primary" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium truncate">{c.label}</span>
                            {c.promptLanguage && (
                                <Badge variant="outline" className="uppercase">{c.promptLanguage}</Badge>
                            )}
                            {c.promptIntent && (
                                <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${INTENT_META[c.promptIntent].tone}`}>
                                    {INTENT_META[c.promptIntent].label}
                                </span>
                            )}
                            {a?.analysis && (
                                <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${a.analysis.overall === "pass" ? "bg-emerald-500/15 text-emerald-500" : a.analysis.overall === "warn" ? "bg-amber-500/15 text-amber-500" : "bg-red-500/15 text-red-500"}`}>
                                    {a.analysis.overall}
                                </span>
                            )}
                        </div>
                        {idx === referenceIdx ? <Badge>reference</Badge> : (
                            <Button size="sm" variant="outline" onClick={() => onPickReference(idx)}>Use as reference</Button>
                        )}
                    </div>
                    {c.promptText && (
                        <p className="text-xs text-muted-foreground italic line-clamp-2">“{c.promptText}”</p>
                    )}
                    <audio src={c.blobUrl} controls className="w-full h-9" />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{(c.bytes / 1024).toFixed(1)} KB{c.durationSec ? ` · ${c.durationSec.toFixed(1)}s` : ""}</span>
                        <Button size="sm" variant="ghost" className="text-destructive h-7" onClick={() => onRemove(c.stagedId)}>Remove</Button>
                    </div>
                    {a && (
                        <VerdictPanel
                            state={a}
                            canRerecord={!!c.promptId && !!onRerecord}
                            onRerecord={() => c.promptId && onRerecord?.(c.promptId)}
                        />
                    )}
                </Card>
                );
            })}
        </div>
    );
}

function VerdictPanel({ state, canRerecord, onRerecord }: { state: ClipAnalysisState; canRerecord: boolean; onRerecord: () => void }) {
    if (state.loading) {
        return <p className="text-xs text-muted-foreground">Analyzing take…</p>;
    }
    if (state.error) {
        return <p className="text-xs text-red-500">Analyzer: {state.error}</p>;
    }
    const a = state.analysis;
    if (!a) return null;
    return (
        <div className="border-t pt-2 mt-1 space-y-1.5">
            <ul className="space-y-0.5">
                {a.verdicts.map((v) => (
                    <li key={v.key} className="flex items-start gap-2 text-xs">
                        <span className={`mt-0.5 inline-block w-3 text-center font-bold ${v.status === "pass" ? "text-emerald-500" : v.status === "warn" ? "text-amber-500" : "text-red-500"}`}>
                            {v.status === "pass" ? "✓" : v.status === "warn" ? "!" : "×"}
                        </span>
                        <span className="text-muted-foreground">{v.msg}</span>
                    </li>
                ))}
            </ul>
            {a.transcript?.transcript && (
                <p className="text-[11px] text-muted-foreground">
                    Heard: <span className="italic">“{a.transcript.transcript}”</span>
                    {typeof a.transcript.wer === "number" && (
                        <span className="ml-1">· WER {(a.transcript.wer * 100).toFixed(0)}%</span>
                    )}
                </p>
            )}
            {state.coachLoading && (
                <p className="text-xs text-muted-foreground italic">Coach is listening…</p>
            )}
            {state.coachNote && (
                <div className="text-xs italic text-primary/90 border-l-2 border-primary/40 pl-2 mt-1">
                    {state.coachNote}
                </div>
            )}
            {state.coachError && !state.coachNote && (
                <p className="text-[11px] text-muted-foreground">
                    Coach offline ({state.coachError}). Configure a Chat model in <a href="/settings/copilot?tab=roles" className="underline">Copilot settings</a>.
                </p>
            )}
            {a.overall === "fail" && canRerecord && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onRerecord}>
                    Re-record this prompt
                </Button>
            )}
        </div>
    );
}

function PromptCoach({
    queue,
    idx,
    covered,
    current,
    onSkip,
    onPick,
    recording,
}: {
    queue: TrainingPrompt[];
    idx: number;
    covered: Set<string>;
    current: TrainingPrompt | undefined;
    onSkip: () => void;
    onPick: (i: number) => void;
    recording: boolean;
}) {
    if (!current || !queue.length) return null;
    const intent = INTENT_META[current.intent];
    const safeIdx = idx % queue.length;
    return (
        <Card className="p-5 space-y-4 border-primary/40 bg-primary/[0.03]">
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="uppercase text-xs">{current.language}</Badge>
                    <span className={`rounded px-2 py-0.5 text-[11px] uppercase tracking-wide ${intent.tone}`}>
                        {intent.emoji} {intent.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        Prompt {safeIdx + 1} of {queue.length}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={recording} onClick={onSkip}>
                        Skip / next prompt
                    </Button>
                </div>
            </div>

            <p className="text-xl leading-relaxed font-medium tracking-tight">
                “{current.text}”
            </p>
            <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">How to say it: </span>
                {current.hint}
            </p>

            <div className="flex flex-wrap gap-1.5 pt-1">
                {queue.map((p, i) => {
                    const isCurrent = i === safeIdx;
                    const done = covered.has(p.id);
                    const meta = INTENT_META[p.intent];
                    return (
                        <button
                            key={p.id}
                            type="button"
                            disabled={recording}
                            onClick={() => onPick(i)}
                            title={`${p.language.toUpperCase()} · ${meta.label}`}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide transition ${isCurrent ? "border-primary bg-primary text-primary-foreground" : done ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-border text-muted-foreground hover:bg-accent"}`}
                        >
                            <span>{p.language}</span>
                            <span>·</span>
                            <span>{meta.label}</span>
                            {done && !isCurrent && <span>✓</span>}
                        </button>
                    );
                })}
            </div>
        </Card>
    );
}

// ────────────────────────────────────────────────────────────────────
// PROMPT MODE TOGGLE  (speak ↔ sing)
// ────────────────────────────────────────────────────────────────────

function PromptModeToggle({
    mode,
    onChange,
    disabled,
}: {
    mode: "speak" | "sing";
    onChange: (m: "speak" | "sing") => void;
    disabled?: boolean;
}) {
    const opts: Array<{ k: "speak" | "sing"; label: string; hint: string }> = [
        { k: "speak", label: "Speak", hint: "Spoken prompts cover timbre + intent across six emotions." },
        { k: "sing", label: "Sing", hint: "Sung prompts walk a major scale low → mid → high so XTTS / RVC training has full pitch range." },
    ];
    return (
        <div className="flex items-stretch gap-2">
            {opts.map((o) => {
                const active = mode === o.k;
                return (
                    <button
                        key={o.k}
                        type="button"
                        disabled={disabled}
                        onClick={() => onChange(o.k)}
                        className={`flex-1 rounded-md border px-3 py-2 text-left transition ${active ? "border-primary bg-primary/10" : "border-border hover:bg-accent"} ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
                    >
                        <div className="text-sm font-medium">{o.label}</div>
                        <div className="text-[11px] text-muted-foreground leading-snug">{o.hint}</div>
                    </button>
                );
            })}
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────
// SUNG PROMPT COACH  (scale walks for pitch-range training)
// ────────────────────────────────────────────────────────────────────

const TIER_TONE: Record<"low" | "mid" | "high", string> = {
    low: "bg-indigo-500/15 text-indigo-300",
    mid: "bg-emerald-500/15 text-emerald-300",
    high: "bg-amber-500/15 text-amber-300",
};

function SungPromptCoach({
    queue,
    idx,
    covered,
    current,
    onSkip,
    onPick,
    recording,
}: {
    queue: SungPhrasePrompt[];
    idx: number;
    covered: Set<string>;
    current: SungPhrasePrompt | undefined;
    onSkip: () => void;
    onPick: (i: number) => void;
    recording: boolean;
}) {
    if (!current || !queue.length) return null;
    const safeIdx = idx % queue.length;
    const lowNote = midiToName(current.rootMidi);
    const highNote = midiToName(current.rootMidi + 12);
    return (
        <Card className="p-5 space-y-4 border-primary/40 bg-primary/[0.03]">
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="uppercase text-xs">{current.language}</Badge>
                    <span className={`rounded px-2 py-0.5 text-[11px] uppercase tracking-wide ${TIER_TONE[current.tier]}`}>
                        ♪ sing {current.tier}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                        {lowNote} → {highNote}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        Prompt {safeIdx + 1} of {queue.length}
                    </span>
                </div>
                <Button size="sm" variant="outline" disabled={recording} onClick={onSkip}>
                    Skip / next prompt
                </Button>
            </div>

            <p className="text-xl leading-relaxed font-medium tracking-tight">
                “{current.text}”
            </p>

            <div className="flex items-end gap-1.5 h-16">
                {current.melody.map((n, i) => {
                    const lo = current.rootMidi;
                    const hi = current.rootMidi + 12;
                    const pct = ((n.midiPitch - lo) / Math.max(1, hi - lo)) * 100;
                    return (
                        <div key={i} className="flex flex-col items-center gap-1 flex-1">
                            <div className="w-full bg-muted rounded-sm relative" style={{ height: "100%" }}>
                                <div
                                    className="absolute bottom-0 left-0 right-0 bg-primary/70 rounded-sm"
                                    style={{ height: `${Math.max(4, pct)}%` }}
                                />
                            </div>
                            <span className="text-[9px] font-mono text-muted-foreground">
                                {midiToName(n.midiPitch)}
                            </span>
                        </div>
                    );
                })}
            </div>

            <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">How to sing it: </span>
                {current.hint}
            </p>

            <div className="flex flex-wrap gap-1.5 pt-1">
                {queue.map((p, i) => {
                    const isCurrent = i === safeIdx;
                    const done = covered.has(p.id);
                    return (
                        <button
                            key={p.id}
                            type="button"
                            disabled={recording}
                            onClick={() => onPick(i)}
                            title={`${p.language.toUpperCase()} · sing ${p.tier}`}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide transition ${isCurrent ? "border-primary bg-primary text-primary-foreground" : done ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-border text-muted-foreground hover:bg-accent"}`}
                        >
                            <span>{p.language}</span>
                            <span>·</span>
                            <span>{p.tier}</span>
                            {done && !isCurrent && <span>✓</span>}
                        </button>
                    );
                })}
            </div>
        </Card>
    );
}

// ────────────────────────────────────────────────────────────────────
// PITCH COVERAGE METER  (review-step diagnostic for sung samples)
// ────────────────────────────────────────────────────────────────────

const PITCH_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToName(midi: number): string {
    const name = PITCH_NOTE_NAMES[((midi % 12) + 12) % 12];
    const oct = Math.floor(midi / 12) - 1;
    return `${name}${oct}`;
}

function PitchCoverageBlock({ stagedIds }: { stagedIds: string[] }) {
    const [loading, setLoading] = useState(false);
    const [report, setReport] = useState<PitchCoverageReport | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const lastKeyRef = useRef<string>("");

    const key = stagedIds.join("|");
    useEffect(() => {
        if (!stagedIds.length || key === lastKeyRef.current) return;
        lastKeyRef.current = key;
        setLoading(true);
        setErr(null);
        (async () => {
            try {
                const r = await analyzeVoicePitchCoverage({ stagedIds });
                setReport(r);
                if (!r) setErr("Companion unreachable or no voiced audio detected.");
            } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
            } finally {
                setLoading(false);
            }
        })();
    }, [key, stagedIds]);

    if (!stagedIds.length) return null;

    return (
        <Card className="p-4 space-y-3 border-primary/30 bg-primary/[0.02]">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="space-y-0.5">
                    <h4 className="text-sm font-medium">Pitch coverage</h4>
                    <p className="text-xs text-muted-foreground">
                        How many semitones across C2–C6 your clips reach. Wider coverage = better singing synthesis range.
                    </p>
                </div>
                {report && (
                    <Badge
                        variant={report.verdict === "pass" ? "default" : "outline"}
                        className={report.verdict === "pass" ? "" : report.verdict === "warn" ? "border-amber-500 text-amber-500" : "border-red-500 text-red-500"}
                    >
                        {(report.coveragePct).toFixed(0)}% covered · {report.verdict}
                    </Badge>
                )}
            </div>

            {loading && <p className="text-xs text-muted-foreground">Analyzing pitch on companion…</p>}
            {err && !loading && <p className="text-xs text-amber-500">{err}</p>}

            {report && !loading && (
                <>
                    <PitchHistogram report={report} />
                    {report.biggestGaps.length > 0 && (
                        <div className="text-xs text-muted-foreground space-y-1">
                            <div className="font-medium text-foreground">Largest gaps:</div>
                            <ul className="space-y-0.5">
                                {report.biggestGaps.map((g, i) => (
                                    <li key={i} className="font-mono">
                                        {midiToName(g.fromMidi)} → {midiToName(g.toMidi)} · {g.lengthSemis} semitones uncovered
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                        {report.voicedSecTotal.toFixed(1)}s voiced of {report.audioSecTotal.toFixed(1)}s analyzed across {stagedIds.length} clip{stagedIds.length === 1 ? "" : "s"}.
                        {report.verdict !== "pass" && " Record extra clips on the missing pitches to broaden range."}
                    </p>
                </>
            )}
        </Card>
    );
}

function PitchHistogram({ report }: { report: PitchCoverageReport }) {
    const max = Math.max(0.001, ...report.histogram.map((b) => b.voicedSec));
    return (
        <div className="space-y-1">
            <div className="flex items-end gap-[1px] h-16">
                {report.histogram.map((b) => {
                    const h = (b.voicedSec / max) * 100;
                    const covered = b.voicedSec >= 0.2;
                    const isC = b.midi % 12 === 0;
                    return (
                        <div
                            key={b.midi}
                            title={`${midiToName(b.midi)} · ${b.voicedSec.toFixed(2)}s`}
                            className="flex-1 min-w-[2px] relative"
                        >
                            <div
                                className={`absolute bottom-0 left-0 right-0 ${covered ? "bg-emerald-500" : "bg-muted"} transition-all`}
                                style={{ height: `${Math.max(2, h)}%` }}
                            />
                            {isC && (
                                <div className="absolute -bottom-3.5 left-0 right-0 text-center text-[8px] text-muted-foreground font-mono">
                                    {midiToName(b.midi)}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="h-3" />
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────
// RVC CONVERT PANEL  (retarget timbre on an existing generated asset)
// ────────────────────────────────────────────────────────────────────

const F0_METHODS = ["rmvpe", "pm", "harvest", "crepe"] as const;
type F0Method = (typeof F0_METHODS)[number];

function RVCConvertPanel() {
    const [models, setModels] = useState<RVCModelMeta[] | null>(null);
    const [assets, setAssets] = useState<GeneratedAssetDto[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedAssetId, setSelectedAssetId] = useState<string>("");
    const [selectedModelId, setSelectedModelId] = useState<string>("");
    const [pitchSemitones, setPitchSemitones] = useState(0);
    const [indexRate, setIndexRate] = useState(0.66);
    const [f0Method, setF0Method] = useState<F0Method>("rmvpe");
    const [isolateFirst, setIsolateFirst] = useState(true);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ url: string; remixUrl?: string } | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const [m, a] = await Promise.all([
                    listVoiceConversionModels(),
                    listGeneratedAssets(),
                ]);
                setModels(m);
                if (m.length > 0) setSelectedModelId(m[0].id);
                const audio = a.filter((x) => x.status === "ready" && x.fileUrl);
                setAssets(audio);
                if (audio.length > 0) setSelectedAssetId(audio[0].id);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const onConvert = useCallback(async () => {
        if (!selectedAssetId || !selectedModelId) {
            toast.error("Pick an asset and a voice model first.");
            return;
        }
        setBusy(true);
        setResult(null);
        try {
            const res = await convertAssetWithRVC({
                assetId: selectedAssetId,
                modelId: selectedModelId,
                pitchSemitones,
                indexRate,
                f0Method,
                isolateFirst,
            });
            if (!res.ok) {
                toast.error(res.error);
                return;
            }
            setResult({ url: res.url, remixUrl: res.remixUrl });
            toast.success("Conversion ready.");
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [selectedAssetId, selectedModelId, pitchSemitones, indexRate, f0Method, isolateFirst]);

    if (loading) {
        return <Card className="p-6 text-sm text-muted-foreground">Loading models and assets…</Card>;
    }

    if (error) {
        return <Card className="p-6 text-sm text-red-500">Error: {error}</Card>;
    }

    if (!models || models.length === 0) {
        return (
            <Card className="p-6 space-y-3">
                <h3 className="text-lg font-medium">No RVC voice models installed</h3>
                <p className="text-sm text-muted-foreground">
                    Drop trained RVC v2 model folders into the companion's voices directory under{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5">.rvc-models/&lt;model-id&gt;/</code>.
                    Each folder needs a <code>model.pth</code> and (optionally) an <code>added_*.index</code>.
                </p>
                <p className="text-xs text-muted-foreground">
                    The companion sidecar will try <code>rvc_python</code> first, then fall back to an Applio
                    install pointed at by the <code>MMO_APPLIO_DIR</code> environment variable.
                </p>
            </Card>
        );
    }

    if (assets.length === 0) {
        return (
            <Card className="p-6 text-sm text-muted-foreground">
                No generated audio assets yet. Use the DAW or Maestro to create a vocal first, then come back here to retarget its timbre.
            </Card>
        );
    }

    return (
        <Card className="p-6 space-y-5">
            <div>
                <h3 className="text-lg font-medium">Convert vocal timbre with RVC</h3>
                <p className="text-sm text-muted-foreground mt-1">
                    Re-sings any existing vocal in the timbre of one of your trained RVC v2 models. Pitch and rhythm
                    are preserved exactly; only the voice changes. Optionally run Demucs first to extract vocals from
                    a full song and re-mix the converted vocal back on top.
                </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                    <Label>Source asset</Label>
                    <Select value={selectedAssetId} onValueChange={setSelectedAssetId}>
                        <SelectTrigger><SelectValue placeholder="Pick an audio asset…" /></SelectTrigger>
                        <SelectContent>
                            {assets.map((a) => (
                                <SelectItem key={a.id} value={a.id}>
                                    {a.kind} · {a.prompt?.slice(0, 60) ?? "(no prompt)"} · {a.durationSec?.toFixed(1) ?? "?"}s
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <Label>Target voice (RVC model)</Label>
                    <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {models.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                    {m.id}{m.index ? " (with index)" : ""}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                    <Label>Pitch shift (semitones)</Label>
                    <Input
                        type="number"
                        min={-24}
                        max={24}
                        step={1}
                        value={pitchSemitones}
                        onChange={(e) => setPitchSemitones(Math.max(-24, Math.min(24, Number(e.target.value) || 0)))}
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">+12 = up an octave (male→female). 0 = preserve.</p>
                </div>
                <div>
                    <Label>Index rate</Label>
                    <Input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={indexRate}
                        onChange={(e) => setIndexRate(Math.max(0, Math.min(1, Number(e.target.value) || 0)))}
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">0.66 typical. Higher = stronger speaker identity.</p>
                </div>
                <div>
                    <Label>F0 detector</Label>
                    <Select value={f0Method} onValueChange={(v) => setF0Method(v as F0Method)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {F0_METHODS.map((m) => (
                                <SelectItem key={m} value={m}>{m}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted-foreground mt-1">rmvpe is the best default for singing.</p>
                </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
                <input
                    type="checkbox"
                    checked={isolateFirst}
                    onChange={(e) => setIsolateFirst(e.target.checked)}
                    className="h-4 w-4"
                />
                <span>Isolate vocals with Demucs first, then re-mix converted vocal back over the backing track</span>
            </label>

            <div className="flex items-center gap-3 pt-2">
                <Button onClick={onConvert} disabled={busy || !selectedAssetId || !selectedModelId} size="lg">
                    {busy ? "Converting…" : "Convert"}
                </Button>
                {busy && <Progress value={70} className="w-32 h-2" />}
            </div>

            {result && (
                <div className="space-y-3 pt-2 border-t">
                    <div>
                        <Label className="text-xs">Converted vocal</Label>
                        <audio src={result.url} controls className="w-full h-9 mt-1" />
                    </div>
                    {result.remixUrl && (
                        <div>
                            <Label className="text-xs">Re-mixed full song</Label>
                            <audio src={result.remixUrl} controls className="w-full h-9 mt-1" />
                        </div>
                    )}
                </div>
            )}
        </Card>
    );
}
