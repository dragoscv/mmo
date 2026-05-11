"use client";

import { useState, useTransition } from "react";
import { Key, Trash2, Save, ExternalLink, Sparkles } from "lucide-react";
import {
    setAiKeyAction,
    deleteAiKeyAction,
} from "@/actions/ai-keys";
import { setPreferredAiProvider } from "@/actions/ai-tag";
import {
    SUPPORTED_PROVIDERS,
    type AiKeyInfo,
    type AiProvider,
} from "@/lib/ai-providers";
import { cn } from "@/lib/utils";

const PROVIDER_META: Record<AiProvider, { label: string; signupUrl: string; placeholder: string }> = {
    openai: { label: "OpenAI", signupUrl: "https://platform.openai.com/api-keys", placeholder: "sk-…" },
    anthropic: { label: "Anthropic", signupUrl: "https://console.anthropic.com/settings/keys", placeholder: "sk-ant-…" },
    google: { label: "Google AI", signupUrl: "https://aistudio.google.com/apikey", placeholder: "AIza…" },
    mistral: { label: "Mistral", signupUrl: "https://console.mistral.ai/api-keys", placeholder: "…" },
    groq: { label: "Groq", signupUrl: "https://console.groq.com/keys", placeholder: "gsk_…" },
};

export function AiKeysPanel({
    keys,
    preferredProvider,
}: {
    keys: AiKeyInfo[];
    preferredProvider: AiProvider | null;
}) {
    const [pending, startTransition] = useTransition();
    const [picked, setPicked] = useState<AiProvider | null>(preferredProvider);
    const configured = SUPPORTED_PROVIDERS.filter((p) => keys.find((k) => k.provider === p)?.isSet);

    const choose = (next: AiProvider | null) => {
        if (next === picked) return;
        const previous = picked;
        setPicked(next);
        startTransition(async () => {
            const r = await setPreferredAiProvider(next);
            if (!r.ok) setPicked(previous); // rollback on failure
        });
    };

    return (
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
            <header>
                <h2 className="flex items-center gap-2 text-base font-semibold">
                    <Key className="h-4 w-4 text-muted-foreground" />
                    AI provider keys
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                    Bring your own keys. Stored encrypted (AES-256-GCM) in this app&apos;s database;
                    never sent to the client. Used by genre suggestion, lyrics search, and chat features.
                </p>
            </header>

            <ul className="divide-y divide-border">
                {SUPPORTED_PROVIDERS.map((p) => {
                    const info = keys.find((k) => k.provider === p) ?? { provider: p, isSet: false, masked: "", updatedAt: null };
                    return <KeyRow key={p} info={info} />;
                })}
            </ul>

            {configured.length > 0 && (
                <fieldset className="rounded-lg border border-border bg-background/40 p-3 space-y-2">
                    <legend className="px-1 text-xs font-medium text-muted-foreground inline-flex items-center gap-1.5">
                        <Sparkles className="h-3 w-3" />
                        Preferred provider
                    </legend>
                    <p className="text-xs text-muted-foreground">
                        Used first by AI features (track tag suggestion, etc.). Falls back to any other configured provider if this one fails.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => choose(null)}
                            disabled={pending}
                            aria-pressed={picked === null}
                            className={cn(
                                "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                                picked === null
                                    ? "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200"
                                    : "border-border bg-background hover:bg-muted",
                            )}
                        >
                            Auto
                        </button>
                        {configured.map((p) => (
                            <button
                                key={p}
                                type="button"
                                onClick={() => choose(p)}
                                disabled={pending}
                                aria-pressed={picked === p}
                                className={cn(
                                    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                                    picked === p
                                        ? "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200"
                                        : "border-border bg-background hover:bg-muted",
                                )}
                            >
                                {PROVIDER_META[p].label}
                            </button>
                        ))}
                    </div>
                </fieldset>
            )}
        </section>
    );
}

function KeyRow({ info }: { info: AiKeyInfo }) {
    const [pending, startTransition] = useTransition();
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const meta = PROVIDER_META[info.provider];

    const save = () => {
        setError(null);
        startTransition(async () => {
            const r = await setAiKeyAction(info.provider, value);
            if (!r.ok) { setError(r.error ?? "Failed"); return; }
            setEditing(false);
            setValue("");
        });
    };

    const remove = () => {
        if (!window.confirm(`Remove the ${meta.label} key?`)) return;
        startTransition(async () => { await deleteAiKeyAction(info.provider); });
    };

    return (
        <li className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                        {meta.label}
                        <a
                            href={meta.signupUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                            aria-label={`Open ${meta.label} dashboard`}
                        >
                            <ExternalLink className="h-3 w-3" />
                        </a>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                        {info.isSet ? info.masked : <span className="italic text-muted-foreground/70">not configured</span>}
                    </p>
                </div>

                {!editing && (
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => setEditing(true)}
                            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                        >
                            {info.isSet ? "Replace" : "Add"}
                        </button>
                        {info.isSet && (
                            <button
                                type="button"
                                onClick={remove}
                                disabled={pending}
                                className="rounded-md border border-border px-2 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
                                aria-label={`Remove ${meta.label} key`}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                )}
            </div>

            {editing && (
                <div className="mt-3 flex items-center gap-2">
                    <input
                        type="password"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={meta.placeholder}
                        autoComplete="off"
                        className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono"
                        aria-label={`${meta.label} API key`}
                    />
                    <button
                        type="button"
                        onClick={save}
                        disabled={pending || value.length < 8}
                        className={cn(
                            "rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted",
                            (pending || value.length < 8) && "opacity-60 cursor-not-allowed",
                        )}
                    >
                        <Save className="inline h-3.5 w-3.5 mr-1" />
                        Save
                    </button>
                    <button
                        type="button"
                        onClick={() => { setEditing(false); setValue(""); setError(null); }}
                        className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
                    >
                        Cancel
                    </button>
                </div>
            )}
            {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
        </li>
    );
}
