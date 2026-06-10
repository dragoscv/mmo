"use client";

/**
 * Copilot settings UI — 8 tabs (Accounts / Models / Roles / Agent /
 * Generation / Privacy / Usage / Developer). Animated tab transitions
 * via framer-motion. Device-code modal handles GitHub Copilot sign-in
 * with copy-to-clipboard and live polling.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
    Copy,
    ExternalLink,
    KeyRound,
    Loader2,
    Plus,
    RefreshCw,
    Sparkles,
    Trash2,
    X,
} from "lucide-react";

function GitHubMark({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.1c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11.04 11.04 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.13v3.16c0 .31.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
        </svg>
    );
}

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import {
    cancelCopilotDeviceFlow,
    deleteConnection,
    listConnections,
    listModelChoices,
    listModelsForConnection,
    pollCopilotDeviceFlow,
    setModelChoice,
    startCopilotDeviceFlow,
    upsertApiKeyConnection,
    type ConnectionDto,
    type DeviceFlowDto,
    type ModelChoiceDto,
    type ModelDto,
} from "@/actions/copilot";
import { listMcpAuditEntries, exportMcpAuditCsv, type McpAuditSummary, type McpAuditStatus, type McpAuditEntry } from "@/actions/mcp-audit";
import {
    AI_PREFS_DEFAULTS,
    type AiPrefs,
} from "@/lib/ai-prefs-types";
import {
    getAiPrefs,
    setAiPref,
} from "@/actions/ai-prefs";
import {
    PAT_SCOPES,
    type PatScope,
} from "@/lib/agent-pat-scopes";
import {
    createPat,
    listPats,
    revokePat,
    type PatRowDto,
} from "@/actions/agent-pats";
import { MODEL_ROLES, MODEL_ROLE_LABELS, type ModelRole } from "@mmo/ai/models";
import { PROVIDER_IDS, type ProviderId } from "@mmo/ai/providers/types";

const NON_COPILOT_PROVIDERS = PROVIDER_IDS.filter((p) => p !== "copilot");

const PROVIDER_LABELS: Record<ProviderId, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    mistral: "Mistral",
    groq: "Groq",
    azure: "Azure",
    copilot: "GitHub Copilot",
};

interface Props {
    initialConnections: ConnectionDto[];
    initialChoices: ModelChoiceDto[];
}

export function CopilotSettingsClient({ initialConnections, initialChoices }: Props) {
    const [connections, setConnections] = useState(initialConnections);
    const [choices, setChoices] = useState(initialChoices);
    const router = useRouter();
    const searchParams = useSearchParams();
    const VALID_TABS = useMemo(
        () => ["accounts", "models", "roles", "agent", "generation", "privacy", "usage", "mcp", "developer"],
        [],
    );
    const urlTab = searchParams.get("tab");
    const activeTab = urlTab && VALID_TABS.includes(urlTab) ? urlTab : "accounts";
    const onTabChange = useCallback(
        (value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set("tab", value);
            router.replace(`?${params.toString()}`, { scroll: false });
        },
        [router, searchParams],
    );

    const refresh = useCallback(async () => {
        const [c, m] = await Promise.all([listConnections(), listModelChoices()]);
        setConnections(c);
        setChoices(m);
    }, []);

    return (
        <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
            <TabsList className="grid h-auto w-full grid-cols-3 gap-1 sm:grid-cols-5 lg:grid-cols-9">
                <TabsTrigger value="accounts">Accounts</TabsTrigger>
                <TabsTrigger value="models">Models</TabsTrigger>
                <TabsTrigger value="roles">Roles</TabsTrigger>
                <TabsTrigger value="agent">Agent</TabsTrigger>
                <TabsTrigger value="generation">Generation</TabsTrigger>
                <TabsTrigger value="privacy">Privacy</TabsTrigger>
                <TabsTrigger value="usage">Usage</TabsTrigger>
                <TabsTrigger value="mcp">MCP</TabsTrigger>
                <TabsTrigger value="developer">Developer</TabsTrigger>
            </TabsList>

            <AnimatedPanel value="accounts">
                <AccountsTab connections={connections} onChange={refresh} />
            </AnimatedPanel>

            <AnimatedPanel value="models">
                <ModelsTab connections={connections} />
            </AnimatedPanel>

            <AnimatedPanel value="roles">
                <RolesTab connections={connections} choices={choices} onChange={refresh} />
            </AnimatedPanel>

            <AnimatedPanel value="agent">
                <AgentTab />
            </AnimatedPanel>

            <AnimatedPanel value="generation">
                <GenerationTab />
            </AnimatedPanel>

            <AnimatedPanel value="privacy">
                <PrivacyTab />
            </AnimatedPanel>

            <AnimatedPanel value="usage">
                <UsageTab connections={connections} />
            </AnimatedPanel>

            <AnimatedPanel value="mcp">
                <McpTab />
            </AnimatedPanel>

            <AnimatedPanel value="developer">
                <DeveloperTab />
            </AnimatedPanel>
        </Tabs>
    );
}

function AnimatedPanel({ value, children }: { value: string; children: React.ReactNode }) {
    return (
        <TabsContent value={value} className="mt-6">
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
            >
                {children}
            </motion.div>
        </TabsContent>
    );
}

// ─── Accounts tab ──────────────────────────────────────────────────────────

function AccountsTab({
    connections,
    onChange,
}: {
    connections: ConnectionDto[];
    onChange: () => Promise<void>;
}) {
    const [flow, setFlow] = useState<DeviceFlowDto | null>(null);
    const [flowStatus, setFlowStatus] = useState<"idle" | "polling" | "success" | "error" | "expired" | "denied">("idle");
    const [flowError, setFlowError] = useState<string | null>(null);
    const [starting, startTransition] = useTransition();
    const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (pollRef.current) clearTimeout(pollRef.current);
    }, []);

    const startDeviceFlow = (clientStrategy: "vscode" | "custom", clientId?: string) => {
        setFlowError(null);
        startTransition(async () => {
            try {
                const f = await startCopilotDeviceFlow({ clientStrategy, clientId });
                setFlow(f);
                setFlowStatus("polling");
                schedulePoll(f);
            } catch (e) {
                setFlowError(e instanceof Error ? e.message : String(e));
                setFlowStatus("error");
            }
        });
    };

    const schedulePoll = (f: DeviceFlowDto) => {
        if (pollRef.current) clearTimeout(pollRef.current);
        pollRef.current = setTimeout(async () => {
            try {
                const res = await pollCopilotDeviceFlow(f.flowId);
                if (res.status === "pending") {
                    schedulePoll(f);
                    return;
                }
                setFlowStatus(res.status === "success" ? "success" : (res.status === "expired" ? "expired" : (res.status === "denied" ? "denied" : "error")));
                if (res.error) setFlowError(res.error);
                if (res.status === "success") {
                    await onChange();
                    setTimeout(() => setFlow(null), 1200);
                }
            } catch (e) {
                setFlowError(e instanceof Error ? e.message : String(e));
                setFlowStatus("error");
            }
        }, f.intervalSec * 1000);
    };

    const cancelFlow = async () => {
        if (pollRef.current) clearTimeout(pollRef.current);
        if (flow) await cancelCopilotDeviceFlow(flow.flowId);
        setFlow(null);
        setFlowStatus("idle");
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-lg font-medium">Connected accounts</h2>
                    <p className="text-sm text-muted-foreground">
                        Connect at least one provider so Maestro and the DAW
                        generators can call models on your behalf.
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        onClick={() => startDeviceFlow("vscode")}
                        disabled={starting}
                        className="gap-2"
                    >
                        <GitHubMark className="h-4 w-4" />
                        Connect with GitHub Copilot
                    </Button>
                </div>
            </div>

            {connections.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                        <Sparkles className="h-8 w-8 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">No providers connected yet.</p>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                    {connections.map((c) => (
                        <ConnectionCard key={c.id} c={c} onChange={onChange} />
                    ))}
                </div>
            )}

            <AddApiKeyCard onSaved={onChange} />

            <DeviceCodeModal
                flow={flow}
                status={flowStatus}
                error={flowError}
                onCancel={cancelFlow}
            />
        </div>
    );
}

function ConnectionCard({ c, onChange }: { c: ConnectionDto; onChange: () => Promise<void> }) {
    const [removing, removeTransition] = useTransition();
    const expired = c.sessionExpiresAt && c.sessionExpiresAt.getTime() < Date.now();
    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-base">
                            {c.isCopilot ? <GitHubMark className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                            {PROVIDER_LABELS[c.provider]}
                        </CardTitle>
                        <CardDescription>
                            {c.label}
                            {c.isCopilot && c.copilotClientStrategy ? ` · ${c.copilotClientStrategy}` : null}
                        </CardDescription>
                    </div>
                    <Badge variant={c.status === "active" && !expired ? "default" : "secondary"}>
                        {expired ? "session expired" : c.status}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-1">
                {c.sessionExpiresAt && (
                    <p>Session expires: {c.sessionExpiresAt.toLocaleString()}</p>
                )}
                {c.lastVerifiedAt && <p>Last verified: {c.lastVerifiedAt.toLocaleString()}</p>}
            </CardContent>
            <CardFooter>
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-destructive hover:text-destructive"
                    disabled={removing}
                    onClick={() =>
                        removeTransition(async () => {
                            await deleteConnection(c.id);
                            await onChange();
                        })
                    }
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                </Button>
            </CardFooter>
        </Card>
    );
}

function AddApiKeyCard({ onSaved }: { onSaved: () => Promise<void> }) {
    const [provider, setProvider] = useState<ProviderId>("openai");
    const [label, setLabel] = useState("default");
    const [apiKey, setApiKey] = useState("");
    const [azureEndpoint, setAzureEndpoint] = useState("");
    const [azureDeployment, setAzureDeployment] = useState("gpt-4o-mini");
    const [azureApiVersion, setAzureApiVersion] = useState("2024-10-21");
    const [error, setError] = useState<string | null>(null);
    const [saving, saveTransition] = useTransition();

    const isAzure = provider === "azure";
    const azureOk = !isAzure || (/^https?:\/\//.test(azureEndpoint.trim()) && azureDeployment.trim().length > 0);

    const save = () => {
        setError(null);
        saveTransition(async () => {
            try {
                const endpointsJson = isAzure
                    ? {
                        endpoint: azureEndpoint.trim().replace(/\/$/, ""),
                        deployment: azureDeployment.trim(),
                        apiVersion: azureApiVersion.trim() || "2024-10-21",
                    }
                    : undefined;
                await upsertApiKeyConnection({ provider, label, apiKey, endpointsJson });
                setApiKey("");
                await onSaved();
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        });
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <Plus className="h-4 w-4" />
                    Add provider API key
                </CardTitle>
                <CardDescription>
                    Stored AES-GCM-encrypted at rest. Used only on the server.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                    <Label>Provider</Label>
                    <Select value={provider} onValueChange={(v) => setProvider(v as ProviderId)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {NON_COPILOT_PROVIDERS.map((p) => (
                                <SelectItem key={p} value={p}>{PROVIDER_LABELS[p]}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="space-y-1.5">
                    <Label>Label</Label>
                    <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="default" />
                </div>
                <div className="space-y-1.5 sm:col-span-3">
                    <Label>API key</Label>
                    <Input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={isAzure ? "Azure resource key" : "sk-…"}
                        autoComplete="off"
                    />
                </div>
                {isAzure && (
                    <>
                        <div className="space-y-1.5 sm:col-span-3">
                            <Label>Azure endpoint</Label>
                            <Input
                                value={azureEndpoint}
                                onChange={(e) => setAzureEndpoint(e.target.value)}
                                placeholder="https://<resource>.openai.azure.com/"
                                autoComplete="off"
                            />
                            <p className="text-xs text-muted-foreground">
                                Custom-domain URL from Azure Portal → your OpenAI resource → “Keys and Endpoint”.
                            </p>
                        </div>
                        <div className="space-y-1.5">
                            <Label>Deployment name</Label>
                            <Input
                                value={azureDeployment}
                                onChange={(e) => setAzureDeployment(e.target.value)}
                                placeholder="gpt-4o-mini"
                            />
                        </div>
                        <div className="space-y-1.5 sm:col-span-2">
                            <Label>API version</Label>
                            <Input
                                value={azureApiVersion}
                                onChange={(e) => setAzureApiVersion(e.target.value)}
                                placeholder="2024-10-21"
                            />
                        </div>
                    </>
                )}
                {error && <p className="sm:col-span-3 text-sm text-destructive">{error}</p>}
            </CardContent>
            <CardFooter>
                <Button onClick={save} disabled={saving || apiKey.length < 8 || !azureOk} className="gap-2">
                    {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Save key
                </Button>
            </CardFooter>
        </Card>
    );
}

// ─── Device code modal ────────────────────────────────────────────────────

function DeviceCodeModal({
    flow,
    status,
    error,
    onCancel,
}: {
    flow: DeviceFlowDto | null;
    status: "idle" | "polling" | "success" | "error" | "expired" | "denied";
    error: string | null;
    onCancel: () => void;
}) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(t);
    }, [copied]);

    return (
        <Dialog open={!!flow} onOpenChange={(o) => { if (!o) onCancel(); }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <GitHubMark className="h-5 w-5" />
                        Authorize GitHub Copilot
                    </DialogTitle>
                    <DialogDescription>
                        Enter the code below on GitHub to grant Maestro access to your Copilot models.
                    </DialogDescription>
                </DialogHeader>

                {flow && (
                    <div className="space-y-4">
                        <div className="rounded-lg border bg-muted/50 px-4 py-3">
                            <div className="text-xs uppercase tracking-wider text-muted-foreground">User code</div>
                            <div className="mt-1 flex items-center justify-between">
                                <code className="text-2xl font-mono font-semibold tracking-widest">
                                    {flow.userCode}
                                </code>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="gap-1.5"
                                    onClick={async () => {
                                        await navigator.clipboard.writeText(flow.userCode);
                                        setCopied(true);
                                    }}
                                >
                                    <Copy className="h-3.5 w-3.5" />
                                    {copied ? "Copied" : "Copy"}
                                </Button>
                            </div>
                        </div>

                        <Button asChild className="w-full gap-2">
                            <a href={flow.verificationUri} target="_blank" rel="noreferrer">
                                <ExternalLink className="h-4 w-4" />
                                Open {flow.verificationUri.replace("https://", "")}
                            </a>
                        </Button>

                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <AnimatePresence mode="wait">
                                {status === "polling" && (
                                    <motion.div
                                        key="polling"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        className="flex items-center gap-2"
                                    >
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        Waiting for authorization…
                                    </motion.div>
                                )}
                                {status === "success" && (
                                    <motion.div
                                        key="success"
                                        initial={{ opacity: 0, y: 4 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className="text-emerald-500"
                                    >
                                        Connected! Loading models…
                                    </motion.div>
                                )}
                                {status === "denied" && (
                                    <motion.div key="denied" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-destructive">
                                        Authorization denied.
                                    </motion.div>
                                )}
                                {status === "expired" && (
                                    <motion.div key="expired" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-destructive">
                                        Code expired. Please try again.
                                    </motion.div>
                                )}
                                {status === "error" && error && (
                                    <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-destructive">
                                        {error}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={onCancel} className="gap-2">
                        <X className="h-4 w-4" />
                        Cancel
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─── Models tab ────────────────────────────────────────────────────────────

function ModelsTab({ connections }: { connections: ConnectionDto[] }) {
    const [selected, setSelected] = useState<string | null>(connections[0]?.id ?? null);
    const [models, setModels] = useState<ModelDto[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (id: string) => {
        setLoading(true);
        setError(null);
        try {
            const list = await listModelsForConnection(id);
            setModels(list);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setModels([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (selected) load(selected);
    }, [selected, load]);

    if (connections.length === 0) {
        return <EmptyHint message="Connect a provider on the Accounts tab to list models." />;
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Select value={selected ?? ""} onValueChange={setSelected}>
                    <SelectTrigger className="w-72"><SelectValue placeholder="Pick a connection" /></SelectTrigger>
                    <SelectContent>
                        {connections.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                                {PROVIDER_LABELS[c.provider]} · {c.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2"
                    disabled={!selected || loading}
                    onClick={() => selected && load(selected)}
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                    Refresh
                </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Card>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Model</TableHead>
                            <TableHead>Family</TableHead>
                            <TableHead>Capabilities</TableHead>
                            <TableHead className="text-right">Context</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {models.length === 0 && !loading && (
                            <TableRow>
                                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                                    {selected ? "No models returned." : "Pick a connection."}
                                </TableCell>
                            </TableRow>
                        )}
                        {models.map((m) => (
                            <TableRow key={m.modelId}>
                                <TableCell className="font-medium">{m.label}</TableCell>
                                <TableCell className="text-muted-foreground">{m.family ?? "—"}</TableCell>
                                <TableCell className="space-x-1">
                                    {m.chat && <Badge variant="secondary">chat</Badge>}
                                    {m.tools && <Badge variant="secondary">tools</Badge>}
                                    {m.vision && <Badge variant="secondary">vision</Badge>}
                                    {m.embeddings && <Badge variant="secondary">embed</Badge>}
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground tabular-nums">
                                    {m.contextTokens.toLocaleString()}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </Card>
        </div>
    );
}

// ─── Roles tab ─────────────────────────────────────────────────────────────

function RolesTab({
    connections,
    choices,
    onChange,
}: {
    connections: ConnectionDto[];
    choices: ModelChoiceDto[];
    onChange: () => Promise<void>;
}) {
    const choiceByRole = useMemo(() => {
        const m = new Map<ModelRole, ModelChoiceDto>();
        for (const c of choices) m.set(c.role, c);
        return m;
    }, [choices]);

    if (connections.length === 0) {
        return <EmptyHint message="Connect a provider first, then assign models to roles." />;
    }

    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Each role calls the model you pick. Maestro uses <strong>agent</strong>; the side-panel chat uses <strong>chat</strong>; the rest are reserved for upcoming generators.
            </p>
            <Card>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Role</TableHead>
                            <TableHead>Current</TableHead>
                            <TableHead>Assign</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {MODEL_ROLES.map((role) => (
                            <RoleRow
                                key={role}
                                role={role}
                                connections={connections}
                                current={choiceByRole.get(role)}
                                onChange={onChange}
                            />
                        ))}
                    </TableBody>
                </Table>
            </Card>
        </div>
    );
}

function RoleRow({
    role,
    connections,
    current,
    onChange,
}: {
    role: ModelRole;
    connections: ConnectionDto[];
    current: ModelChoiceDto | undefined;
    onChange: () => Promise<void>;
}) {
    const [connectionId, setConnectionId] = useState(current?.connectionId ?? connections[0]?.id ?? "");
    const [models, setModels] = useState<ModelDto[]>([]);
    const [modelId, setModelId] = useState(current?.modelId ?? "");
    const [saving, saveTransition] = useTransition();
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!connectionId) return;
        setLoading(true);
        listModelsForConnection(connectionId)
            .then((m) => setModels(m))
            .catch(() => setModels([]))
            .finally(() => setLoading(false));
    }, [connectionId]);

    const save = (mid: string) => {
        const conn = connections.find((c) => c.id === connectionId);
        if (!conn) return;
        saveTransition(async () => {
            await setModelChoice({
                role,
                connectionId,
                provider: conn.provider,
                modelId: mid,
            });
            await onChange();
        });
    };

    return (
        <TableRow>
            <TableCell>
                <div className="font-medium">{MODEL_ROLE_LABELS[role]}</div>
                <div className="text-xs text-muted-foreground">{role}</div>
            </TableCell>
            <TableCell className="text-sm">
                {current ? (
                    <>
                        <Badge variant="secondary">{PROVIDER_LABELS[current.provider]}</Badge>
                        <span className="ml-2 text-muted-foreground">{current.modelId}</span>
                    </>
                ) : (
                    <span className="text-muted-foreground">— not set —</span>
                )}
            </TableCell>
            <TableCell>
                <div className="flex gap-2">
                    <Select value={connectionId} onValueChange={setConnectionId}>
                        <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {connections.map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                    {PROVIDER_LABELS[c.provider]}·{c.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select
                        value={modelId}
                        onValueChange={(v) => { setModelId(v); save(v); }}
                        disabled={loading || models.length === 0 || saving}
                    >
                        <SelectTrigger className="w-56">
                            <SelectValue placeholder={loading ? "Loading…" : "Pick a model"} />
                        </SelectTrigger>
                        <SelectContent>
                            {models.map((m) => (
                                <SelectItem key={m.modelId} value={m.modelId}>{m.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </TableCell>
        </TableRow>
    );
}

// ─── Persisted prefs helpers ──────────────────────────────────────────────

function useAiPrefs() {
    const [prefs, setPrefs] = useState<AiPrefs>(AI_PREFS_DEFAULTS);
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
        getAiPrefs().then((p) => { setPrefs(p); setLoaded(true); }).catch(() => setLoaded(true));
    }, []);
    const update = useCallback(<K extends keyof AiPrefs>(key: K, value: AiPrefs[K]) => {
        setPrefs((prev) => ({ ...prev, [key]: value }));
        setAiPref(key, value).catch(() => {/* swallow — UI already updated */});
    }, []);
    return { prefs, update, loaded };
}

