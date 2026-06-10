/**
 * Remote Sync Engine
 *
 * BroadcastChannel-based peer-to-peer communication between browser tabs.
 * Each page (mixer/daw/editor) broadcasts its state. The /remote page
 * discovers peers, subscribes to state, and sends commands back.
 *
 * Protocol:
 *   peer:announce   – new peer online (with page info)
 *   peer:heartbeat  – keep-alive (every 2s)
 *   peer:bye        – peer disconnecting
 *   peer:discover   – request all peers to re-announce
 *   state:snapshot  – full state from host
 *   command:exec    – remote sends action to host
 *   command:ack     – host acknowledges command execution
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type RemotePage = "mixer" | "daw" | "editor" | "live" | "idle";

export interface PeerInfo {
    id: string;
    page: RemotePage;
    label: string;       // user-friendly label e.g. "Mixer — Chrome Desktop"
    lastSeen: number;    // Date.now()
    userAgent: string;
}

// ── Mixer snapshot ───────────────────────────────────────────────────────────

export interface MixerDeckSnapshot {
    trackId: number | null;
    trackTitle: string;
    trackArtist: string;
    artworkUrl: string | null;
    isPlaying: boolean;
    isLoaded: boolean;
    currentTime: number;
    duration: number;
    bpm: number;
    originalBpm: number;
    key: string;
    volume: number;
    eqLow: number;
    eqMid: number;
    eqHi: number;
    eqLowKill: boolean;
    eqMidKill: boolean;
    eqHiKill: boolean;
    filter: number;
    filterType: string;
    colorFx: number;
    colorFxType: string;
    beatFxOn: boolean;
    beatFxType: string;
    beatFxAmount: number;
    beatFxBeatDiv: number;
    loopEnabled: boolean;
    loopBeats: number;
    hotCues: (number | null)[];
    headphoneCue: boolean;
    padMode: string;
    slipMode: boolean;
    quantize: boolean;
    keyLock: boolean;
    keyShift: number;
    crossfaderAssign: string;
}

export interface MixerSamplerSlotSnapshot {
    id: number;
    name: string;
    isPlaying: boolean;
    volume: number;
    isLooping: boolean;
    hasAudio: boolean;
}

export interface MixerSnapshot {
    page: "mixer";
    deckA: MixerDeckSnapshot;
    deckB: MixerDeckSnapshot;
    deckC: MixerDeckSnapshot;
    deckD: MixerDeckSnapshot;
    deckMode: string;
    crossfader: number;
    crossfaderCurve: string;
    masterVolume: number;
    headphoneVolume: number;
    headphoneMix: number;
    eqMode: string;
    tempoRange: number;
    isRecording: boolean;
    recordingDuration: number;
    automixEnabled: boolean;
    samplerSlots: MixerSamplerSlotSnapshot[];
}

// ── DAW snapshot ─────────────────────────────────────────────────────────────

export interface DAWInsertSnapshot {
    id: string;
    type: string;
    enabled: boolean;
    params: Record<string, number>;
}

export interface DAWTrackSnapshot {
    id: string;
    name: string;
    type: string;
    color: string;
    volume: number;
    pan: number;
    muted: boolean;
    soloed: boolean;
    armed: boolean;
    peakL: number;
    peakR: number;
    inserts: DAWInsertSnapshot[];
}

export interface DAWSynthOscSnapshot {
    type: string;
    detune: number;
    octave: number;
    gain: number;
    enabled: boolean;
}

export interface DAWSynthSnapshot {
    oscillators: DAWSynthOscSnapshot[];
    filterType: string;
    filterCutoff: number;
    filterResonance: number;
    filterEnvAmount: number;
    ampAttack: number;
    ampDecay: number;
    ampSustain: number;
    ampRelease: number;
    filterAttack: number;
    filterDecay: number;
    filterSustain: number;
    filterRelease: number;
    lfoRate: number;
    lfoDepth: number;
    lfoTarget: string;
    lfoShape: string;
    reverbMix: number;
    delayMix: number;
    delayTime: number;
    masterGain: number;
}

export interface DAWStepTrackSnapshot {
    id: string;
    name: string;
    steps: { active: boolean; velocity: number }[];
    volume: number;
    pan: number;
    muted: boolean;
    soloed: boolean;
    pitch: number;
}

export interface DAWStepSeqSnapshot {
    steps: number;
    swing: number;
    tracks: DAWStepTrackSnapshot[];
}

export interface VPFxSnapshot {
    id: string;
    type: string;
    enabled: boolean;
    params: Record<string, number>;
}

export interface VPSnapshot {
    isActive: boolean;
    inputGain: number;
    outputGain: number;
    selectedKey: number;
    selectedScale: number;
    chain: VPFxSnapshot[];
    peakL: number;
    peakR: number;
    rms: number;
    pitchNote: string;
    pitchCents: number;
    pitchConfidence: number;
}

export interface DAWSnapshot {
    page: "daw";
    projectName: string;
    tempo: number;
    isPlaying: boolean;
    isRecording: boolean;
    currentBeat: number;
    currentStepIndex: number;
    playbackMode: string;
    metronomeOn: boolean;
    metronomeVolume: number;
    tracks: DAWTrackSnapshot[];
    masterPeakL: number;
    masterPeakR: number;
    masterVolume: number;
    showVoiceProcessor: boolean;
    showEffectsRack: boolean;
    showSynth: boolean;
    showStepSequencer: boolean;
    showMixer: boolean;
    showPianoRoll: boolean;
    showAutomation: boolean;
    synth: DAWSynthSnapshot;
    stepSeq: DAWStepSeqSnapshot;
    selectedTrackId: string | null;
    tool: string;
    snap: string;
    vp: VPSnapshot | null;
}

// ── Editor snapshot ──────────────────────────────────────────────────────────

export interface EditorStem {
    name: string;
    color: string;
    active: boolean;
}

export interface EditorSnapshot {
    page: "editor";
    fileName: string;
    isPlaying: boolean;
    isRecording: boolean;
    currentTime: number;
    duration: number;
    sampleRate: number;
    channels: number;
    activeTool: string;
    view: string;
    zoom: number;
    hasSelection: boolean;
    selectionStart: number;
    selectionEnd: number;
    isSeparatingStems: boolean;
    stemsProgress: number;
    stems: EditorStem[];
    peakL: number;
    peakR: number;
    canUndo: boolean;
    canRedo: boolean;
}

// ── Live snapshot ────────────────────────────────────────────────────────────

export interface LiveLooperSnapshot {
    id: number;
    state: "empty" | "recording" | "playing" | "stopped" | "overdubbing";
    durationBeats: number;
    positionBeats: number;
    volume: number;
    muted: boolean;
}

export interface LivePadSnapshot {
    id: number;
    name: string;
    color: string;
    hasAudio: boolean;
    isPlaying: boolean;
    volume: number;
    loop: boolean;
}

export interface LiveSetSongSnapshot {
    id: string;
    name: string;
    tempo: number;
    keyIndex: number;
    scaleIndex: number;
}

export interface LiveSnapshot {
    page: "live";
    // Master
    masterVolume: number;
    monitorVolume: number;
    masterPeakL: number;
    masterPeakR: number;
    isLimiting: boolean;
    // Tempo / Key
    tempo: number;
    isMetronomeOn: boolean;
    metronomeMonitorOnly: boolean;
    keyIndex: number;
    scaleIndex: number;
    // Recording (full session)
    isRecording: boolean;
    recordingDuration: number; // ms
    // Backing track
    backingLoaded: boolean;
    backingName: string;
    backingIsPlaying: boolean;
    backingPosition: number;   // seconds
    backingDuration: number;   // seconds
    backingVolume: number;
    backingTempoRatio: number; // 0.5..1.5
    backingPitchSemis: number; // -12..+12
    backingLoopActive: boolean;
    // Voice (reuses VPSnapshot shape)
    voice: VPSnapshot | null;
    // Looper
    loopers: LiveLooperSnapshot[];
    activeLooperId: number | null;
    looperBeatLength: number; // bars per loop
    // Pads
    pads: LivePadSnapshot[];
    // Tuner
    tunerNote: string;
    tunerCents: number;
    tunerFrequency: number;
    tunerConfidence: number;
    // Tap BPM history
    tapCount: number;
    // Set list
    songs: LiveSetSongSnapshot[];
    activeSongId: string | null;
    // Compact master visualization data (32 bins each, 0-255 byte values).
    // Spectrum is log-bucketed magnitudes; waveform is time-domain samples
    // centered on 128. Optional so older clients still type-check.
    spectrum?: number[];
    waveform?: number[];
}

export type StateSnapshot = MixerSnapshot | DAWSnapshot | EditorSnapshot | LiveSnapshot;

// ── Command types ────────────────────────────────────────────────────────────

export interface RemoteCommand {
    targetPeerId: string;
    action: string;          // e.g. "mixer.play", "daw.setTrackVolume"
    args: unknown[];         // arguments for the action
}

// ── Messages ─────────────────────────────────────────────────────────────────

interface MsgBase {
    senderId: string;
    timestamp: number;
}

export interface PeerAnnounce extends MsgBase {
    type: "peer:announce";
    peer: PeerInfo;
}

export interface PeerHeartbeat extends MsgBase {
    type: "peer:heartbeat";
    page: RemotePage;
}

export interface PeerBye extends MsgBase {
    type: "peer:bye";
}

export interface PeerDiscover extends MsgBase {
    type: "peer:discover";
}

export interface StateSnapshotMsg extends MsgBase {
    type: "state:snapshot";
    snapshot: StateSnapshot;
}

export interface CommandExec extends MsgBase {
    type: "command:exec";
    command: RemoteCommand;
}

export interface CommandAck extends MsgBase {
    type: "command:ack";
    commandAction: string;
    success: boolean;
    error?: string;
}

/**
 * WebRTC signaling envelope. The `payload` is opaque to the relay —
 * it carries SDP offers/answers and ICE candidates between two peers.
 * `targetPeerId` ensures only the addressed peer processes it.
 */
