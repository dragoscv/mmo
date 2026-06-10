/**
 * WebRTCAudioBridge — Bidirectional low-latency audio between this peer
 * and a single remote peer, using WebRTC (Opus over RTP/SRTP, P2P).
 *
 * Why WebRTC?
 *   - Sub-50ms one-way latency over LAN, ~100ms over WAN.
 *   - Native Opus codec (6-510 kbps, 20 ms framing, FEC, DTX).
 *   - True peer-to-peer once ICE completes (no server relay for audio).
 *   - Browser-native (no extra runtime).
 *
 * Signaling (offer/answer/ICE) is done out-of-band via injected callback —
 * we reuse the existing RemoteSyncEngine's SSE + POST channel for that.
 *
 * App-agnostic: any consumer can pass a local output MediaStream
 * (e.g. tapped from a master AudioContext via MediaStreamAudioDestinationNode)
 * and/or capture mic input. Incoming track is exposed via callback so the
 * consumer can route it back into its own audio graph.
 *
 * Stable initiator pattern: the peer with the lexicographically smaller
 * peerId always creates the initial offer. This avoids "offer collision"
 * (glare) without needing perfect-negotiation polling.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type StreamQuality = "ultra" | "high" | "balanced" | "low";

export interface QualityProfile {
    label: string;
    description: string;
    /** Target Opus bitrate in bits/sec (set via sender.setParameters AND SDP munge). */
    bitrate: number;
    /** Stereo (2) or mono (1). Mono halves bandwidth, fine for voice. */
    channels: 1 | 2;
    /** Discontinuous transmission — saves bandwidth during silence. */
    dtx: boolean;
    /** Forward error correction — recovers lost packets at cost of ~20% bitrate. */
    fec: boolean;
    /** Opus frame duration in ms (lower = lower latency, higher CPU). */
    ptime: number;
}

export const QUALITY_PROFILES: Record<StreamQuality, QualityProfile> = {
    ultra: {
        label: "Ultra",
        description: "320 kbps stereo · studio quality",
        bitrate: 320_000, channels: 2, dtx: false, fec: true, ptime: 10,
    },
    high: {
        label: "High",
        description: "192 kbps stereo · music streaming",
        bitrate: 192_000, channels: 2, dtx: false, fec: true, ptime: 20,
    },
    balanced: {
        label: "Balanced",
        description: "96 kbps stereo · default",
        bitrate: 96_000, channels: 2, dtx: true, fec: true, ptime: 20,
    },
    low: {
        label: "Low",
        description: "32 kbps mono · weak network",
        bitrate: 32_000, channels: 1, dtx: true, fec: true, ptime: 40,
    },
};

export type WebRTCSignal =
    | { type: "offer"; sdp: string }
    | { type: "answer"; sdp: string }
    | { type: "ice"; candidate: RTCIceCandidateInit }
    | { type: "quality"; quality: StreamQuality }
    | { type: "close" };

export type ConnectionState =
    | "idle" | "connecting" | "connected" | "failed" | "disconnected";

export interface BridgeStats {
    rttMs: number;
    bytesSentPerSec: number;
    bytesReceivedPerSec: number;
    packetsLost: number;
    jitterMs: number;
    audioLevelOut: number; // 0..1
    audioLevelIn: number;  // 0..1
    /** RTCPeerConnection.iceConnectionState — useful for debugging stuck "connecting" */
    iceState: RTCIceConnectionState | "n/a";
    /** RTCPeerConnection.signalingState — "stable" once SDP exchange is done */
    signalingState: RTCSignalingState | "n/a";
    /** This peer's role in negotiation */
    role: "initiator" | "responder";
}

export interface WebRTCAudioBridgeOptions {
    /** This peer's stable ID (used for initiator election). */
    selfPeerId: string;
    /** ID of the peer we're connecting to. */
    targetPeerId: string;
    /** Send signal messages out-of-band (relay through your existing channel). */
    sendSignal: (signal: WebRTCSignal) => void;
    /** Called whenever connection state, stats, quality, or track presence changes. */
    onStateChange?: () => void;
    /** Called when a remote track arrives (or null when it ends). */
    onRemoteStream?: (stream: MediaStream | null) => void;
    /** STUN servers (default = Google public STUN). */
    iceServers?: RTCIceServer[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
];

// ─── Bridge ──────────────────────────────────────────────────────────────────

export class WebRTCAudioBridge {
    private opts: Required<Omit<WebRTCAudioBridgeOptions, "onStateChange" | "onRemoteStream">> & {
        onStateChange?: () => void;
        onRemoteStream?: (stream: MediaStream | null) => void;
    };

