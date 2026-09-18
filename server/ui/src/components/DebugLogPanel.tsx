import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Switch, useToast } from "@mmo/ui";
import { Check, Copy, Eraser, RefreshCw } from "lucide-react";
import { useT } from "../i18n";
import { errorMessage, ipc } from "../lib/ipc";

const AUTO_REFRESH_MS = 3000;

/**
 * Debug log panel — snapshot of main's in-memory ring + environment.
 * Legacy behaviour kept: Refresh / Copy (loads first if empty) / Clear.
 * Auto-refresh (opt-in) keeps the panel live while the user is watching it.
 */
export function DebugLogPanel() {
    const t = useT();
    const toast = useToast();
    const [text, setText] = useState<string>("");
    const [hint, setHint] = useState<string>(t("debug.empty"));
    const [copied, setCopied] = useState(false);
    const [auto, setAuto] = useState(false);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async (): Promise<string> => {
        setLoading(true);
        try {
            const r = await ipc().getDebugLog();
            const env = r.env ?? ({} as Partial<typeof r.env>);
            const lines = r.lines ?? [];
            const header =
                `# MixAI Companion debug snapshot\n` +
                `# app=${env.appVersion} electron=${env.electron} node=${env.node}\n` +
                `# platform=${env.platform}/${env.arch} uptime=${env.uptimeSec}s rss=${env.rssMB}MB\n` +
                `# log file: ${r.logFile}\n` +
                `# ${lines.length} log lines (most recent first)\n\n`;
            const body = lines.slice().reverse().join("\n");
            const next = header + body;
            setText(next);
            return next;
        } catch (err) {
            setText("");
            setHint(`${t("debug.failed")}: ${errorMessage(err)}`);
            return "";
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        if (!auto) return;
        void load();
        const id = window.setInterval(() => void load(), AUTO_REFRESH_MS);
        return () => window.clearInterval(id);
    }, [auto, load]);

    async function copy() {
        const content = text || (await load());
        if (!content) return;
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch (err) {
            toast.add({ type: "error", title: t("debug.copyFailed"), description: errorMessage(err) });
        }
    }

    async function clear() {
        try {
            await ipc().clearDebugLog();
            setText("");
            setHint(t("debug.cleared"));
        } catch (err) {
            toast.add({ type: "error", title: t("debug.clearFailed"), description: errorMessage(err) });
        }
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <CardTitle className="text-sm">{t("debug.title")}</CardTitle>
                        <CardDescription className="text-xs">{t("debug.hint")}</CardDescription>
                    </div>
                    <div className="flex items-center gap-1">
                        <Button variant="outline" size="xs" onClick={() => void load()} disabled={loading}>
                            <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
                            {t("debug.refresh")}
                        </Button>
                        <Button variant="outline" size="xs" onClick={copy}>
                            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                            {copied ? t("debug.copied") : t("debug.copy")}
                        </Button>
                        <Button variant="outline" size="xs" onClick={clear}>
                            <Eraser className="size-3.5" aria-hidden />
                            {t("debug.clear")}
                        </Button>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                    <Label htmlFor="debug-auto" className="text-xs text-muted-foreground">
                        {t("debug.autoRefresh")}
                    </Label>
                    <Switch id="debug-auto" size="sm" checked={auto} onCheckedChange={(v) => setAuto(v)} />
                </div>
                {text ? (
                    <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre">
                        {text}
                    </pre>
                ) : (
                    <p className="text-xs italic text-muted-foreground">{hint}</p>
                )}
            </CardContent>
        </Card>
    );
}
