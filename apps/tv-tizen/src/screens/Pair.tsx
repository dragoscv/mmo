import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { DiscoveredServer } from "../lib/discovery";
import { requestPair, pollPair, POLL_INTERVAL_MS, type PairRequest } from "../lib/pair";
import type { ServerConfig } from "../lib/config";
import { t } from "../i18n/messages";

interface Props {
    server: DiscoveredServer;
    onPaired: (cfg: ServerConfig) => void;
    onBack: () => void;
}

type State =
    | { kind: "requesting" }
    | { kind: "waiting"; req: PairRequest }
    | { kind: "expired" }
    | { kind: "error"; message: string };

export function PairScreen({ server, onPaired, onBack }: Props) {
    const [state, setState] = useState<State>({ kind: "requesting" });
    const [now, setNow] = useState(Date.now());
    const [attempt, setAttempt] = useState(0);
    const canvas = useRef<HTMLCanvasElement>(null);
    const backBtn = useRef<HTMLButtonElement>(null);

    // 1. Request a code.
    useEffect(() => {
        let alive = true;
        setState({ kind: "requesting" });
        requestPair(server.baseUrl)
            .then((req) => { if (alive) setState({ kind: "waiting", req }); })
            .catch((e: Error) => { if (alive) setState({ kind: "error", message: e.message }); });
        return () => { alive = false; };
    }, [server.baseUrl, attempt]);

    // 2. QR + countdown + poll while waiting.
    useEffect(() => {
        if (state.kind !== "waiting") return;
        const { req } = state;
        if (canvas.current && req.approveUrl) {
            QRCode.toCanvas(canvas.current, req.approveUrl, { width: 320, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
                .catch(() => { /* QR is a convenience; the code still works */ });
        }
        const tick = setInterval(() => setNow(Date.now()), 1000);
        let stopped = false;
        const poll = async () => {
            if (stopped) return;
            try {
                const r = await pollPair(server.baseUrl, req.code, req.secret);
                if (stopped) return;
                if (r.status === "approved") {
                    stopped = true;
                    onPaired({ baseUrl: server.baseUrl, token: r.deviceToken, userId: r.userId ?? "" });
                    return;
                }
                if (r.status === "expired" || Date.now() >= req.expiresAt) { setState({ kind: "expired" }); stopped = true; return; }
            } catch { /* transient network error — keep polling */ }
            if (!stopped) timer = setTimeout(poll, POLL_INTERVAL_MS);
        };
        let timer = setTimeout(poll, POLL_INTERVAL_MS);
        return () => { stopped = true; clearTimeout(timer); clearInterval(tick); };
    }, [state, server.baseUrl, onPaired]);

    useEffect(() => { const t = setTimeout(() => backBtn.current?.focus(), 60); return () => clearTimeout(t); }, [state.kind]);

    const remaining = state.kind === "waiting" ? Math.max(0, Math.floor((state.req.expiresAt - now) / 1000)) : 0;
    const mm = String(Math.floor(remaining / 60)).padStart(1, "0");
    const ss = String(remaining % 60).padStart(2, "0");
    const name = server.info?.name ?? server.host;

    return (
        <div className="screen">
            <h1 className="screen-title">{t("pair.title", { name })}</h1>
            <p className="screen-sub">{server.baseUrl}</p>
            {state.kind === "requesting" && <div className="spinner">{t("pair.requesting")}</div>}
            {state.kind === "error" && <div className="status error">{t("common.error", { message: state.message })}</div>}
            {state.kind === "expired" && <div className="status error">{t("common.codeExpired")}</div>}
            {state.kind === "waiting" && (
                <div className="pair">
                    <div className="pair-left">
                        <div className="pair-label">{t("pair.label")}</div>
                        <div className="pair-code" data-testid="pair-code">{state.req.code.split("").map((c, i) => <span key={i}>{c}</span>)}</div>
                        <div className="pair-countdown">{t("common.expiresIn", { time: `${mm}:${ss}` })}</div>
                        <div className="pair-hint">{t("pair.waiting")}</div>
                    </div>
                    <div className="pair-right">
                        <canvas ref={canvas} className="pair-qr" width={320} height={320} data-testid="pair-qr" />
                        <div className="pair-hint">{t("common.scanQr")}</div>
                    </div>
                </div>
            )}
            <div className="discover-actions">
                {(state.kind === "expired" || state.kind === "error") && (
                    <button className="btn" data-focusable onClick={() => setAttempt((a) => a + 1)}>{t("common.newCode")}</button>
                )}
                <button ref={backBtn} className="btn secondary" data-focusable onClick={onBack}>{t("common.back")}</button>
            </div>
        </div>
    );
}