export interface WebRTCSignalMsg extends MsgBase {
    type: "webrtc:signal";
    targetPeerId: string;
    payload: unknown;
}

export type SyncMessage =
    | PeerAnnounce
    | PeerHeartbeat
    | PeerBye
    | PeerDiscover
    | StateSnapshotMsg
    | CommandExec
    | CommandAck
    | WebRTCSignalMsg;

// ─── Sync Engine ─────────────────────────────────────────────────────────────

const CHANNEL_NAME = "rekordbox-remote-sync";
const HEARTBEAT_INTERVAL = 2000;
const PEER_TIMEOUT = 6000;
const SSE_RECONNECT_DELAY = 1500;
// State snapshots over the network. The host loop ticks at ~10 Hz (100 ms);
// 150 ms throttle = ~6.6 POST/sec, smooth enough for meters/playheads on the
// remote while halving HTTP chatter compared to 80 ms.
const SERVER_SEND_THROTTLE = 150;

type MessageHandler = (msg: SyncMessage) => void;

export class RemoteSyncEngine {
    readonly peerId: string;
    private channel: BroadcastChannel | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    private handlers = new Set<MessageHandler>();
    private _peers = new Map<string, PeerInfo>();
    private _page: RemotePage = "idle";
    private _destroyed = false;

