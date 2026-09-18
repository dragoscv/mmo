import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { mixaiHost, type Session } from "../lib/config";
import { t } from "../i18n/messages";
import {
    requestDeviceCode, pollDeviceToken, pickReachableCompanion, DeviceAuthError,
    type DeviceCode, type Companion,
} from "../lib/device-auth";

interface Props {
    /** Called on 200: session + the reachable companion (or null → caller falls back to Discover). */
    onSignedIn: (session: Session, companion: { companion: Companion; baseUrl: string } | null) => void;
    onBack: () => void;
}

type State =
    | { kind: "requesting" }
    | { kind: "waiting"; code: DeviceCode }
    | { kind: "connecting"; session: Session; companions: Companion[] }
    | { kind: "expired" }
    | { kind: "denied" }
    | { kind: "error"; message: string };

export function SignInScreen({ onSignedIn, onBack }: Props) {
    const [state, setState] = useState<State>({ kind: "requesting" });
    const [now, setNow] = useState(Date.now());
    const [attempt, setAttempt] = useState(0);
    const canvas = useRef<HTMLCanvasElement>(null);
    const primaryBtn = useRef<HTMLButtonElement>(null);
    const host = mixaiHost();

    // 1. Request a device code.
    useEffect(() => {
        let alive = true;
        setState({ kind: "requesting" });
        requestDeviceCode()
            .then((code) => { if (alive) setState({ kind: "waiting", code }); })
            .catch((e: unknown) => {
                if (!alive) return;
                const message = e instanceof DeviceAuthError || e instanceof Error ? e.message : String(e);
                setState({ kind: "error", message });
            });
        return () => { alive = false; };
    }, [attempt]);

    // 2. QR + countdown + poll at `interval` (+5 s on slow_down).
    useEffect(() => {
        if (state.kind !== "waiting") return;
        const { code } = state;
        if (canvas.current) {
            QRCode.toCanvas(canvas.current, code.verificationUriComplete, { width: 320, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
                .catch(() => { /* QR is a convenience; the code still works */ });
        }
        const tick = setInterval(() => setNow(Date.now()), 1000);
        let stopped = false;
        let interval = code.intervalMs;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            if (stopped) return;
            if (Date.now() >= code.expiresAt) { stopped = true; setState({ kind: "expired" }); return; }
            try {
                const r = await pollDeviceToken(code.deviceCode);
                if (stopped) return;
                switch (r.status) {
                    case "ok": stopped = true; setState({ kind: "connecting", session: r.session, companions: r.companions }); return;
                    case "expired": stopped = true; setState({ kind: "expired" }); return;
                    case "access_denied": stopped = true; setState({ kind: "denied" }); return;
                    case "slow_down": interval += 5000; break;
                    case "pending": break;
                }
            } catch (e) {
                // A hard error (404/5xx) means the endpoint is gone — surface it instead of spinning forever.
                if (e instanceof DeviceAuthError && e.status !== 0) { stopped = true; setState({ kind: "error", message: e.message }); return; }
                /* transient network error — keep polling */
            }
            if (!stopped) timer = setTimeout(poll, interval);
        };
        timer = setTimeout(poll, interval);
        return () => { stopped = true; clearTimeout(timer); clearInterval(tick); };
    }, [state]);

    // 3. Probe companions (lanUrl then apiUrl, 2 s each) and hand over.
    useEffect(() => {
        if (state.kind !== "connecting") return;
        let alive = true;
        void pickReachableCompanion(state.companions).then((picked) => { if (alive) onSignedIn(state.session, picked); });
        return () => { alive = false; };
    }, [state, onSignedIn]);

    useEffect(() => { const t = setTimeout(() => primaryBtn.current?.focus(), 60); return () => clearTimeout(t); }, [state.kind]);

    const remaining = state.kind === "waiting" ? Math.max(0, Math.floor((state.code.expiresAt - now) / 1000)) : 0;
    const mm = String(Math.floor(remaining / 60));
    const ss = String(remaining % 60).padStart(2, "0");
    const retry = state.kind === "expired" || state.kind === "error" || state.kind === "denied";

    return (
        <div className="screen">
            <h1 className="screen-title">{t("signin.title")}</h1>
            <p className="screen-sub">{t("signin.sub", { host })}</p>
            {state.kind === "requesting" && <div className="spinner">{t("signin.requesting", { host })}</div>}
            {state.kind === "connecting" && (
                <div className="spinner" data-testid="signin-connecting">
                    {t("signin.connecting", { name: state.session.user.name ?? t("signin.user") })}
                </div>
            )}
            {state.kind === "error" && <div className="status error" data-testid="signin-error">{state.message}</div>}
            {state.kind === "expired" && <div className="status error">{t("common.codeExpired")}</div>}
            {state.kind === "denied" && <div className="status error">{t("signin.denied")}</div>}
            {state.kind === "waiting" && (
                <div className="pair">
                    <div className="pair-left">
                        <div className="pair-label">{t("signin.yourCode")}</div>
                        <div className="pair-code user-code" data-testid="user-code">
                            {state.code.userCode.split("").map((c, i) => <span key={i} className={c === "-" ? "dash" : undefined}>{c}</span>)}
                        </div>
                        <div className="pair-countdown">{t("common.expiresIn", { time: `${mm}:${ss}` })}</div>
                        <div className="pair-hint">{t("signin.waiting")}</div>
                    </div>
                    <div className="pair-right">
                        <canvas ref={canvas} className="pair-qr" width={320} height={320} data-testid="signin-qr" />
                        <div className="pair-hint">{t("common.scanQr")}</div>
                    </div>
                </div>
            )}
            <div className="discover-actions">
                {retry && (
                    <button ref={primaryBtn} className="btn" data-focusable data-testid="signin-retry" onClick={() => setAttempt((a) => a + 1)}>
                        {state.kind === "expired" ? t("common.newCode") : t("common.retry")}
                    </button>
                )}
                <button ref={retry ? undefined : primaryBtn} className="btn secondary" data-focusable data-testid="signin-back" onClick={onBack}>{t("common.back")}</button>
            </div>
        </div>
    );
}