// ─── Agent tab ─────────────────────────────────────────────────────────────

function AgentTab() {
    const { prefs, update, loaded } = useAiPrefs();
    return (
        <Card>
            <CardHeader>
                <CardTitle>Maestro agent</CardTitle>
                <CardDescription>Defaults for the in-app AI agent (saved per user).</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                    <Label>Autonomy</Label>
                    <Select
                        value={prefs["ai.agent.autonomy"]}
                        onValueChange={(v) => update("ai.agent.autonomy", v as AiPrefs["ai.agent.autonomy"])}
                        disabled={!loaded}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ask">Ask before every action</SelectItem>
                            <SelectItem value="propose">Propose diffs, confirm to apply</SelectItem>
                            <SelectItem value="auto">Auto (non-destructive only)</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="space-y-1.5">
                    <Label>Max steps per task</Label>
                    <Input
                        type="number" min={1} max={200}
                        value={prefs["ai.agent.maxSteps"]}
                        onChange={(e) => update("ai.agent.maxSteps", Number(e.target.value))}
                        disabled={!loaded}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label>Token budget per task</Label>
                    <Input
                        type="number" min={1000} step={1000}
                        value={prefs["ai.agent.tokenBudget"]}
                        onChange={(e) => update("ai.agent.tokenBudget", Number(e.target.value))}
                        disabled={!loaded}
                    />
                </div>
                <ToggleRow
                    id="destr"
                    label="Allow destructive actions in auto mode"
                    checked={prefs["ai.agent.allowDestructive"]}
                    onChange={(v) => update("ai.agent.allowDestructive", v)}
                />
                <ToggleRow
                    id="vin"
                    label="Voice input (push-to-talk)"
                    checked={prefs["ai.agent.voiceInput"]}
                    onChange={(v) => update("ai.agent.voiceInput", v)}
                />
                <ToggleRow
                    id="vout"
                    label="Voice output (TTS replies)"
                    checked={prefs["ai.agent.voiceOutput"]}
                    onChange={(v) => update("ai.agent.voiceOutput", v)}
                />
            </CardContent>
        </Card>
    );
}

