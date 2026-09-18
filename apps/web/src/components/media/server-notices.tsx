import { AlertTriangle } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { ServerError } from "@/lib/media/aggregate";

/** Non-blocking inline notice per failing server ("<name> nu răspunde"). Server component. */
export async function ServerNotices({ errors }: { errors: ServerError[] }) {
    if (errors.length === 0) return null;
    const t = await getTranslations("home.servers");
    return (
        <div className="flex flex-col gap-2" data-slot="server-notices" aria-live="polite">
            {errors.map((e) => (
            <p key={e.serverId} className="media-notice">
                    <AlertTriangle className="size-4 shrink-0" aria-hidden />
                    <span>
                        {e.error === "outdated"
                            ? t("outdated", { name: e.name })
                            : e.error === "offline"
                                ? t("offlineNotice", { name: e.name })
                                : t("unreachable", { name: e.name })}
                    </span>
                </p>
            ))}
        </div>
    );
}