    // Server relay (SSE + POST)
    private eventSource: EventSource | null = null;
    private sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private lastServerSend = 0;
    private pendingServerSend: ReturnType<typeof setTimeout> | null = null;
    /**
     * Set to true when the server relay returns 401 (no session). Happens
     * when the app is opened on a host where the user hasn't signed in
     * — e.g. a VS Code dev tunnel URL while only `localhost` is logged in.
     * Once disabled, all server POST / SSE attempts are skipped and the
     * client falls back to BroadcastChannel-only mode (same-origin tabs).
     */
    private serverDisabled = false;

    constructor(page: RemotePage = "idle", label?: string) {
        this.peerId = crypto.randomUUID();
        this._page = page;

        // 1) BroadcastChannel for same-browser tabs
        try {
            this.channel = new BroadcastChannel(CHANNEL_NAME);
            this.channel.onmessage = (ev: MessageEvent<SyncMessage>) => {
                const msg = ev.data;
                if (!msg || msg.senderId === this.peerId) return;
                this.handleMessage(msg);
            };
        } catch {
            // BroadcastChannel not available (e.g. some mobile browsers)
            this.channel = null;
        }

        // 2) Server relay via SSE
        this.connectSSE();

        // Announce self
        const peerInfo: PeerInfo = {
            id: this.peerId,
            page,
            label: label || this.makeLabel(page),
            lastSeen: Date.now(),
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        };
        this.send({ type: "peer:announce", senderId: this.peerId, timestamp: Date.now(), peer: peerInfo });

        // Ask others to announce
        this.send({ type: "peer:discover", senderId: this.peerId, timestamp: Date.now() });

        // Heartbeat
        this.heartbeatTimer = setInterval(() => {
            if (this._destroyed) return;
            this.send({ type: "peer:heartbeat", senderId: this.peerId, timestamp: Date.now(), page: this._page });
        }, HEARTBEAT_INTERVAL);

        // Cleanup stale peers
        this.cleanupTimer = setInterval(() => {
            const now = Date.now();
            for (const [id, peer] of this._peers) {
                if (now - peer.lastSeen > PEER_TIMEOUT) {
                    this._peers.delete(id);
                    this.notifyHandlers({ type: "peer:bye", senderId: id, timestamp: now });
                }
            }
        }, HEARTBEAT_INTERVAL);
    }

