"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getPartyHandle } from "@/actions/watch-party";

export interface PartyMember {
    id: string;
    userId: string;
    name: string;
}

export interface PartyRoomState {
    fileId?: string;
    title?: string;
    playing: boolean;
    timeSec: number;
    lastUpdatedMs: number;
}

export interface ChatMessage {
    id: string;
    from: PartyMember;
    text: string;
    ts: number;
}

export interface ReactionEvent {
    id: string;
    from: PartyMember;
    emoji: string;
    ts: number;
}

export interface PartyQueueItem {
    fileId: string;
    title: string;
    posterUrl?: string;
    durationSec?: number;
}

export interface PartyVote {
    id: string;
    fromId: string;
    fromName: string;
    targetTimeSec: number;
    label: string;
    openedAt: number;
    yes: number;
    no: number;
    total: number;
}

export interface PartyCursor {
    memberId: string;
    name: string;
    x: number;
    ts: number;
}

export type RtcMessage =
    | { kind: "offer"; sdp: RTCSessionDescriptionInit }
    | { kind: "answer"; sdp: RTCSessionDescriptionInit }
    | { kind: "ice"; candidate: RTCIceCandidateInit };

export interface PartyConnection {
    roomId: string | null;
    connected: boolean;
    youId: string | null;
    isHost: boolean;
    members: PartyMember[];
    state: PartyRoomState | null;
    chat: ChatMessage[];
    reactions: ReactionEvent[];
    queue: PartyQueueItem[];
    activeVote: PartyVote | null;
    lastVoteResult: { id: string; passed: boolean; targetTimeSec: number; ts: number } | null;
    cursors: Map<string, PartyCursor>;
    speakingIds: Set<string>;
    sendState: (s: { playing: boolean; timeSec: number; fileId?: string; title?: string }) => void;
    sendChat: (text: string) => void;
    sendReaction: (emoji: string) => void;
    sendQueue: (items: PartyQueueItem[]) => void;
    sendCursor: (x: number) => void;
    proposeVote: (targetTimeSec: number, label: string) => void;
    castVote: (id: string, vote: "yes" | "no") => void;
    sendRtc: (toId: string, payload: RtcMessage) => void;
    onRtc: (cb: ((from: string, fromName: string, payload: RtcMessage) => void) | null) => void;
    sendVoiceStatus: (speaking: boolean) => void;
    disconnect: () => void;
}

const DEFAULT: PartyConnection = {
    roomId: null,
    connected: false,
    youId: null,
    isHost: false,
    members: [],
    state: null,
    chat: [],
    reactions: [],
    queue: [],
    activeVote: null,
    lastVoteResult: null,
    cursors: new Map(),
    speakingIds: new Set(),
    sendState: () => undefined,
    sendChat: () => undefined,
    sendReaction: () => undefined,
    sendQueue: () => undefined,
    sendCursor: () => undefined,
    proposeVote: () => undefined,
    castVote: () => undefined,
    sendRtc: () => undefined,
    onRtc: () => undefined,
    sendVoiceStatus: () => undefined,
    disconnect: () => undefined,
};