    private pc: RTCPeerConnection | null = null;
    private outputSender: RTCRtpSender | null = null;
    private micSender: RTCRtpSender | null = null;
    private localOutputTrack: MediaStreamTrack | null = null;
    private localMicTrack: MediaStreamTrack | null = null;
    private localMicStream: MediaStream | null = null;
    private remoteStream: MediaStream | null = null;

    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private negotiating = false;
    private pendingIce: RTCIceCandidateInit[] = [];
    private destroyed = false;

    // Public observable state
    connectionState: ConnectionState = "idle";
    quality: StreamQuality = "balanced";
    isSendingOutput = false;
    isSendingMic = false;
    isReceivingRemote = false;
    stats: BridgeStats = {
        rttMs: 0, bytesSentPerSec: 0, bytesReceivedPerSec: 0,
        packetsLost: 0, jitterMs: 0, audioLevelOut: 0, audioLevelIn: 0,
        iceState: "n/a", signalingState: "n/a", role: "responder",
    };

    constructor(options: WebRTCAudioBridgeOptions) {
        this.opts = {
            selfPeerId: options.selfPeerId,
            targetPeerId: options.targetPeerId,
            sendSignal: options.sendSignal,
            iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS,
            onStateChange: options.onStateChange,
            onRemoteStream: options.onRemoteStream,
        };
    }

    /** True if this peer should create the initial offer (deterministic election). */
    get isInitiator(): boolean {
        return this.opts.selfPeerId < this.opts.targetPeerId;
    }