// ─── Generation tab ───────────────────────────────────────────────────────

function GenerationTab() {
    const { prefs, update, loaded } = useAiPrefs();
    return (
        <Card>
            <CardHeader>
                <CardTitle>Generation defaults</CardTitle>
                <CardDescription>
                    Tiers: <strong>T0</strong> = on-device samplers · <strong>T1</strong> = BYO API
                    (MusicGen / Stable Audio) · <strong>T2</strong> = premium hosted models.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                    <Label>Default tier</Label>
                    <Select
                        value={prefs["ai.generation.defaultTier"]}
                        onValueChange={(v) => update("ai.generation.defaultTier", v as AiPrefs["ai.generation.defaultTier"])}
                        disabled={!loaded}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="T0">T0 · on-device</SelectItem>
                            <SelectItem value="T1">T1 · BYO model</SelectItem>
                            <SelectItem value="T2">T2 · hosted premium</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="space-y-1.5">
                    <Label>License filter</Label>
                    <Select
                        value={prefs["ai.generation.licenseFilter"]}
                        onValueChange={(v) => update("ai.generation.licenseFilter", v as AiPrefs["ai.generation.licenseFilter"])}
                        disabled={!loaded}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="any">Any license</SelectItem>
                            <SelectItem value="commercial-clean">Commercial-clean only</SelectItem>
                            <SelectItem value="personal-use">Allow personal-use</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="space-y-1.5">
                    <Label>Default seed (blank = random)</Label>
                    <Input
                        type="number"
                        value={prefs["ai.generation.defaultSeed"] ?? ""}
                        onChange={(e) => update(
                            "ai.generation.defaultSeed",
                            e.target.value === "" ? null : Number(e.target.value),
                        )}
                        disabled={!loaded}
                    />
                </div>
                <div className="sm:col-span-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    Generation UI (prompt library, batch render, A/B compare) lands in Phase 5 along with the
                    <code className="mx-1">@mmo/audio-gen</code> dispatcher.
                </div>
            </CardContent>
        </Card>
    );
}