export function useWatchParty(roomId: string | null, displayName: string): PartyConnection {
    const [conn, setConn] = useState<PartyConnection>(DEFAULT);
    const wsRef = useRef<WebSocket | null>(null);
    const rtcCbRef = useRef<((from: string, fromName: string, payload: RtcMessage) => void) | null>(null);

    useEffect(() => {
        if (!roomId) {
            setConn(DEFAULT);
            return;
        }
        let cancelled = false;
        let ws: WebSocket | null = null;
        const cursorBuf = new Map<string, PartyCursor>();
        let cursorFlush: ReturnType<typeof setTimeout> | null = null;

        void (async () => {
            const handle = await getPartyHandle();
            if (cancelled || !handle) return;
            const wsBase = handle.apiUrl.replace(/^http/, "ws");
            const url = `${wsBase}/party/${encodeURIComponent(roomId)}`
                + `?token=${encodeURIComponent(handle.token)}`
                + `&u=${encodeURIComponent(handle.userId)}`
                + `&name=${encodeURIComponent(displayName)}`;
            ws = new WebSocket(url);
            wsRef.current = ws;

            const send = (m: object) => {
                if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
            };

            ws.onopen = () => {
                setConn((c) => ({
                    ...c,
                    roomId,
                    connected: true,
                    sendState: (s) => send({ type: "state", ...s }),
                    sendChat: (text) => send({ type: "chat", text }),
                    sendReaction: (emoji) => send({ type: "reaction", emoji }),
                    sendQueue: (items) => send({ type: "queue:set", items }),
                    sendCursor: (x) => send({ type: "cursor", x }),
                    proposeVote: (targetTimeSec, label) => send({ type: "vote:propose", targetTimeSec, label }),
                    castVote: (id, vote) => send({ type: "vote:cast", id, vote }),
                    sendRtc: (to, payload) => send({ type: "rtc:signal", to, payload }),
                    onRtc: (cb) => { rtcCbRef.current = cb; },
                    sendVoiceStatus: (speaking) => send({ type: "voice:status", speaking }),
                    disconnect: () => { try { ws?.close(); } catch { /* noop */ } },
                }));
            };
            ws.onclose = () => {
                setConn((c) => ({ ...c, connected: false }));
            };
            ws.onerror = () => {
                setConn((c) => ({ ...c, connected: false }));
            };
            ws.onmessage = (ev) => {
                let msg: { type?: string;[k: string]: unknown };
                try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
                if (!msg || typeof msg.type !== "string") return;
                switch (msg.type) {
                    case "hello": {
                        const you = msg.you as { id: string; isHost: boolean };
                        const room = msg.room as { members: PartyMember[]; state: PartyRoomState; hostId: string; queue?: PartyQueueItem[] };
                        setConn((c) => ({
                            ...c,
                            youId: you.id,
                            isHost: you.isHost,
                            members: room.members,
                            state: room.state,
                            queue: room.queue ?? [],
                        }));
                        break;
                    }
                    case "member:join": {
                        const m = msg.member as PartyMember;
                        setConn((c) => ({ ...c, members: [...c.members.filter((x) => x.id !== m.id), m] }));
                        break;
                    }
                    case "member:leave": {
                        const id = msg.memberId as string;
                        setConn((c) => ({ ...c, members: c.members.filter((x) => x.id !== id) }));
                        break;
                    }
                    case "host:change": {
                        const hostId = msg.hostId as string;
                        setConn((c) => ({ ...c, isHost: c.youId === hostId }));
                        break;
                    }
                    case "state": {
                        const state = msg.state as PartyRoomState;
                        setConn((c) => ({ ...c, state }));
                        break;
                    }
                    case "chat": {
                        const cm: ChatMessage = {
                            id: Math.random().toString(36).slice(2),
                            from: msg.from as PartyMember,
                            text: msg.text as string,
                            ts: msg.ts as number,
                        };
                        setConn((c) => ({ ...c, chat: [...c.chat.slice(-99), cm] }));
                        break;
                    }
                    case "reaction": {
                        const re: ReactionEvent = {
                            id: Math.random().toString(36).slice(2),
                            from: msg.from as PartyMember,
                            emoji: msg.emoji as string,
                            ts: msg.ts as number,
                        };
                        setConn((c) => ({ ...c, reactions: [...c.reactions.slice(-19), re] }));
                        break;
                    }
                    case "queue:state": {
                        const items = (msg.items as PartyQueueItem[]) ?? [];
                        setConn((c) => ({ ...c, queue: items }));
                        break;
                    }
                    case "cursor": {
                        cursorBuf.set(msg.memberId as string, {
                            memberId: msg.memberId as string,
                            name: msg.name as string,
                            x: msg.x as number,
                            ts: Date.now(),
                        });
                        if (!cursorFlush) {
                            cursorFlush = setTimeout(() => {
                                const next = new Map(cursorBuf);
                                cursorBuf.clear();
                                cursorFlush = null;
                                setConn((c) => {
                                    const merged = new Map(c.cursors);
                                    for (const [k, v] of next) merged.set(k, v);
                                    const cutoff = Date.now() - 3000;
                                    for (const [k, v] of merged) if (v.ts < cutoff) merged.delete(k);
                                    return { ...c, cursors: merged };
                                });
                            }, 80);
                        }
                        break;
                    }
                    case "vote:open": {
                        const v = msg.vote as Omit<PartyVote, "yes" | "no" | "total">;
                        setConn((c) => ({ ...c, activeVote: { ...v, yes: 1, no: 0, total: c.members.length } }));
                        break;
                    }
                    case "vote:tally": {
                        setConn((c) => c.activeVote && c.activeVote.id === msg.id
                            ? { ...c, activeVote: { ...c.activeVote, yes: msg.yes as number, no: msg.no as number, total: msg.total as number } }
                            : c);
                        break;
                    }
                    case "vote:result": {
                        setConn((c) => ({
                            ...c,
                            activeVote: null,
                            lastVoteResult: {
                                id: msg.id as string,
                                passed: !!msg.passed,
                                targetTimeSec: msg.targetTimeSec as number,
                                ts: Date.now(),
                            },
                        }));
                        break;
                    }
                    case "rtc:signal": {
                        if (rtcCbRef.current) {
                            rtcCbRef.current(msg.from as string, msg.fromName as string, msg.payload as RtcMessage);
                        }
                        break;
                    }
                    case "voice:status": {
                        const id = msg.memberId as string;
                        const speaking = !!msg.speaking;
                        setConn((c) => {
                            const next = new Set(c.speakingIds);
                            if (speaking) next.add(id); else next.delete(id);
                            return { ...c, speakingIds: next };
                        });
                        break;
                    }
                }
            };
        })();

        return () => {
            cancelled = true;
            try { ws?.close(); } catch { /* noop */ }
            if (cursorFlush) clearTimeout(cursorFlush);
            wsRef.current = null;
        };
    }, [roomId, displayName]);

    return conn;
}

