import { Separator } from "@mmo/ui";
import { useT } from "../i18n";
import { VirtualDevices } from "../components/VirtualDevices";
import { PhysicalDevices } from "../components/PhysicalDevices";

/**
 * Audio Setup — reachable pre- and post-auth (the user may configure routing
 * before signing in). Driver probe/install/uninstall, virtual device CRUD,
 * physical device authorisation and the live latency widget.
 */
export function VirtualAudioView() {
    const t = useT();
    return (
        <div className="p-4">
            <div className="mx-auto flex max-w-[var(--content-sm)] flex-col gap-4">
                <header>
                    <h1 className="text-base font-semibold">{t("va.title")}</h1>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t("va.intro")}</p>
                </header>

                <VirtualDevices />
                <PhysicalDevices />

                <Separator />
                <p className="text-[10px] leading-relaxed text-muted-foreground">{t("drivers.note")}</p>
            </div>
        </div>
    );
}
