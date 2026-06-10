"use client";

import { useEffect, useRef, useState } from "react";
import { Users, MessageCircle, X, Send, Copy, Check, Mic, MicOff, ThumbsUp, ThumbsDown, ListVideo } from "lucide-react";
import type { PartyConnection } from "@/hooks/use-watch-party";
import { useVoiceChat } from "@/hooks/use-watch-party";

const QUICK_EMOJI = ["😂", "😱", "❤️", "🔥", "👏", "😢", "🎉", "💀"];

interface Props {
    party: PartyConnection;
    onCreate: () => void;
    onClose: () => void;
    shareUrl: string | null;
    hostBtnStyle: React.CSSProperties;
}

export function WatchPartyPanel({ party, onCreate, onClose, shareUrl, hostBtnStyle }: Props) {
    const [open, setOpen] = useState(false);
    const [chatInput, setChatInput] = useState("");
    const [copied, setCopied] = useState(false);
    const [tab, setTab] = useState<"chat" | "queue" | "voice">("chat");
    const chatBoxRef = useRef<HTMLDivElement | null>(null);
    const voice = useVoiceChat(party);

    useEffect(() => {
        if (chatBoxRef.current) chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }, [party.chat.length]);

    const inParty = party.roomId != null;
    const submitChat = () => {
        const v = chatInput.trim();
        if (!v) return;
        party.sendChat(v);
        setChatInput("");
    };
    const copyShare = async () => {
        if (!shareUrl) return;
        try {
            await navigator.clipboard.writeText(shareUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* noop */ }
    };

    return (
        <>
            <button
                type="button"
                onClick={() => {
                    if (!inParty) onCreate();
                    setOpen((o) => !o);
                }}
                title={inParty ? `${party.members.length} watching` : "Start watch party"}
                style={{
                    ...hostBtnStyle,
                    background: inParty
                        ? (party.connected ? "rgba(80,180,120,0.85)" : "rgba(180,120,80,0.85)")
                        : hostBtnStyle.background,
                    position: "relative",
                }}
            >
                <Users size={16} />
                {inParty && (
                    <span style={{
                        position: "absolute", top: -4, right: -4,
                        background: "#222", color: "#fff",
                        fontSize: 9, padding: "1px 4px",
                        borderRadius: 8, minWidth: 14, textAlign: "center",
                    }}>
                        {party.members.length}
                    </span>
                )}
            </button>

            {open && inParty && (
                <div style={{
                    position: "absolute", top: 56, right: 12, zIndex: 40,
                    width: 320, maxHeight: 480,
                    background: "rgba(15,15,18,0.95)",
                    backdropFilter: "blur(12px)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 12,
                    color: "white",
                    display: "flex", flexDirection: "column",
                    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
                }}>
                    <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                        <div style={{ fontSize: 13, fontWeight: 600, flex: 1, display: "flex", alignItems: "center", gap: 6 }}>
                            <Users size={14} />
                            Watch party
                            {party.isHost && <span style={{ fontSize: 9, background: "rgba(255,255,255,0.15)", padding: "1px 6px", borderRadius: 6 }}>HOST</span>}
                        </div>
                        <button type="button" onClick={() => setOpen(false)} style={{ background: "transparent", color: "white", border: 0, cursor: "pointer" }}>
                            <X size={14} />
                        </button>
                    </div>

                    {shareUrl && (
                        <div style={{ padding: "8px 12px", display: "flex", gap: 6, alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                            <input
                                readOnly
                                value={shareUrl}
                                style={{
                                    flex: 1, background: "rgba(255,255,255,0.05)", color: "white",
                                    border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6,
                                    padding: "4px 6px", fontSize: 11, fontFamily: "monospace",
                                }}
                            />
                            <button type="button" onClick={copyShare} title="Copy invite link" style={{
                                background: "rgba(255,255,255,0.08)", color: "white",
                                border: 0, borderRadius: 6, padding: "4px 8px",
                                cursor: "pointer", display: "flex", alignItems: "center",
                            }}>
                                {copied ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                        </div>
                    )}

                    <div style={{ padding: "6px 12px", display: "flex", gap: 4, flexWrap: "wrap", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                        {party.members.map((m) => {
                            const speaking = party.speakingIds.has(m.id);
                            return (
                                <span key={m.id} title={m.userId} style={{
                                    fontSize: 10, padding: "2px 6px",
                                    background: "rgba(255,255,255,0.08)",
                                    borderRadius: 4,
                                    boxShadow: speaking ? "0 0 0 1px rgba(120,220,160,0.8)" : undefined,
                                    display: "inline-flex", alignItems: "center", gap: 3,
                                }}>{speaking && <Mic size={9} />}{m.name}</span>
                            );
                        })}
                    </div>

                    {party.activeVote && (
                        <VotePrompt party={party} />
                    )}

                    <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                        {(["chat", "queue", "voice"] as const).map((t) => (
                            <button key={t} type="button" onClick={() => setTab(t)} style={{
                                flex: 1, background: tab === t ? "rgba(255,255,255,0.08)" : "transparent",
                                color: "white", border: 0, cursor: "pointer",
                                fontSize: 10, padding: "6px 0", textTransform: "uppercase", letterSpacing: 0.6,
                            }}>{t}</button>
                        ))}
                    </div>

                    <div ref={chatBoxRef} style={{ flex: 1, overflowY: "auto", padding: "6px 12px", minHeight: 160, maxHeight: 240, display: tab === "chat" ? "block" : "none" }}>
                        {party.chat.length === 0 && (
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", textAlign: "center", padding: "20px 0" }}>
                                <MessageCircle size={20} style={{ opacity: 0.4, marginBottom: 6 }} /><br />
                                No messages yet
                            </div>
                        )}
                        {party.chat.map((m) => (
                            <div key={m.id} style={{ fontSize: 12, marginBottom: 4 }}>
                                <span style={{ color: "rgba(180,200,255,0.85)", fontWeight: 600 }}>{m.from.name}</span>
                                <span style={{ color: "rgba(255,255,255,0.85)" }}>: {m.text}</span>
                            </div>
                        ))}
                    </div>

                    {tab === "queue" && (
                        <div style={{ padding: "8px 12px", maxHeight: 240, overflowY: "auto" }}>
                            {party.queue.length === 0 && (
                                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", textAlign: "center", padding: "20px 0" }}>
                                    <ListVideo size={20} style={{ opacity: 0.4, marginBottom: 6 }} /><br />
                                    Queue is empty
                                </div>
                            )}
                            {party.queue.map((q, i) => (
                                <div key={`${q.fileId}-${i}`} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, padding: "4px 0" }}>
                                    <span style={{ color: "rgba(255,255,255,0.4)", width: 18 }}>{i + 1}.</span>
                                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.title}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {tab === "voice" && (
                        <div style={{ padding: "16px 12px", display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
                            {!voice.enabled ? (
                                <button type="button" onClick={() => voice.setEnabled(true)} style={{
                                    background: "rgba(80,140,220,0.85)", color: "white", border: 0,
                                    borderRadius: 6, padding: "8px 14px", cursor: "pointer", fontSize: 12,
                                    display: "flex", alignItems: "center", gap: 6,
                                }}><Mic size={14} /> Join voice</button>
                            ) : (
                                <>
                                    <button type="button" onClick={voice.toggleMute} style={{
                                        background: voice.muted ? "rgba(200,80,80,0.3)" : "rgba(80,200,120,0.3)",
                                        color: "white", border: 0, borderRadius: "50%",
                                        width: 56, height: 56, cursor: "pointer",
                                        display: "flex", alignItems: "center", justifyContent: "center",
                                    }}>{voice.muted ? <MicOff size={20} /> : <Mic size={20} />}</button>
                                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>{voice.muted ? "Muted" : "Live"}</span>
                                    <button type="button" onClick={() => voice.setEnabled(false)} style={{
                                        background: "transparent", color: "rgba(220,120,120,0.9)",
                                        border: 0, fontSize: 11, cursor: "pointer",
                                    }}>Leave voice</button>
                                </>
                            )}
                        </div>
                    )}

                    <div style={{ padding: "4px 12px", display: tab === "chat" ? "flex" : "none", gap: 4, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                        {QUICK_EMOJI.map((e) => (
                            <button key={e} type="button" onClick={() => party.sendReaction(e)} title={`React ${e}`} style={{
                                background: "transparent", color: "white", border: 0,
                                cursor: "pointer", fontSize: 16, padding: "2px 4px",
                            }}>{e}</button>
                        ))}
                    </div>

                    <div style={{ padding: "8px 10px", display: tab === "chat" ? "flex" : "none", gap: 6, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                        <input
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") submitChat(); }}
                            placeholder="Say something..."
                            maxLength={500}
                            style={{
                                flex: 1, background: "rgba(255,255,255,0.06)", color: "white",
                                border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6,
                                padding: "5px 8px", fontSize: 12, outline: "none",
                            }}
                        />
                        <button type="button" onClick={submitChat} disabled={!chatInput.trim()} style={{
                            background: chatInput.trim() ? "rgba(100,140,220,0.85)" : "rgba(255,255,255,0.08)",
                            color: "white", border: 0, borderRadius: 6, padding: "5px 10px",
                            cursor: chatInput.trim() ? "pointer" : "not-allowed",
                            display: "flex", alignItems: "center",
                        }}>
                            <Send size={12} />
                        </button>
                    </div>

                    <div style={{ padding: "6px 12px", display: "flex", justifyContent: "space-between", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                        <span style={{ fontSize: 10, color: party.connected ? "rgba(120,220,160,0.9)" : "rgba(220,120,120,0.9)" }}>
                            ● {party.connected ? "Connected" : "Disconnected"}
                        </span>
                        <button type="button" onClick={() => { party.disconnect(); onClose(); setOpen(false); }} style={{
                            background: "transparent", border: 0,
                            color: "rgba(220,120,120,0.9)", fontSize: 10, cursor: "pointer",
                        }}>Leave party</button>
                    </div>
                </div>
            )}
        </>
    );
}

/** Inline countdown card shown above the chat tabs while a skip-to-chapter
 *  vote is open. Auto-disappears when the server broadcasts the result. */
function VotePrompt({ party }: { party: PartyConnection }) {
    const v = party.activeVote;
    if (!v) return null;
    const elapsed = Math.floor((Date.now() - v.openedAt) / 1000);
    const remaining = Math.max(0, 8 - elapsed);
    return (
        <div style={{
            padding: "10px 12px",
            background: "rgba(80,140,220,0.15)",
            borderBottom: "1px solid rgba(80,140,220,0.3)",
            display: "flex", flexDirection: "column", gap: 6,
        }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.85)" }}>
                <strong>{v.fromName}</strong> wants to skip to <strong>{v.label}</strong> · {remaining}s
            </div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
                {v.yes} yes · {v.no} no · {v.total} total
            </div>
            <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={() => party.castVote(v.id, "yes")} style={{
                    flex: 1, background: "rgba(80,200,120,0.25)", color: "white",
                    border: "1px solid rgba(80,200,120,0.5)", borderRadius: 6,
                    padding: "4px 8px", fontSize: 11, cursor: "pointer",
                    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
                }}><ThumbsUp size={12} /> Yes</button>
                <button type="button" onClick={() => party.castVote(v.id, "no")} style={{
                    flex: 1, background: "rgba(200,80,80,0.2)", color: "white",
                    border: "1px solid rgba(200,80,80,0.4)", borderRadius: 6,
                    padding: "4px 8px", fontSize: 11, cursor: "pointer",
                    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
                }}><ThumbsDown size={12} /> No</button>
            </div>
        </div>
    );
}

/** Floating bubble that bursts upward with reaction emojis. */
export function ReactionBurst({ reactions }: { reactions: Array<{ id: string; emoji: string; from: { name: string } }> }) {
    const [active, setActive] = useState<Array<{ id: string; emoji: string; from: string; x: number }>>([]);
    const seen = useRef<Set<string>>(new Set());

    useEffect(() => {
        for (const r of reactions) {
            if (seen.current.has(r.id)) continue;
            seen.current.add(r.id);
            const x = 20 + Math.random() * 60;
            setActive((a) => [...a, { id: r.id, emoji: r.emoji, from: r.from.name, x }]);
            setTimeout(() => setActive((a) => a.filter((it) => it.id !== r.id)), 2400);
        }
    }, [reactions]);

    return (
        <div style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            overflow: "hidden", zIndex: 25,
        }}>
            {active.map((r) => (
                <div key={r.id} style={{
                    position: "absolute", bottom: 80, left: `${r.x}%`,
                    fontSize: 36, animation: "mmo-burst 2.4s ease-out forwards",
                    textShadow: "0 2px 8px rgba(0,0,0,0.6)",
                }}>
                    {r.emoji}
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.7)", textAlign: "center" }}>{r.from}</div>
                </div>
            ))}
            <style>{`
                @keyframes mmo-burst {
                    0% { transform: translateY(0) scale(0.6); opacity: 0; }
                    20% { transform: translateY(-20px) scale(1.1); opacity: 1; }
                    100% { transform: translateY(-180px) scale(0.9); opacity: 0; }
                }
            `}</style>
        </div>
    );
}