/** WebRTC voice chat layered on the party signaling channel. */
export function useVoiceChat(party: PartyConnection) {
    const [enabled, setEnabled] = useState(false);
    const [muted, setMuted] = useState(false);
    const localStreamRef = useRef<MediaStream | null>(null);
    const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
    const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

    useEffect(() => {
        if (!enabled || !party.connected || !party.youId) return;
        let cancelled = false;
        const peers = peersRef.current;
        const audioEls = audioElsRef.current;

        void (async () => {
            try {
                localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            } catch {
                setEnabled(false);
                return;
            }
            if (cancelled) return;

            const makePeer = (peerId: string, initiator: boolean) => {
                const existing = peers.get(peerId);
                if (existing) return existing;
                const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
                peers.set(peerId, pc);
                const stream = localStreamRef.current;
                if (stream) for (const track of stream.getTracks()) pc.addTrack(track, stream);
                pc.onicecandidate = (e) => {
                    if (e.candidate) party.sendRtc(peerId, { kind: "ice", candidate: e.candidate.toJSON() });
                };
                pc.ontrack = (e) => {
                    let el = audioEls.get(peerId);
                    if (!el) {
                        el = document.createElement("audio");
                        el.autoplay = true;
                        document.body.appendChild(el);
                        audioEls.set(peerId, el);
                    }
                    el.srcObject = e.streams[0];
                };
                if (initiator) {
                    void (async () => {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        party.sendRtc(peerId, { kind: "offer", sdp: offer });
                    })();
                }
                return pc;
            };

            for (const m of party.members) {
                if (m.id !== party.youId) makePeer(m.id, true);
            }

            party.onRtc(async (from, _fromName, payload) => {
                const pc = makePeer(from, false);
                if (payload.kind === "offer") {
                    await pc.setRemoteDescription(payload.sdp);
                    const ans = await pc.createAnswer();
                    await pc.setLocalDescription(ans);
                    party.sendRtc(from, { kind: "answer", sdp: ans });
                } else if (payload.kind === "answer") {
                    await pc.setRemoteDescription(payload.sdp);
                } else if (payload.kind === "ice") {
                    try { await pc.addIceCandidate(payload.candidate); } catch { /* noop */ }
                }
            });
        })();

        return () => {
            cancelled = true;
            party.onRtc(null);
            for (const pc of peers.values()) try { pc.close(); } catch { /* noop */ }
            peers.clear();
            for (const el of audioEls.values()) {
                try { el.srcObject = null; el.remove(); } catch { /* noop */ }
            }
            audioEls.clear();
            if (localStreamRef.current) {
                for (const t of localStreamRef.current.getTracks()) t.stop();
                localStreamRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, party.connected, party.youId]);

    const toggleMute = useCallback(() => {
        const m = !muted;
        setMuted(m);
        if (localStreamRef.current) {
            for (const t of localStreamRef.current.getAudioTracks()) t.enabled = !m;
        }
        party.sendVoiceStatus(!m);
    }, [muted, party]);

    return { enabled, setEnabled, muted, toggleMute };
}
