import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@mmo/ui";
import { Button } from "@mmo/ui";
import { useT } from "@/i18n";

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
}

/**
 * Root error boundary. A UI crash must never take the audio engine down with
 * it — the Rust core keeps running, so we offer a plain UI reload.
 */
export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error("[mixai] UI crashed", error, info.componentStack);
    }

    render() {
        if (this.state.error) return <CrashScreen error={this.state.error} />;
        return this.props.children;
    }
}

function CrashScreen({ error }: { error: Error }) {
    const t = useT();
    return (
        <div className="grid h-full place-items-center p-6">
            <ErrorState
                title={t("error.title")}
                detail={
                    <>
                        {t("error.detail")}
                        <span className="mono mt-2 block text-xs opacity-70">{error.message}</span>
                    </>
                }
                actions={
                    <Button onClick={() => window.location.reload()}>{t("error.reload")}</Button>
                }
            />
        </div>
    );
}
