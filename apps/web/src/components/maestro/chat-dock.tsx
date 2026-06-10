"use client";

/**
 * Maestro floating chat dock.
 *
 * Bottom-right floating panel. Streams from POST /api/maestro/chat via
 * the Vercel AI SDK v5 React hooks. Shows a small model picker
 * (per-message override) on top of the user's role→model defaults.
 *
 * Persistence: every send creates/updates a row in `ai_agent_sessions`
 * and writes user + assistant messages to `ai_agent_messages` on the
 * server. The dock itself only knows about the current session id.
 *
 * Rendered into `document.body` via a portal so ancestor `transform`s
 * don't create a new containing block for our `position: fixed` panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Bot, Loader2, Send, Sparkles, X, MessageSquarePlus, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
    getChatPickerData,
    listSessions,
    getSessionMessages,
    getSessionMessagesTail,
    getLastSession,
    deleteSession,
    updateSessionMeta,
    type ConnectionPickerDto,
    type RoleChoiceDto,
    type SessionDto,
} from "@/actions/maestro";
import { toast } from "sonner";

const LAST_SESSION_KEY = "mmo:maestro:lastSessionId";
const MESSAGE_RENDER_WINDOW = 80;

interface PickerOption {
    connectionId: string;
    modelId: string;
    label: string;
}

export function MaestroChatDock() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [sessionId, setSessionId] = useState<string | undefined>(undefined);
    const [currentSession, setCurrentSession] = useState<SessionDto | null>(null);
    const [restoring, setRestoring] = useState(true);
    const [showAllMessages, setShowAllMessages] = useState(false);
    const [picker, setPicker] = useState<{
        connections: ConnectionPickerDto[];
        choices: RoleChoiceDto[];
    }>({ connections: [], choices: [] });
    const [override, setOverride] = useState<{ connectionId: string; modelId: string } | undefined>(
        undefined,
    );
    const [sessions, setSessions] = useState<SessionDto[]>([]);
    const [draft, setDraft] = useState("");
    const [showHistory, setShowHistory] = useState(false);
    const [, startTransition] = useTransition();
    const scrollRef = useRef<HTMLDivElement | null>(null);

    const { messages, setMessages, sendMessage, status, error, stop } = useChat({
        transport: new DefaultChatTransport({
            api: "/api/maestro/chat",
            prepareSendMessagesRequest: ({ messages: ms, body }) => {
                // Pick up the project id from the URL so Maestro operates on what the user sees.
                let currentProjectExternalId: string | undefined;
                if (typeof window !== "undefined") {
                    const params = new URLSearchParams(window.location.search);
                    currentProjectExternalId = params.get("project") ?? undefined;
                }
                return {
                    body: {
                        sessionId,
                        messages: ms,
                        role: "agent",
                        override,
                        currentProjectExternalId,
                        ...(body ?? {}),
                    },
                };
            },
        }),
        onError: (err) => {
            toast.error(err.message ?? "Maestro request failed");
        },
        onFinish: ({ message: _m }) => {
            // refresh session list (titles, updatedAt) + current session meta
            startTransition(() => {
                listSessions().then((rows) => {
                    setSessions(rows);
                    if (sessionId) {
                        const next = rows.find((s) => s.id === sessionId);
                        if (next) setCurrentSession(next);
                    }
                }).catch(() => {});
            });
        },
    });

    // Persist the active session id whenever it changes so a refresh
    // restores the same conversation (Maestro can also auto-pick "last"
    // via getLastSession when localStorage is empty / cleared).
    useEffect(() => {
        if (typeof window === "undefined") return;
        if (sessionId) window.localStorage.setItem(LAST_SESSION_KEY, sessionId);
    }, [sessionId]);

    // Capture the latest assistant session-id header so a brand-new chat
    // promotes the optimistic 'undefined' to the real id after first send.
    // (Hooks into the same x-maestro-session-id we set in /api/maestro/chat.)
    // The AI SDK doesn't surface response headers directly; we infer the id
    // from the freshly-fetched sessions list (top entry == ours) instead.
    useEffect(() => {
        if (sessionId || sessions.length === 0) return;
        if (status === "streaming" || status === "submitted") return;
        // Most-recent session is ours iff we've just sent a message.
        // We guard with messages.length > 0 to avoid hijacking when the user
        // is just browsing.
        if (messages.length === 0) return;
        setSessionId(sessions[0]!.id);
        setCurrentSession(sessions[0]!);
    }, [sessions, sessionId, status, messages.length]);

    // Load picker data + sessions whenever dock opens.
    useEffect(() => {
        if (!open) return;
        getChatPickerData().then(setPicker).catch(() => {});
        listSessions().then(setSessions).catch(() => {});
    }, [open]);

    // Restore last session on first mount.
    useEffect(() => {
        let cancelled = false;
        const toUiMessages = (msgs: { id: string; role: string; content: unknown }[]): UIMessage[] =>
            msgs
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m) => ({
                    id: m.id,
                    role: m.role as "user" | "assistant",
                    parts: (Array.isArray(m.content)
                        ? (m.content as { type: string; text?: string }[])
                        : [{ type: "text", text: String(m.content ?? "") }]) as UIMessage["parts"],
                }));

        (async () => {
            try {
                let candidateId: string | null = null;
                if (typeof window !== "undefined") {
                    candidateId = window.localStorage.getItem(LAST_SESSION_KEY);
                }
                if (!candidateId) {
                    const last = await getLastSession();
                    if (last) candidateId = last.id;
                }
                if (!candidateId || cancelled) return;

                // 1) Paint the last few messages immediately so the user
                //    sees the most recent exchange in <100ms instead of
                //    waiting for the whole conversation to load.
                const tail = await getSessionMessagesTail(candidateId, 10);
                if (cancelled) return;
                if (tail.length === 0) return;
                setSessionId(candidateId);
                setMessages(toUiMessages(tail));
                setRestoring(false);

                // 2) Hydrate the rest of the conversation in the
                //    background and replace the tail with the full history
                //    (kept in memory; windowed renderer caps the rendered slice).
                void (async () => {
                    try {
                        const [rows, full] = await Promise.all([
                            listSessions(),
                            getSessionMessages(candidateId!),
                        ]);
                        if (cancelled) return;
                        setSessions(rows);
                        const meta = rows.find((s) => s.id === candidateId);
                        if (meta) setCurrentSession(meta);
                        if (full.length > tail.length) {
                            setMessages(toUiMessages(full));
                        }
                        // Heal legacy sessions whose title was never derived
                        // ("Untitled chat" or null). Pull the title from the
                        // first user message client-side so the dock header
                        // stops showing the placeholder.
                        if (meta && (!meta.title || meta.title === "Untitled chat")) {
                            const firstUser = full.find((m) => m.role === "user");
                            if (firstUser) {
                                let text = "";
                                if (Array.isArray(firstUser.content)) {
                                    const parts = firstUser.content as Array<{ type: string; text?: string }>;
                                    text = parts
                                        .filter((p) => p.type === "text" && typeof p.text === "string")
                                        .map((p) => p.text!)
                                        .join(" ");
                                } else if (typeof firstUser.content === "string") {
                                    text = firstUser.content;
                                }
                                text = text.replace(/\s+/g, " ").trim();
                                if (text) {
                                    const newTitle = text.length <= 60 ? text : text.slice(0, 57) + "\u2026";
                                    updateSessionMeta(candidateId!, { title: newTitle })
                                        .then(() => {
                                            if (cancelled) return;
                                            setCurrentSession((prev) => (prev ? { ...prev, title: newTitle } : prev));
                                            setSessions((prev) => prev.map((s) => (s.id === candidateId ? { ...s, title: newTitle } : s)));
                                        })
                                        .catch(() => {});
                                }
                            }
                        }
                    } catch { /* ignore */ }
                })();
            } catch {
                /* ignore — start fresh */
            } finally {
                if (!cancelled) setRestoring(false);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // External `window.dispatchEvent(new Event("mmo:maestro-open"))` opens
    // the dock. Used by the /maestro full-page route so the same dock
    // is the single source of chat truth.
    useEffect(() => {
        const onOpen = () => setOpen(true);
        const onToggle = () => setOpen((v) => !v);
        const onPrompt = (e: Event) => {
            const detail = (e as CustomEvent<string>).detail;
            if (typeof detail === "string") {
                setOpen(true);
                setDraft(detail);
            }
        };
        window.addEventListener("mmo:maestro-open", onOpen);
        window.addEventListener("mmo:maestro-toggle", onToggle);
        window.addEventListener("mmo:maestro-prompt", onPrompt as EventListener);
        return () => {
            window.removeEventListener("mmo:maestro-open", onOpen);
            window.removeEventListener("mmo:maestro-toggle", onToggle);
            window.removeEventListener("mmo:maestro-prompt", onPrompt as EventListener);
        };
    }, []);

    // Autoscroll on new message chunks
    useEffect(() => {
        if (!scrollRef.current) return;
        scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }, [messages]);

    // Watch for `navigateApp` tool results and route accordingly. We track
    // already-handled toolCallIds so re-renders don't re-navigate.
    const handledNavRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        for (const m of messages) {
            if (m.role !== "assistant") continue;
            for (const part of m.parts) {
                if (!part.type.startsWith("tool-")) continue;
                const p = part as { type: string; state?: string; toolCallId?: string; output?: unknown };
                if (p.state !== "output-available") continue;
                const out = p.output as { navigate?: { url?: string } } | undefined;
                const url = out?.navigate?.url;
                const key = p.toolCallId ?? `${m.id}:${part.type}`;
                if (url && !handledNavRef.current.has(key)) {
                    handledNavRef.current.add(key);
                    try {
                        router.push(url);
                        toast.success(`Maestro opened ${url}`);
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.warn("[maestro] navigation failed", err);
                    }
                }
            }
        }
    }, [messages, router]);

    const pickerOptions: PickerOption[] = useMemo(() => {
        const seen = new Set<string>();
        const out: PickerOption[] = [];
        for (const c of picker.choices) {
            const key = `${c.connectionId}:${c.modelId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const conn = picker.connections.find((x) => x.id === c.connectionId);
            if (!conn) continue;
            out.push({
                connectionId: c.connectionId,
                modelId: c.modelId,
                label: `${conn.provider}/${c.modelId} (${conn.label})`,
            });
        }
        return out;
    }, [picker]);

    const onSend = useCallback(() => {
        const text = draft.trim();
        if (!text || status === "submitted" || status === "streaming") return;
        setDraft("");
        sendMessage({ text });
    }, [draft, sendMessage, status]);

    const onNewChat = useCallback(() => {
        setSessionId(undefined);
        setCurrentSession(null);
        setMessages([]);
        setShowHistory(false);
        setShowAllMessages(false);
        if (typeof window !== "undefined") {
            window.localStorage.removeItem(LAST_SESSION_KEY);
        }
    }, [setMessages]);

    const onPickSession = useCallback(
        async (id: string) => {
            setSessionId(id);
            const meta = sessions.find((s) => s.id === id) ?? null;
            setCurrentSession(meta);
            const msgs = await getSessionMessages(id);
            const ui: UIMessage[] = msgs
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m) => ({
                    id: m.id,
                    role: m.role as "user" | "assistant",
                    parts: (Array.isArray(m.content)
                        ? (m.content as { type: string; text?: string }[])
                        : [{ type: "text", text: String(m.content ?? "") }]) as UIMessage["parts"],
                }));
            setMessages(ui);
            setShowHistory(false);
            setShowAllMessages(false);
        },
        [sessions, setMessages],
    );

    const onDeleteSession = useCallback(
        async (id: string) => {
            await deleteSession(id);
            setSessions((prev) => prev.filter((s) => s.id !== id));
            if (sessionId === id) onNewChat();
        },
        [sessionId, onNewChat],
    );

    const onRenameCurrent = useCallback(async () => {
        if (!sessionId) return;
        const cur = currentSession?.title ?? "";
        const next = typeof window !== "undefined"
            ? window.prompt("Rename conversation", cur)
            : null;
        if (next == null) return;
        const title = next.trim();
        if (!title || title === cur) return;
        try {
            await updateSessionMeta(sessionId, { title });
            setCurrentSession((prev) => (prev ? { ...prev, title } : prev));
            setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title } : s)));
            toast.success("Renamed conversation.");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Rename failed");
        }
    }, [sessionId, currentSession]);

    // Cap rendered messages so a 500-msg conversation doesn't slow the UI.
    // (`messages` is a UIMessage[] from useChat; we keep them all in memory
    // for streaming-correctness but only render the tail.)
    const renderedMessages = useMemo(() => {
        if (showAllMessages || messages.length <= MESSAGE_RENDER_WINDOW) return messages;
        return messages.slice(messages.length - MESSAGE_RENDER_WINDOW);
    }, [messages, showAllMessages]);
    const hiddenCount = messages.length - renderedMessages.length;

    const noConnections = picker.connections.length === 0;
    const noRoles = picker.choices.length === 0;
    const isBusy = status === "submitted" || status === "streaming";

    // Mount-gated portal target (avoid SSR mismatch)
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);
    if (!mounted) return null;

    const ui = (
        <>
            {/* Floating launcher */}
            <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setOpen((v) => !v)}
                aria-label="Open Maestro"
                className={cn(
                    "fixed shadow-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 text-white",
                    "flex items-center justify-center rounded-full",
                    "ring-2 ring-white/10 hover:ring-white/30 transition-shadow",
                )}
                style={{ position: "fixed", right: 20, bottom: 100, width: 56, height: 56, zIndex: 60 }}
            >
                <AnimatePresence initial={false} mode="wait">
                    {open ? (
                        <motion.span
                            key="x"
                            initial={{ rotate: -90, opacity: 0 }}
                            animate={{ rotate: 0, opacity: 1 }}
                            exit={{ rotate: 90, opacity: 0 }}
                            transition={{ duration: 0.18 }}
                        >
                            <X className="h-6 w-6" />
                        </motion.span>
                    ) : (
                        <motion.span
                            key="b"
                            initial={{ rotate: 90, opacity: 0 }}
                            animate={{ rotate: 0, opacity: 1 }}
                            exit={{ rotate: -90, opacity: 0 }}
                            transition={{ duration: 0.18 }}
                        >
                            <Sparkles className="h-6 w-6" />
                        </motion.span>
                    )}
                </AnimatePresence>
            </motion.button>

            {/* Panel */}
            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: 12, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 12, scale: 0.98 }}
                        transition={{ duration: 0.18 }}
                        className="fixed rounded-2xl bg-card border border-border shadow-2xl flex flex-col overflow-hidden"
                        style={{
                            position: "fixed",
                            right: 20,
                            bottom: 170,
                            width: "min(400px, calc(100vw - 32px))",
                            height: "min(640px, calc(100dvh - 200px))",
                            zIndex: 60,
                        }}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-gradient-to-r from-violet-500/10 via-fuchsia-500/10 to-rose-500/10">
                            <div className="flex items-center gap-2 min-w-0">
                                <Bot className="h-4 w-4 text-violet-400 shrink-0" />
                                <div className="min-w-0">
                                    <button
                                        type="button"
                                        onClick={onRenameCurrent}
                                        disabled={!sessionId}
                                        className="text-sm font-semibold truncate text-left max-w-[180px] disabled:cursor-default disabled:hover:underline-offset-0 hover:underline underline-offset-2"
                                        title={sessionId ? "Click to rename" : undefined}
                                    >
                                        {currentSession?.title || (sessionId ? "Untitled chat" : "Maestro")}
                                    </button>
                                    <div
                                        className="text-[10px] text-muted-foreground truncate max-w-[220px]"
                                        title={currentSession?.description ?? undefined}
                                    >
                                        {currentSession?.description
                                            ? currentSession.description
                                            : `AI agent · ${pickerOptions.length} model${pickerOptions.length === 1 ? "" : "s"} available`}
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-1">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => setShowHistory((v) => !v)}
                                >
                                    {showHistory ? "Chat" : "History"}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={onNewChat}
                                    title="New chat"
                                >
                                    <MessageSquarePlus className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>

                        {/* Model picker */}
                        {!showHistory && pickerOptions.length > 0 && (
                            <div className="px-4 py-2 border-b border-border">
                                <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                    Model override (per-message)
                                </label>
                                <select
                                    value={
                                        override
                                            ? `${override.connectionId}:${override.modelId}`
                                            : ""
                                    }
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        if (!v) return setOverride(undefined);
                                        const [connectionId, modelId] = v.split(":");
                                        setOverride({ connectionId: connectionId!, modelId: modelId! });
                                    }}
                                    className="mt-1 w-full h-8 rounded-md bg-background border border-input px-2 text-xs"
                                >
                                    <option value="">
                                        Auto (use role default)
                                    </option>
                                    {pickerOptions.map((o) => (
                                        <option
                                            key={`${o.connectionId}:${o.modelId}`}
                                            value={`${o.connectionId}:${o.modelId}`}
                                        >
                                            {o.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Body */}
                        {showHistory ? (
                            <HistoryPane
                                sessions={sessions}
                                currentId={sessionId}
                                onPick={onPickSession}
                                onDelete={onDeleteSession}
                            />
                        ) : (
                            <>
                                <div
                                    ref={(el) => {
                                        scrollRef.current = el;
                                    }}
                                    className="flex-1 px-4 py-3 space-y-3 overflow-y-auto"
                                >
                                    {restoring && messages.length === 0 && (
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                            Restoring last conversation…
                                        </div>
                                    )}
                                    {!restoring && messages.length === 0 && (
                                        <Welcome
                                            noConnections={noConnections}
                                            noRoles={noRoles}
                                        />
                                    )}
                                    {hiddenCount > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => setShowAllMessages(true)}
                                            className="w-full text-center text-[11px] text-muted-foreground py-1.5 rounded border border-dashed border-border hover:bg-muted/40 transition-colors"
                                        >
                                            Show {hiddenCount} older message{hiddenCount === 1 ? "" : "s"}
                                        </button>
                                    )}
                                    {renderedMessages.map((m) => (
                                        <MessageBubble key={m.id} message={m} />
                                    ))}
                                    {isBusy && (
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                            Maestro is thinking…
                                        </div>
                                    )}
                                    {error && (
                                        <div className="text-xs text-rose-400">{error.message}</div>
                                    )}
                                </div>

                                {/* Composer */}
                                <div className="border-t border-border p-3 space-y-2">
                                    <Textarea
                                        value={draft}
                                        onChange={(e) => setDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" && !e.shiftKey) {
                                                e.preventDefault();
                                                onSend();
                                            }
                                        }}
                                        placeholder={
                                            noConnections
                                                ? "Connect a provider in /settings/copilot first…"
                                                : noRoles
                                                  ? "Pick a model for the Agent role in /settings/copilot → Roles…"
                                                  : "Ask Maestro… (Enter to send, Shift+Enter for newline)"
                                        }
                                        disabled={noConnections || noRoles}
                                        rows={2}
                                        className="resize-none min-h-[44px] text-sm"
                                    />
                                    <div className="flex items-center justify-between gap-2">
                                        <Badge variant="outline" className="text-[10px]">
                                            agent · auto-multistep
                                        </Badge>
                                        {isBusy ? (
                                            <Button size="sm" variant="outline" onClick={() => stop()}>
                                                Stop
                                            </Button>
                                        ) : (
                                            <Button size="sm" onClick={onSend} disabled={!draft.trim()}>
                                                <Send className="h-3 w-3 mr-1" />
                                                Send
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );

    return createPortal(ui, document.body);
}

function Welcome({ noConnections, noRoles }: { noConnections: boolean; noRoles: boolean }) {
    if (noConnections) {
        return (
            <div className="text-sm text-muted-foreground space-y-2">
                <p className="font-medium text-foreground">Welcome to Maestro 👋</p>
                <p>
                    Connect at least one AI provider on{" "}
                    <a href="/settings/copilot" className="text-violet-400 underline">
                        /settings/copilot
                    </a>{" "}
                    before sending a message.
                </p>
            </div>
        );
    }
    if (noRoles) {
        return (
            <div className="text-sm text-muted-foreground space-y-2">
                <p className="font-medium text-foreground">Almost there.</p>
                <p>
                    Open <a href="/settings/copilot" className="text-violet-400 underline">Roles</a>{" "}
                    and assign a model to the <strong>Agent</strong> role.
                </p>
            </div>
        );
    }
    return (
        <div className="text-sm text-muted-foreground space-y-2">
            <p className="font-medium text-foreground">Hey, I'm Maestro 🎛️</p>
            <p>Try one of:</p>
            <ul className="list-disc list-inside text-xs space-y-1">
                <li>"Show me my latest 10 tracks"</li>
                <li>"Find tracks by Daft Punk"</li>
                <li>"What's the BPM of track #42?"</li>
            </ul>
        </div>
    );
}

function MessageBubble({ message }: { message: UIMessage }) {
    const isUser = message.role === "user";
    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16 }}
            className={cn("flex", isUser ? "justify-end" : "justify-start")}
        >
            <div
                className={cn(
                    "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
                    isUser
                        ? "bg-violet-600 text-white rounded-br-md"
                        : "bg-muted text-foreground rounded-bl-md",
                )}
            >
                {message.parts.map((part, i) => {
                    if (part.type === "text") return <span key={i}>{part.text}</span>;
                    if (part.type.startsWith("tool-")) {
                        return (
                            <ToolCallBlock
                                key={i}
                                part={part as ToolPartLike}
                                messageId={message.id}
                            />
                        );
                    }
                    return null;
                })}
            </div>
        </motion.div>
    );
}

function HistoryPane({
    sessions,
    currentId,
    onPick,
    onDelete,
}: {
    sessions: SessionDto[];
    currentId: string | undefined;
    onPick: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    return (
        <div className="flex-1 overflow-y-auto px-2 py-2">
            {sessions.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3">No previous sessions yet.</p>
            ) : (
                <ul className="space-y-1">
                    {sessions.map((s) => (
                        <li
                            key={s.id}
                            className={cn(
                                "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm cursor-pointer",
                                "hover:bg-muted/60",
                                s.id === currentId && "bg-muted",
                            )}
                        >
                            <button
                                className="flex-1 text-left min-w-0"
                                onClick={() => onPick(s.id)}
                            >
                                <div className="truncate">{s.title || "Untitled chat"}</div>
                                {s.description && (
                                    <div className="text-[10px] text-muted-foreground line-clamp-2">
                                        {s.description}
                                    </div>
                                )}
                                <div className="text-[10px] text-muted-foreground">
                                    {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""}
                                </div>
                            </button>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 opacity-0 group-hover:opacity-100"
                                onClick={() => onDelete(s.id)}
                                title="Delete"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

interface ToolPartLike {
    type: string;
    state?: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
}

function ToolCallBlock({ part, messageId }: { part: ToolPartLike; messageId: string }) {
    const toolName = part.type.replace(/^tool-/, "");
    const state = part.state ?? "—";
    const output = part.output as { ok?: boolean; reason?: string; error?: string; navigate?: { url?: string } } | undefined;
    const failed =
        state === "output-error" ||
        (output && typeof output === "object" && output.ok === false);
    const errorText =
        part.errorText ||
        (output && typeof output === "object" ? output.error ?? output.reason : undefined);
    const [reported, setReported] = useState(false);
    const [reporting, setReporting] = useState(false);

    const onReport = useCallback(async () => {
        if (reported || reporting) return;
        setReporting(true);
        try {
            const res = await fetch("/api/maestro/feedback", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    messageId,
                    toolCallId: part.toolCallId,
                    title: `Maestro tool '${toolName}' failed`,
                    summary: `State=${state}; error=${errorText ?? "(none)"}`,
                    severity: "medium",
                    category: "bug",
                    context: {
                        tool: toolName,
                        state,
                        input: part.input,
                        output: part.output,
                        errorText: part.errorText,
                    },
                    pageUrl: typeof window !== "undefined" ? window.location.href : null,
                }),
            });
            if (res.ok) {
                setReported(true);
                toast.success("Issue reported. Thanks!");
            } else {
                toast.error("Failed to file report.");
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to file report.");
        } finally {
            setReporting(false);
        }
    }, [errorText, messageId, part.errorText, part.input, part.output, part.toolCallId, reported, reporting, state, toolName]);

    return (
        <div
            className={cn(
                "my-1 rounded-md border px-2 py-1 text-[11px]",
                failed
                    ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
                    : "border-border bg-background/40 text-muted-foreground",
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="truncate">
                    {failed ? "⚠️" : "🔧"} {toolName} · {state}
                </span>
                {failed && (
                    <button
                        type="button"
                        onClick={onReport}
                        disabled={reporting || reported}
                        className={cn(
                            "shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                            reported
                                ? "bg-emerald-500/20 text-emerald-300 cursor-default"
                                : "bg-rose-500/20 text-rose-100 hover:bg-rose-500/30",
                        )}
                        title="File a bug report with this tool's input/error"
                    >
                        <AlertTriangle className="h-3 w-3" />
                        {reported ? "Reported" : reporting ? "Filing…" : "Report"}
                    </button>
                )}
            </div>
            {failed && errorText && (
                <div className="mt-0.5 truncate opacity-90">{errorText}</div>
            )}
        </div>
    );
}