    // ── SSE connection ───────────────────────────────────────────────────────

    private connectSSE() {
        if (this._destroyed || this.serverDisabled) return;
        if (typeof EventSource === "undefined") return;

        try {
            this.eventSource = new EventSource(`/api/remote/events?peerId=${encodeURIComponent(this.peerId)}`);

            this.eventSource.onmessage = (ev) => {
                try {
                    const msg = JSON.parse(ev.data) as SyncMessage;
                    if (msg.senderId === this.peerId) return;
                    this.handleMessage(msg);
                } catch { /* malformed SSE data */ }
            };

            this.eventSource.onerror = () => {
                this.eventSource?.close();
                this.eventSource = null;
                if (this._destroyed) return;
                // EventSource doesn't expose HTTP status — probe with fetch to
                // distinguish a transient network error from a 401 (no session
                // on this host, e.g. tunnel domain). On 401 we stop retrying.
                void this.probeAuth().then((ok) => {
                    if (!ok || this._destroyed || this.serverDisabled) return;
                    this.sseRetryTimer = setTimeout(() => this.connectSSE(), SSE_RECONNECT_DELAY);
                });
            };
        } catch {
            // SSE failed to open — will retry
            if (!this._destroyed && !this.serverDisabled) {
                this.sseRetryTimer = setTimeout(() => this.connectSSE(), SSE_RECONNECT_DELAY);
            }
        }
    }

