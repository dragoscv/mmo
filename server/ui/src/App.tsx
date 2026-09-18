import { useEffect, useRef, useState } from "react";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@mmo/ui";
import { ArrowLeft, AudioLines } from "lucide-react";
import { useT } from "./i18n";
import { isMac } from "./lib/ipc";
import { hideSplash } from "./lib/splash";
import { useStatus } from "./lib/use-status";
import { AuthView } from "./views/AuthView";
import { MainView } from "./views/MainView";
import { VirtualAudioView } from "./views/VirtualAudioView";
import { TitleBar } from "./components/TitleBar";

type Route = "home" | "virtual-audio";

export function App() {
    const t = useT();
    const { status, refresh, invalidatedReason } = useStatus();
    const [route, setRoute] = useState<Route>("home");
    const splashHidden = useRef(false);

    // Hide the splash as soon as we know which view to show. Also hides it if
    // the first status call failed, so the user never stares at a spinner.
    useEffect(() => {
        if (splashHidden.current) return;
        if (status !== null) {
            splashHidden.current = true;
            hideSplash();
            return;
        }
        const fallback = window.setTimeout(() => {
            if (!splashHidden.current) {
                splashHidden.current = true;
                hideSplash();
            }
        }, 4000);
        return () => window.clearTimeout(fallback);
    }, [status]);

    const authenticated = status?.authenticated ?? false;

    return (
        <div className="flex h-full flex-col bg-background text-foreground">
            {isMac && <TitleBar />}

            {/* Toolbar: app name + Audio Setup / Back */}
            <header className="flex h-11 shrink-0 items-center justify-between border-b px-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-heading font-semibold text-foreground">
                        Mix<span className="text-brand-accent">AI</span> Companion
                    </span>
                    <span aria-hidden>·</span>
                    <span>{t("app.server")}</span>
                </div>
                {route === "home" ? (
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button variant="ghost" size="sm" onClick={() => setRoute("virtual-audio")}>
                                    <AudioLines className="size-4" aria-hidden />
                                    {t("nav.audioSetup")}
                                </Button>
                            }
                        />
                        <TooltipContent side="bottom">{t("nav.audioSetup.tooltip")}</TooltipContent>
                    </Tooltip>
                ) : (
                    <Button variant="ghost" size="sm" onClick={() => setRoute("home")}>
                        <ArrowLeft className="size-4" aria-hidden />
                        {t("nav.back")}
                    </Button>
                )}
            </header>

            <main className="min-h-0 flex-1 overflow-y-auto">
                {route === "virtual-audio" ? (
                    <VirtualAudioView />
                ) : authenticated && status ? (
                    <MainView status={status} onStatusRefresh={refresh} />
                ) : (
                    <AuthView onAuthenticated={refresh} invalidatedReason={invalidatedReason} />
                )}
            </main>
        </div>
    );
}
