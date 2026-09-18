import { useEffect, useRef } from "react";
import { t } from "../i18n/messages";

interface Props {
    onSignIn: () => void;
    onLocal: () => void;
}

/** First-run onboarding: MixAI account (recommended) or a server on this network. */
export function WelcomeScreen({ onSignIn, onLocal }: Props) {
    const first = useRef<HTMLButtonElement>(null);
    useEffect(() => { const t = setTimeout(() => first.current?.focus(), 60); return () => clearTimeout(t); }, []);

    return (
        <div className="screen">
            <h1 className="screen-title">{t("welcome.title")}</h1>
            <p className="screen-sub">{t("welcome.sub")}</p>
            <div className="discover-grid" data-testid="welcome-options">
                <button ref={first} className="server-card welcome-card" data-focusable data-testid="welcome-signin" onClick={onSignIn}>
                    <div className="server-icon">👤</div>
                    <div className="server-name">{t("welcome.signin.title")}</div>
                    <div className="server-sub">{t("welcome.signin.sub")}</div>
                    <div className="server-tag">{t("welcome.recommended")}</div>
                </button>
                <button className="server-card welcome-card" data-focusable data-testid="welcome-local" onClick={onLocal}>
                    <div className="server-icon">🖥</div>
                    <div className="server-name">{t("welcome.local.title")}</div>
                    <div className="server-sub">{t("welcome.local.sub")}</div>
                </button>
            </div>
        </div>
    );
}