// ─── Privacy tab ──────────────────────────────────────────────────────────

function PrivacyTab() {
    const { prefs, update } = useAiPrefs();
    return (
        <Card>
            <CardHeader>
                <CardTitle>Privacy</CardTitle>
                <CardDescription>
                    Control what leaves your machine. All toggles persist server-side.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                <ToggleRow
                    id="telem"
                    label="Anonymous telemetry (model usage counters, no prompt content)"
                    checked={prefs["ai.privacy.telemetry"]}
                    onChange={(v) => update("ai.privacy.telemetry", v)}
                />
                <ToggleRow
                    id="redact"
                    label="Redact PII / secrets from prompts before sending"
                    checked={prefs["ai.privacy.redactPrompts"]}
                    onChange={(v) => update("ai.privacy.redactPrompts", v)}
                />
                <ToggleRow
                    id="local"
                    label="Local-only mode (block all hosted providers, use T0 only)"
                    checked={prefs["ai.privacy.localOnly"]}
                    onChange={(v) => update("ai.privacy.localOnly", v)}
                />
            </CardContent>
        </Card>
    );
}

// ─── Usage tab ────────────────────────────────────────────────────────────

function UsageTab({ connections }: { connections: ConnectionDto[] }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>Usage</CardTitle>
                <CardDescription>
                    Live per-provider counters land in Phase 7 (sessions table aggregation). For now you can see
                    your active connections and their session-token state.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Provider</TableHead>
                            <TableHead>Label</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Session expires</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {connections.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                                    No connections yet.
                                </TableCell>
                            </TableRow>
                        )}
                        {connections.map((c) => (
                            <TableRow key={c.id}>
                                <TableCell className="font-medium">{PROVIDER_LABELS[c.provider]}</TableCell>
                                <TableCell>{c.label}</TableCell>
                                <TableCell>
                                    <Badge variant={c.status === "active" ? "default" : "secondary"}>{c.status}</Badge>
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground text-sm">
                                    {c.sessionExpiresAt ? c.sessionExpiresAt.toLocaleString() : "—"}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
}

// ─── Developer tab ────────────────────────────────────────────────────────

function DeveloperTab() {
    const [pats, setPats] = useState<PatRowDto[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [newLabel, setNewLabel] = useState("");
    const [newScopes, setNewScopes] = useState<PatScope[]>(["agent:read", "agent:run"]);
    const [newExpiry, setNewExpiry] = useState<string>("90");
    const [issuedToken, setIssuedToken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const refresh = useCallback(async () => {
        try {
            const list = await listPats();
            setPats(list);
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const create = () => {
        setError(null);
        startTransition(async () => {
            try {
                const days = newExpiry === "never" ? undefined : Number(newExpiry);
                const { token } = await createPat({ label: newLabel, scopes: newScopes, expiresInDays: days });
                setIssuedToken(token);
                setNewLabel("");
                await refresh();
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        });
    };

    const revoke = (id: string) => startTransition(async () => {
        await revokePat(id);
        await refresh();
    });

    const toggleScope = (s: PatScope) => {
        setNewScopes((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
    };

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle>Personal Access Tokens</CardTitle>
                    <CardDescription>
                        For the upcoming <code>@mmo/sdk</code>, REST API, and MCP server. JWT-signed,
                        rotated via env <code>MMO_PAT_SIGNING_KEYS</code>.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="space-y-1.5 sm:col-span-2">
                            <Label>Label</Label>
                            <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="MCP client on my laptop" />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Expiry</Label>
                            <Select value={newExpiry} onValueChange={setNewExpiry}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="7">7 days</SelectItem>
                                    <SelectItem value="30">30 days</SelectItem>
                                    <SelectItem value="90">90 days</SelectItem>
                                    <SelectItem value="365">1 year</SelectItem>
                                    <SelectItem value="never">Never</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label>Scopes</Label>
                        <div className="flex flex-wrap gap-2">
                            {PAT_SCOPES.map((s) => (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() => toggleScope(s)}
                                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                                        newScopes.includes(s)
                                            ? "border-primary bg-primary text-primary-foreground"
                                            : "border-border text-muted-foreground hover:border-primary/60"
                                    }`}
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                    {error && <p className="text-sm text-destructive">{error}</p>}
                </CardContent>
                <CardFooter>
                    <Button onClick={create} disabled={pending || !newLabel || newScopes.length === 0} className="gap-2">
                        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Create PAT
                    </Button>
                </CardFooter>
            </Card>

            <AnimatePresence>
                {issuedToken && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                    >
                        <Card className="border-emerald-500/40 bg-emerald-500/5">
                            <CardHeader>
                                <CardTitle className="text-base">Copy your token now — it won&apos;t be shown again</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2">
                                <code className="block break-all rounded-md bg-background p-3 text-xs font-mono">{issuedToken}</code>
                            </CardContent>
                            <CardFooter className="gap-2">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="gap-1.5"
                                    onClick={async () => {
                                        await navigator.clipboard.writeText(issuedToken);
                                    }}
                                >
                                    <Copy className="h-3.5 w-3.5" /> Copy
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setIssuedToken(null)}>I have saved it</Button>
                            </CardFooter>
                        </Card>
                    </motion.div>
                )}
            </AnimatePresence>

            <Card>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Label</TableHead>
                            <TableHead>Scopes</TableHead>
                            <TableHead>Expires</TableHead>
                            <TableHead>Last used</TableHead>
                            <TableHead className="text-right" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {loaded && pats.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                                    No tokens yet.
                                </TableCell>
                            </TableRow>
                        )}
                        {pats.map((p) => (
                            <TableRow key={p.id} className={p.revokedAt ? "opacity-50" : ""}>
                                <TableCell className="font-medium">{p.label}</TableCell>
                                <TableCell className="space-x-1">
                                    {p.scopes.map((s) => <Badge key={s} variant="secondary">{s}</Badge>)}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                    {p.expiresAt ? p.expiresAt.toLocaleDateString() : "never"}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                    {p.lastUsedAt ? p.lastUsedAt.toLocaleString() : "—"}
                                </TableCell>
                                <TableCell className="text-right">
                                    {!p.revokedAt && (
                                        <Button size="sm" variant="ghost" className="gap-1.5 text-destructive" onClick={() => revoke(p.id)}>
                                            <Trash2 className="h-3.5 w-3.5" /> Revoke
                                        </Button>
                                    )}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </Card>
        </div>
    );
}

function ToggleRow({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <div className="flex items-center gap-3">
            <input
                id={id}
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="h-4 w-4"
            />
            <Label htmlFor={id} className="cursor-pointer">{label}</Label>
        </div>
    );
}

// ─── Reusable bits ─────────────────────────────────────────────────────────

function PlaceholderTab({ title, description }: { title: string; description: string }) {
    return (
        <Card className="border-dashed">
            <CardHeader>
                <CardTitle className="text-base">{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
            </CardHeader>
        </Card>
    );
}

function EmptyHint({ message }: { message: string }) {
    return (
        <Card className="border-dashed">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">{message}</CardContent>
        </Card>
    );
}

function McpTab() {
    const [data, setData] = useState<McpAuditSummary | null>(null);
    const [entries, setEntries] = useState<McpAuditEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [status, setStatus] = useState<McpAuditStatus>("all");
    const [tool, setTool] = useState<string>("");
    const [sinceHours, setSinceHours] = useState<number>(24);
    const [nextOffset, setNextOffset] = useState<number | null>(null);
    const [exporting, setExporting] = useState(false);

    const fetchPage = useCallback((offset: number) => {
        return listMcpAuditEntries({
            limit: 100,
            offset,
            status,
            tool: tool || undefined,
            sinceHours,
        });
    }, [status, tool, sinceHours]);

    const refresh = useCallback(() => {
        setLoading(true);
        fetchPage(0)
            .then((d) => {
                setData(d);
                setEntries(d.entries);
                setNextOffset(d.nextOffset);
                setErr(null);
            })
            .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Failed to load MCP audit"))
            .finally(() => setLoading(false));
    }, [fetchPage]);

    useEffect(() => { refresh(); }, [refresh]);

    const loadMore = useCallback(() => {
        if (nextOffset == null) return;
        setLoadingMore(true);
        fetchPage(nextOffset)
            .then((d) => {
                setEntries((prev) => [...prev, ...d.entries]);
                setNextOffset(d.nextOffset);
            })
            .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Failed to load more"))
            .finally(() => setLoadingMore(false));
    }, [nextOffset, fetchPage]);

    const downloadCsv = useCallback(async () => {
        setExporting(true);
        try {
            const csv = await exportMcpAuditCsv({ status, tool: tool || undefined, sinceHours });
            const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `mcp-audit-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } finally {
            setExporting(false);
        }
    }, [status, tool, sinceHours]);

    const uniqueTools = Array.from(new Set(entries.map((e) => e.tool).filter((t): t is string => !!t))).sort();

    if (loading && !data) return <EmptyHint message="Loading MCP audit log…" />;
    if (err && !data) return <EmptyHint message={err} />;
    if (!data) return <EmptyHint message="No MCP usage yet." />;

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Last 24 hours</CardTitle>
                    <CardDescription>JSON-RPC calls authenticated with your PATs.</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <Stat label="Total calls" value={data.last24h.total} />
                        <Stat label="Failed" value={data.last24h.failed} />
                        <Stat label="Rate-limited" value={data.last24h.rateLimited} />
                        <Stat label="Avg duration" value={`${data.last24h.avgDurationMs} ms`} />
                    </div>
                </CardContent>
                <CardFooter className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Status</label>
                        <select
                            value={status}
                            onChange={(e) => setStatus(e.currentTarget.value as McpAuditStatus)}
                            className="h-8 rounded border bg-background px-2 text-xs"
                        >
                            <option value="all">All</option>
                            <option value="ok">OK</option>
                            <option value="failed">Failed</option>
                            <option value="ratelimited">Rate-limited</option>
                        </select>
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Tool</label>
                        <select
                            value={tool}
                            onChange={(e) => setTool(e.currentTarget.value)}
                            className="h-8 rounded border bg-background px-2 text-xs min-w-[120px]"
                        >
                            <option value="">All tools</option>
                            {uniqueTools.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Window</label>
                        <select
                            value={sinceHours}
                            onChange={(e) => setSinceHours(Number(e.currentTarget.value))}
                            className="h-8 rounded border bg-background px-2 text-xs"
                        >
                            <option value={1}>Last hour</option>
                            <option value={24}>Last 24h</option>
                            <option value={168}>Last 7 days</option>
                            <option value={720}>Last 30 days</option>
                        </select>
                    </div>
                    <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
                        <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
                    </Button>
                    <Button size="sm" variant="outline" onClick={downloadCsv} disabled={exporting}>
                        {exporting ? "Exporting…" : "Export CSV"}
                    </Button>
                </CardFooter>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Recent calls</CardTitle>
                    <CardDescription>{entries.length} entr{entries.length === 1 ? "y" : "ies"} loaded{nextOffset != null ? " (more available)" : ""}.</CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                    {entries.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No MCP calls match the current filters.</p>
                    ) : (
                        <table className="w-full text-xs">
                            <thead className="text-left text-muted-foreground">
                                <tr>
                                    <th className="py-2 pr-3">Time</th>
                                    <th className="py-2 pr-3">Method</th>
                                    <th className="py-2 pr-3">Tool</th>
                                    <th className="py-2 pr-3">Status</th>
                                    <th className="py-2 pr-3">Duration</th>
                                    <th className="py-2 pr-3">PAT</th>
                                </tr>
                            </thead>
                            <tbody>
                                {entries.map((e) => (
                                    <tr key={e.id} className="border-t border-border/40">
                                        <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(e.ts).toLocaleString()}</td>
                                        <td className="py-1.5 pr-3 font-mono">{e.method}</td>
                                        <td className="py-1.5 pr-3 font-mono">{e.tool ?? "—"}</td>
                                        <td className="py-1.5 pr-3">
                                            {e.ok
                                                ? <span className="text-green-500">ok</span>
                                                : <span className="text-destructive">err{e.errorCode != null ? ` ${e.errorCode}` : ""}</span>}
                                        </td>
                                        <td className="py-1.5 pr-3">{e.durationMs} ms</td>
                                        <td className="py-1.5 pr-3 font-mono opacity-70">{e.jti.slice(0, 8)}…</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </CardContent>
                {nextOffset != null ? (
                    <CardFooter>
                        <Button size="sm" variant="outline" onClick={loadMore} disabled={loadingMore}>
                            {loadingMore ? "Loading…" : "Load more"}
                        </Button>
                    </CardFooter>
                ) : null}
            </Card>
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="rounded-md border bg-muted/30 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
            <div className="text-lg font-semibold tabular-nums">{value}</div>
        </div>
    );
}