    /** Replace the ICE server list. If a connection is already open, applies on next reopen. */
    setIceServers(iceServers: RTCIceServer[]) {
        this.opts.iceServers = iceServers;
        // Hot-update an existing PC if possible (Chrome/Firefox support this)
        if (this.pc) {
            try { this.pc.setConfiguration({ iceServers, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" }); }
            catch { /* older browsers — will pick up on next open() */ }
        }
    }

    private notify() { this.opts.onStateChange?.(); }

    private setState(s: ConnectionState) {
        if (this.connectionState === s) return;
        this.connectionState = s;
        this.notify();
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Create the peer connection. Idempotent — re-uses existing if alive.
     * If isInitiator is true, immediately attempts negotiation.
     */
    async open() {
        if (this.destroyed) return;
        if (this.pc) return;

        this.setState("connecting");
        this.pc = new RTCPeerConnection({
            iceServers: this.opts.iceServers,
            // Tighter bundling = fewer ICE candidates, faster connect
            bundlePolicy: "max-bundle",
            rtcpMuxPolicy: "require",
        });

        // Pre-create transceivers so the offer/answer is symmetric and adding
        // tracks later doesn't require renegotiation. m-line 0 = our output,
        // m-line 1 = our mic. Both start sendrecv so peer can also send.
        const outputTx = this.pc.addTransceiver("audio", { direction: "sendrecv" });
        const micTx = this.pc.addTransceiver("audio", { direction: "sendrecv" });
        this.outputSender = outputTx.sender;
        this.micSender = micTx.sender;

        this.pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.opts.sendSignal({ type: "ice", candidate: e.candidate.toJSON() });
            }
        };

        this.pc.ontrack = (e) => {
            const tag = `[WebRTC ${this.opts.selfPeerId.slice(0, 6)}←${this.opts.targetPeerId.slice(0, 6)}]`;
            console.info(tag, "ontrack", { kind: e.track.kind, id: e.track.id.slice(0, 8), readyState: e.track.readyState, muted: e.track.muted, transceiverMid: e.transceiver.mid, dir: e.transceiver.currentDirection });
            // Single shared remoteStream — collect all incoming tracks
            if (!this.remoteStream) this.remoteStream = new MediaStream();
            this.remoteStream.addTrack(e.track);

            // Watch unmute (real media flowing) so UI "Listening" only flips when audio actually arrives
            e.track.onunmute = () => { console.info(tag, "track unmuted", e.track.id.slice(0, 8)); this.notify(); };
            e.track.onmute = () => { console.info(tag, "track muted", e.track.id.slice(0, 8)); this.notify(); };

            // Watch for track ending
            e.track.onended = () => {
                console.info(tag, "track ended", e.track.id.slice(0, 8));
                if (this.remoteStream && this.remoteStream.getTracks().every(t => t.readyState === "ended")) {
                    this.remoteStream = null;
                    this.isReceivingRemote = false;
                    this.opts.onRemoteStream?.(null);
                    this.notify();
                }
            };

            this.isReceivingRemote = true;
            this.opts.onRemoteStream?.(this.remoteStream);
            this.notify();
        };

        this.pc.onconnectionstatechange = () => {
            const s = this.pc?.connectionState;
            console.info(`[WebRTC ${this.opts.selfPeerId.slice(0, 6)}→${this.opts.targetPeerId.slice(0, 6)}] connectionState=${s}`);
            if (s === "connected") this.setState("connected");
            else if (s === "failed") this.setState("failed");
            else if (s === "disconnected") this.setState("disconnected");
            else if (s === "closed") this.setState("idle");
        };

        this.pc.oniceconnectionstatechange = () => {
            const s = this.pc?.iceConnectionState ?? "n/a";
            this.stats.iceState = s;
            console.info(`[WebRTC ${this.opts.selfPeerId.slice(0, 6)}→${this.opts.targetPeerId.slice(0, 6)}] iceConnectionState=${s}`);
            // ICE failures should bubble up as "failed" too — connectionState lags in some browsers
            if (s === "failed") this.setState("failed");
            this.notify();
        };

        this.pc.onsignalingstatechange = () => {
            this.stats.signalingState = this.pc?.signalingState ?? "n/a";
            this.notify();
        };

        this.stats.role = this.isInitiator ? "initiator" : "responder";

        this.pc.onnegotiationneeded = async () => {
            if (!this.isInitiator) return; // answerer waits for offer
            await this.negotiate();
        };

        if (this.isInitiator) {
            await this.negotiate();
        }

        this.startStatsPolling();
    }

    private async negotiate() {
        if (!this.pc || this.negotiating) return;
        this.negotiating = true;
        try {
            const offer = await this.pc.createOffer();
            // Apply quality profile via SDP munging (Opus fmtp parameters)
            offer.sdp = this.mungeOpusSdp(offer.sdp ?? "", QUALITY_PROFILES[this.quality]);
            await this.pc.setLocalDescription(offer);
            console.info(`[WebRTC ${this.opts.selfPeerId.slice(0, 6)}→${this.opts.targetPeerId.slice(0, 6)}] sending offer`);
            this.opts.sendSignal({ type: "offer", sdp: offer.sdp ?? "" });
        } catch (e) {
            console.warn("[WebRTC] negotiate failed", e);
        } finally {
            this.negotiating = false;
        }
    }

    /**
     * Handle an incoming signal from the peer.
     * Drains pending ICE candidates after remote description is set.
     */
    async handleSignal(signal: WebRTCSignal) {
        if (this.destroyed) return;
        if (!this.pc) await this.open();
        if (!this.pc) return;

        try {
            switch (signal.type) {
                case "offer": {
                    console.info(`[WebRTC ${this.opts.selfPeerId.slice(0, 6)}←${this.opts.targetPeerId.slice(0, 6)}] received offer`);
                    await this.pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
                    await this.drainPendingIce();
                    const answer = await this.pc.createAnswer();
                    answer.sdp = this.mungeOpusSdp(answer.sdp ?? "", QUALITY_PROFILES[this.quality]);
                    await this.pc.setLocalDescription(answer);
                    console.info(`[WebRTC ${this.opts.selfPeerId.slice(0, 6)}→${this.opts.targetPeerId.slice(0, 6)}] sending answer`);
                    this.opts.sendSignal({ type: "answer", sdp: answer.sdp ?? "" });
                    break;
                }
                case "answer": {
                    console.info(`[WebRTC ${this.opts.selfPeerId.slice(0, 6)}←${this.opts.targetPeerId.slice(0, 6)}] received answer`);
                    await this.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
                    await this.drainPendingIce();
                    break;
                }
                case "ice": {
                    if (!this.pc.remoteDescription) {
                        this.pendingIce.push(signal.candidate);
                    } else {
                        try { await this.pc.addIceCandidate(signal.candidate); }
                        catch { /* benign — late candidate */ }
                    }
                    break;
                }
                case "close": {
                    this.close();
                    break;
                }
                case "quality": {
                    // Peer requested quality change — if we're initiator, apply and renegotiate.
                    console.info(`[WebRTC ${this.opts.selfPeerId.slice(0, 6)}←${this.opts.targetPeerId.slice(0, 6)}] quality request: ${signal.quality}`);
                    if (this.quality !== signal.quality) {
                        this.quality = signal.quality;
                        this.notify();
                        if (this.isInitiator) await this.negotiate();
                    }
                    break;
                }
            }
        } catch (e) {
            console.warn("[WebRTC] handleSignal error", e);
        }
    }

    private async drainPendingIce() {
        if (!this.pc) return;
        const pending = this.pendingIce.splice(0);
        for (const c of pending) {
            try { await this.pc.addIceCandidate(c); } catch { /* benign */ }
        }
    }

    /** Close the connection and notify peer (best effort). */
    close() {
        if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
        try { this.opts.sendSignal({ type: "close" }); } catch { /* noop */ }
        this.stopMic();
        try { this.pc?.close(); } catch { /* noop */ }
        this.pc = null;
        this.outputSender = null;
        this.micSender = null;
        this.localOutputTrack = null;
        this.remoteStream = null;
        this.isReceivingRemote = false;
        this.isSendingOutput = false;
        this.isSendingMic = false;
        this.pendingIce = [];
        this.setState("idle");
        this.opts.onRemoteStream?.(null);
    }

    destroy() {
        this.destroyed = true;
        this.close();
    }

    // ── Quality control ──────────────────────────────────────────────────────

    async setQuality(q: StreamQuality) {
        if (q === this.quality) return;
        this.quality = q;
        this.notify();

        const profile = QUALITY_PROFILES[q];
        // Apply via setParameters() — works without renegotiation
        for (const sender of [this.outputSender, this.micSender]) {
            if (!sender) continue;
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = profile.bitrate;
            try { await sender.setParameters(params); } catch { /* noop */ }
        }

        // Renegotiate so SDP-only options (channels, DTX, FEC, ptime) take effect.
        // If we're the initiator, do it directly. Otherwise ping the initiator
        // to renegotiate on our behalf.
        if (this.pc) {
            if (this.isInitiator) {
                await this.negotiate();
            } else {
                this.opts.sendSignal({ type: "quality", quality: q });
            }
        }
    }

    // ── Local output (engine master tap) ─────────────────────────────────────

    /**
     * Set the audio track sent as our "output" (typically the engine's master).
     * Pass null to stop sending.
     */
    async setLocalOutput(stream: MediaStream | null) {
        if (!this.outputSender) {
            // Stash on opening
            this.localOutputTrack = stream?.getAudioTracks()[0] ?? null;
            this.isSendingOutput = !!this.localOutputTrack;
            this.notify();
            return;
        }
        const track = stream?.getAudioTracks()[0] ?? null;
        await this.outputSender.replaceTrack(track);
        this.localOutputTrack = track;
        this.isSendingOutput = !!track;
        this.notify();
    }

    // ── Local mic (this peer acts as a mic for the other) ────────────────────

    async startMic(deviceId?: string): Promise<boolean> {
        if (!this.micSender) return false;
        try {
            const constraints: MediaStreamConstraints = {
                audio: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: QUALITY_PROFILES[this.quality].channels,
                    sampleRate: 48000,
                } as MediaTrackConstraints,
                video: false,
            };
            this.localMicStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.localMicTrack = this.localMicStream.getAudioTracks()[0];
            await this.micSender.replaceTrack(this.localMicTrack);
            this.isSendingMic = true;
            this.notify();
            return true;
        } catch (e) {
            console.warn("[WebRTC] startMic failed", e);
            return false;
        }
    }

    async stopMic() {
        if (this.localMicTrack) {
            this.localMicTrack.stop();
            this.localMicTrack = null;
        }
        if (this.localMicStream) {
            this.localMicStream.getTracks().forEach(t => t.stop());
            this.localMicStream = null;
        }
        if (this.micSender) {
            try { await this.micSender.replaceTrack(null); } catch { /* noop */ }
        }
        this.isSendingMic = false;
        this.notify();
    }

    // ── Stats polling ────────────────────────────────────────────────────────

    private startStatsPolling() {
        if (this.statsTimer) return;
        let lastBytesSent = 0;
        let lastBytesReceived = 0;
        let lastTs = 0;

        this.statsTimer = setInterval(async () => {
            if (!this.pc || this.connectionState !== "connected") return;
            try {
                const reports = await this.pc.getStats();
                let bytesSent = 0, bytesReceived = 0;
                let rtt = 0, jitter = 0, packetsLost = 0;
                let levelOut = 0, levelIn = 0;
                let nowTs = 0;

                reports.forEach((r) => {
                    // Any timestamp will do — we need *some* reference point even
                    // if this peer is receive-only (no outbound-rtp exists).
                    if (typeof r.timestamp === "number" && r.timestamp > nowTs) nowTs = r.timestamp;
                    if (r.type === "outbound-rtp" && (r as RTCOutboundRtpStreamStats).kind === "audio") {
                        const o = r as RTCOutboundRtpStreamStats;
                        bytesSent += o.bytesSent ?? 0;
                    } else if (r.type === "inbound-rtp" && (r as RTCInboundRtpStreamStats).kind === "audio") {
                        const i = r as RTCInboundRtpStreamStats;
                        bytesReceived += i.bytesReceived ?? 0;
                        jitter = Math.max(jitter, (i.jitter ?? 0) * 1000);
                        packetsLost += i.packetsLost ?? 0;
                        // audioLevel only present on inbound-rtp in some browsers
                        const lvl = (i as RTCInboundRtpStreamStats & { audioLevel?: number }).audioLevel;
                        if (typeof lvl === "number") levelIn = Math.max(levelIn, lvl);
                    } else if (r.type === "remote-inbound-rtp") {
                        // RTCRemoteInboundRtpStreamStats not in all TS DOM lib versions — use minimal shape
                        const ri = r as RTCRtpStreamStats & { roundTripTime?: number };
                        rtt = Math.max(rtt, (ri.roundTripTime ?? 0) * 1000);
                    } else if (r.type === "media-source") {
                        const ms = r as RTCRtpStreamStats & { audioLevel?: number };
                        if (typeof ms.audioLevel === "number") levelOut = Math.max(levelOut, ms.audioLevel);
                    }
                });

                const elapsedSec = lastTs > 0 ? (nowTs - lastTs) / 1000 : 0;
                const bps_sent = elapsedSec > 0 ? ((bytesSent - lastBytesSent) * 8) / elapsedSec : 0;
                const bps_recv = elapsedSec > 0 ? ((bytesReceived - lastBytesReceived) * 8) / elapsedSec : 0;
                lastBytesSent = bytesSent;
                lastBytesReceived = bytesReceived;
                lastTs = nowTs;

                this.stats = {
                    ...this.stats, // preserve iceState / signalingState / role written by event handlers
                    rttMs: Math.round(rtt),
                    bytesSentPerSec: Math.round(bps_sent),
                    bytesReceivedPerSec: Math.round(bps_recv),
                    packetsLost, jitterMs: Math.round(jitter),
                    audioLevelOut: levelOut, audioLevelIn: levelIn,
                };
                this.notify();
            } catch { /* noop */ }
        }, 1000);
    }

    // ── SDP munging (Opus tuning) ────────────────────────────────────────────

    /**
     * Inject Opus fmtp parameters and add b=AS bitrate caps for each audio m-line.
     * Browsers honor these and use them to shape the encoder.
     */
    private mungeOpusSdp(sdp: string, profile: QualityProfile): string {
        const lines = sdp.split(/\r?\n/);
        const out: string[] = [];
        let inAudio = false;
        let opusPt: string | null = null;
        let pendingBitrate = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith("m=")) {
                inAudio = line.startsWith("m=audio");
                opusPt = null;
                pendingBitrate = inAudio;
                out.push(line);
                continue;
            }

            // Insert b=AS bitrate cap right after c= line of an audio section
            if (pendingBitrate && line.startsWith("c=")) {
                out.push(line);
                out.push(`b=AS:${Math.round(profile.bitrate / 1000)}`);
                out.push(`b=TIAS:${profile.bitrate}`);
                pendingBitrate = false;
                continue;
            }

            // Find Opus payload type
            if (inAudio && line.startsWith("a=rtpmap:")) {
                const m = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line);
                if (m) opusPt = m[1];
            }

            // Replace fmtp line for Opus with our params
            if (inAudio && opusPt && line.startsWith(`a=fmtp:${opusPt}`)) {
                const fmtpParams = [
                    `minptime=10`,
                    `maxptime=${profile.ptime * 2}`,
                    `useinbandfec=${profile.fec ? 1 : 0}`,
                    `usedtx=${profile.dtx ? 1 : 0}`,
                    `stereo=${profile.channels === 2 ? 1 : 0}`,
                    `sprop-stereo=${profile.channels === 2 ? 1 : 0}`,
                    `maxaveragebitrate=${profile.bitrate}`,
                ].join(";");
                out.push(`a=fmtp:${opusPt} ${fmtpParams}`);
                continue;
            }

            out.push(line);
        }

        return out.join("\r\n");
    }
}
