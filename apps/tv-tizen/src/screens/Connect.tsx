import { useEffect, useRef, useState, type FormEvent } from "react";
import { normalizeBaseUrl, type ServerConfig } from "../lib/config";
import { MmoClient, ApiError } from "../lib/api";
import type { DiscoveredServer } from "../lib/discovery";
import { t } from "../i18n/messages";

interface Props {
    initial: ServerConfig | null;
    onConnected: (cfg: ServerConfig) => void;
    /** Quick Connect: the host answered `/health` → caller pushes the Pair screen. */
    onQuickConnect: (server: DiscoveredServer) => void;
}

function toServer(baseUrl: string): DiscoveredServer {
    const m = /^https?:\/\/([^/:]+)(?::(\d+))?/i.exec(baseUrl);
    return { baseUrl, host: m?.[1] ?? baseUrl, port: m?.[2] ? Number(m[2]) : 17899, info: null };
}

export function ConnectScreen({ initial, onConnected, onQuickConnect }: Props) {
    const [host, setHost] = useState(initial?.baseUrl ?? "");
    const [token, setToken] = useState(initial?.token ?? "");
    const [userId, setUserId] = useState(initial?.userId ?? "");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; text: string }>({ kind: "idle", text: "" });
    const hostRef = useRef<HTMLInputElement>(null);

    useEffect(() => { hostRef.current?.focus(); }, []);

    /** Normalise + `/health`; returns the base URL or null (status already set). */
    const checkHost = async (): Promise<string | null> => {
        const baseUrl = normalizeBaseUrl(host);
        if (!baseUrl) { setStatus({ kind: "error", text: t("connect.errHost") }); return null; }
        setBusy(true);
        setStatus({ kind: "idle", text: t("connect.checking", { url: baseUrl }) });
        const alive = await MmoClient.health(baseUrl);
        if (!alive) {
            setBusy(false);
            setStatus({ kind: "error", text: t("connect.errUnreachable", { url: baseUrl }) });
            return null;
        }
        return baseUrl;
    };

    const quickConnect = async () => {
        const baseUrl = await checkHost();
        if (!baseUrl) return;
        setBusy(false);
        onQuickConnect(toServer(baseUrl));
    };

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (busy) return;
        // No token → pair with a code instead of erroring.
        if (!token.trim()) { await quickConnect(); return; }
        const baseUrl = await checkHost();
        if (!baseUrl) return;
        const cfg: ServerConfig = { baseUrl, token: token.trim(), userId: userId.trim() };
        try {
            await new MmoClient(cfg).checkAuth();
        } catch (err) {
            setBusy(false);
            const msg = err instanceof ApiError && err.status === 401 ? t("connect.errToken") : t("common.error", { message: (err as Error).message });
            setStatus({ kind: "error", text: msg });
            return;
        }
        setStatus({ kind: "ok", text: t("connect.ok") });
        setBusy(false);
        onConnected(cfg);
    };

    return (
        <div className="screen">
            <form className="connect" onSubmit={submit}>
                <h1 className="screen-title">{t("connect.title")}</h1>
                <p className="screen-sub">{t("connect.sub")}</p>
                <div className="field">
                    <label htmlFor="host">{t("connect.host")}</label>
                    <input id="host" ref={hostRef} data-focusable value={host} onChange={(e) => setHost(e.target.value)}
                        placeholder="192.168.100.61" autoComplete="off" inputMode="url" />
                </div>
                <div className="field">
                    <label htmlFor="token">{t("connect.token")}</label>
                    <input id="token" data-focusable value={token} onChange={(e) => setToken(e.target.value)}
                        placeholder={t("connect.tokenPlaceholder")} autoComplete="off" />
                </div>
                <div className="field">
                    <label htmlFor="user">{t("connect.user")}</label>
                    <input id="user" data-focusable value={userId} onChange={(e) => setUserId(e.target.value)}
                        placeholder={t("connect.userPlaceholder")} autoComplete="off" />
                </div>
                <div className="btn-row">
                    <button type="submit" className="btn" data-focusable disabled={busy} data-testid="connect-submit">
                        {busy ? t("connect.submitting") : t("connect.submit")}
                    </button>
                    <button type="button" className="btn secondary" data-focusable disabled={busy} data-testid="connect-quick" onClick={() => void quickConnect()}>
                        {t("connect.quick")}
                    </button>
                </div>
                <div className={`status ${status.kind === "idle" ? "" : status.kind}`}>{status.text}</div>
            </form>
        </div>
    );
}
