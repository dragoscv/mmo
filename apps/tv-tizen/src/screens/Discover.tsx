import { useEffect, useRef, useState } from "react";
import { sweep, localNetwork, scanHostsOverride, fetchPairInfo, type DiscoveredServer } from "../lib/discovery";
import { focusFirst } from "../lib/focus";
import { t } from "../i18n/messages";

interface Props {
    /** Previously saved server whose health check failed — shown first, preselected. */
    preselected: DiscoveredServer | null;
    onSelect: (s: DiscoveredServer) => void;
    onManual: () => void;
}

export function DiscoverScreen({ preselected, onSelect, onManual }: Props) {
    const [servers, setServers] = useState<DiscoveredServer[]>(preselected ? [preselected] : []);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [scanning, setScanning] = useState(true);
    const [round, setRound] = useState(0);
    const firstCard = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const ctl = new AbortController();
        setScanning(true);
        setProgress(null);
        const add = (s: DiscoveredServer) =>
            setServers((cur) => (cur.some((x) => x.baseUrl === s.baseUrl) ? cur.map((x) => (x.baseUrl === s.baseUrl ? { ...x, info: s.info ?? x.info } : x)) : [...cur, s]));
        if (preselected && !preselected.info) {
            void fetchPairInfo(preselected.baseUrl).then((info) => { if (info) add({ ...preselected, info }); });
        }
        void sweep({ signal: ctl.signal, onFound: add, onProgress: (done, total) => setProgress({ done, total }) })
            .finally(() => { if (!ctl.signal.aborted) setScanning(false); });
        return () => ctl.abort();
    }, [round, preselected]);

    // Focus: preselected/first card as soon as it exists, else the manual button.
    useEffect(() => {
        const t = setTimeout(() => {
            if (document.activeElement && document.activeElement !== document.body) return;
            if (firstCard.current) firstCard.current.focus(); else focusFirst();
        }, 60);
        return () => clearTimeout(t);
    }, [servers.length, scanning]);

    const net = localNetwork();
    const override = scanHostsOverride();
    const scope = override ? override.join(", ") : net ? `${net.ip} /24` : t("discover.localNetwork");

    return (
        <div className="screen">
            <h1 className="screen-title">{t("discover.title")}</h1>
            <p className="screen-sub">
                {scanning
                    ? `${t("discover.scanning", { scope })}${progress ? ` ${progress.done}/${progress.total}` : ""}`
                    : servers.length
                        ? t("discover.pick")
                        : t("discover.none")}
            </p>
            <div className="discover-grid" data-testid="discover-grid">
                {servers.map((s, i) => (
                    <button
                        key={s.baseUrl}
                        ref={i === 0 ? firstCard : undefined}
                        className={`server-card${s === preselected ? " preselected" : ""}`}
                        data-focusable
                        data-testid="server-card"
                        onClick={() => onSelect(s)}
                    >
                        <div className="server-icon">🖥</div>
                        <div className="server-name">{s.info?.name ?? s.host}</div>
                        <div className="server-sub">{s.baseUrl}{s.info?.version ? ` · v${s.info.version}` : ""}</div>
                        {s === preselected && <div className="server-tag">{t("discover.savedBefore")}</div>}
                        {s.info && !s.info.hasToken && <div className="server-tag warn">{t("discover.uninitialized")}</div>}
                    </button>
                ))}
                {scanning && servers.length === 0 && <div className="spinner">{t("discover.spinner")}</div>}
            </div>
            <div className="discover-actions">
                <button className="btn secondary" data-focusable onClick={() => setRound((r) => r + 1)} disabled={scanning}>
                    {t("discover.again")}
                </button>
                <button className="btn secondary" data-focusable data-testid="manual-btn" onClick={onManual}>
                    {t("discover.manual")}
                </button>
            </div>
        </div>
    );
}
