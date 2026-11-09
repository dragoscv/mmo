import { Suspense, lazy } from "react";
import { SkeletonText } from "@mmo/ui";
import { useT } from "@/i18n";
import { Section } from "../sections/shared";

// Plugin manager pulls in the macro builder — load it only when the tab renders.
const PluginManager = lazy(() => import("@/plugins/host").then((m) => ({ default: m.PluginManager })));

export function PluginsTab() {
    const t = useT();
    return (
        <div className="grid gap-6">
            <Section title={t("settings.plugins")} settingId="plugins.manager">
                <Suspense fallback={<SkeletonText lines={3} />}>
                    <PluginManager />
                </Suspense>
            </Section>
        </div>
    );
}