    /**
     * Quick HEAD-style probe to see whether the server relay is reachable
     * AND we're authenticated. Returns false on 401, in which case we
     * disable the server relay entirely for the lifetime of this client.
     */
    private async probeAuth(): Promise<boolean> {
        try {
            const res = await fetch(`/api/remote/send`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // Empty body — server returns 400, but only after auth check.
                // 401 means "no session here"; anything else means we're in.
                body: "{}",
            });
            if (res.status === 401) {
                this.disableServerRelay("401 Unauthorized");
                return false;
            }
            return true;
        } catch {
            // Network failure — keep retrying
            return true;
        }
    }

    private disableServerRelay(reason: string) {
        if (this.serverDisabled) return;
        this.serverDisabled = true;
        if (this.sseRetryTimer) {
            clearTimeout(this.sseRetryTimer);
            this.sseRetryTimer = null;
        }
        if (this.pendingServerSend) {
            clearTimeout(this.pendingServerSend);
            this.pendingServerSend = null;
        }
        this.eventSource?.close();
        this.eventSource = null;
        if (process.env.NODE_ENV !== "production") {
             
            console.info(`[remote-sync] server relay disabled (${reason}) — falling back to BroadcastChannel only`);
        }
    }

    // ── Server relay POST ────────────────────────────────────────────────────

    /**
     * State snapshots are only consumed by remote controllers (peers with
     * page === "idle"). When no such peer is known, skip the server POST
     * entirely — local BroadcastChannel still works for same-origin tabs.
     */
    private hasRemoteSubscriber(): boolean {
        for (const p of this._peers.values()) {
            if (p.page === "idle") return true;
        }
        return false;
    }

    private sendToServer(msg: SyncMessage) {
        if (this._destroyed || this.serverDisabled) return;

        // Skip server relay for state snapshots when no remote controller listens
        if (msg.type === "state:snapshot" && !this.hasRemoteSubscriber()) {
            return;
        }

        // Throttle state:snapshot messages to avoid flooding
        if (msg.type === "state:snapshot") {
            const now = Date.now();
            const elapsed = now - this.lastServerSend;
            if (elapsed < SERVER_SEND_THROTTLE) {
                // Schedule a delayed send, replacing any pending one
                if (this.pendingServerSend) clearTimeout(this.pendingServerSend);
                this.pendingServerSend = setTimeout(() => {
                    this.pendingServerSend = null;
                    this.doServerPost(msg);
                }, SERVER_SEND_THROTTLE - elapsed);
                return;
            }
        }

        this.doServerPost(msg);
    }

    private doServerPost(msg: SyncMessage) {
        if (this.serverDisabled) return;
        this.lastServerSend = Date.now();
        fetch("/api/remote/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ senderId: this.peerId, message: msg }),
        }).then((res) => {
            if (res.status === 401) this.disableServerRelay("401 Unauthorized");
        }).catch(() => { /* network error — silent */ });
    }

    private makeLabel(page: RemotePage): string {
        const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
        const isMobile = /mobile|android|iphone|ipad/i.test(ua);
        const browser = /firefox/i.test(ua) ? "Firefox" : /edg/i.test(ua) ? "Edge" : /chrome/i.test(ua) ? "Chrome" : /safari/i.test(ua) ? "Safari" : "Browser";
        const device = isMobile ? "Mobile" : "Desktop";
        const pageLabel = page === "idle" ? "Remote" : page.charAt(0).toUpperCase() + page.slice(1);
        return `${pageLabel} — ${browser} ${device}`;
    }

    private handleMessage(msg: SyncMessage) {
        switch (msg.type) {
            case "peer:announce": {
                this._peers.set(msg.peer.id, { ...msg.peer, lastSeen: Date.now() });
                break;
            }
            case "peer:heartbeat": {
                const existing = this._peers.get(msg.senderId);
                if (existing) {
                    existing.lastSeen = Date.now();
                    existing.page = msg.page;
                } else {
                    // Unknown peer heartbeating — ask them to announce
                    this.send({ type: "peer:discover", senderId: this.peerId, timestamp: Date.now() });
                }
                break;
            }
            case "peer:bye": {
                this._peers.delete(msg.senderId);
                break;
            }
            case "peer:discover": {
                // Re-announce self
                this.send({
                    type: "peer:announce",
                    senderId: this.peerId,
                    timestamp: Date.now(),
                    peer: {
                        id: this.peerId,
                        page: this._page,
                        label: this.makeLabel(this._page),
                        lastSeen: Date.now(),
                        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
                    },
                });
                break;
            }
        }
        this.notifyHandlers(msg);
    }

    private notifyHandlers(msg: SyncMessage) {
        for (const handler of this.handlers) {
            try { handler(msg); } catch { /* ignore */ }
        }
    }

    /** Send via both BroadcastChannel (local) and server relay (cross-device) */
    private send(msg: SyncMessage) {
        if (this._destroyed) return;
        // Local: BroadcastChannel
        try { this.channel?.postMessage(msg); } catch { /* channel closed */ }
        // Remote: Server relay
        this.sendToServer(msg);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    get peers(): PeerInfo[] {
        return Array.from(this._peers.values());
    }

    get page(): RemotePage {
        return this._page;
    }

    setPage(page: RemotePage) {
        this._page = page;
        // Re-announce with updated page
        this.send({
            type: "peer:announce",
            senderId: this.peerId,
            timestamp: Date.now(),
            peer: {
                id: this.peerId,
                page,
                label: this.makeLabel(page),
                lastSeen: Date.now(),
                userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
            },
        });
    }

    /** Broadcast a state snapshot (called by host pages) */
    broadcastState(snapshot: StateSnapshot) {
        this.send({ type: "state:snapshot", senderId: this.peerId, timestamp: Date.now(), snapshot });
    }

    /** Send a command to a specific peer (called by remote page) */
    sendCommand(command: RemoteCommand) {
        this.send({ type: "command:exec", senderId: this.peerId, timestamp: Date.now(), command });
    }

    /** Acknowledge a command (called by host pages) */
    ackCommand(action: string, success: boolean, error?: string) {
        this.send({ type: "command:ack", senderId: this.peerId, timestamp: Date.now(), commandAction: action, success, error });
    }

    /**
     * Send a WebRTC signaling payload (offer/answer/ICE) to a specific peer.
     * Not throttled — signaling is low-volume and time-sensitive.
     */
    sendSignal(targetPeerId: string, payload: unknown) {
        this.send({
            type: "webrtc:signal",
            senderId: this.peerId,
            timestamp: Date.now(),
            targetPeerId,
            payload,
        });
    }

    /** Subscribe to messages */
    onMessage(handler: MessageHandler): () => void {
        this.handlers.add(handler);
        return () => { this.handlers.delete(handler); };
    }

    /** Destroy the engine and announce departure */
    destroy() {
        this._destroyed = true;
        // Announce departure via both channels
        const bye: SyncMessage = { type: "peer:bye", senderId: this.peerId, timestamp: Date.now() };
        try { this.channel?.postMessage(bye); } catch { /* */ }
        this.doServerPost(bye);

        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        if (this.sseRetryTimer) clearTimeout(this.sseRetryTimer);
        if (this.pendingServerSend) clearTimeout(this.pendingServerSend);
        this.handlers.clear();
        this._peers.clear();
        try { this.channel?.close(); } catch { /* */ }
        try { this.eventSource?.close(); } catch { /* */ }
        this.eventSource = null;
    }
}
