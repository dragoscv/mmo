"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { BellOff, ServerOff } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton } from "@mmo/ui";
import { toast } from "sonner";
import { usePushSubscription } from "@/hooks/use-push-subscription";

type BadgeVariant = "default" | "secondary" | "outline" | "destructive" | "success" | "warning" | "info";

const BADGE: Record<string, BadgeVariant> = {
    loading: "secondary",
    unsupported: "secondary",
    "no-vapid": "warning",
    denied: "destructive",
    subscribed: "success",
    unsubscribed: "outline",
};

export function NotificationsSettingsPanel() {
    const t = useTranslations("settings.notifications");
    const { state, subscribe, unsubscribe } = usePushSubscription();
    const [pending, start] = useTransition();
    const status = state.status;

    const onToggle = () => {
        start(async () => {
            const ok = status === "subscribed" ? await unsubscribe() : await subscribe();
            if (ok) toast.success(status === "subscribed" ? t("push.unsubscribed") : t("push.subscribed"));
            else toast.error(t("push.failed"));
        });
    };

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        {t("push.title")}
                        <Badge variant={BADGE[status] ?? "secondary"}>{t(`push.status.${status}`)}</Badge>
                    </CardTitle>
                    <CardDescription>{t("push.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {status === "loading" ? (
                        <Skeleton className="h-10 w-full" />
                    ) : status === "no-vapid" ? (
                        <EmptyState
                            variant="inline"
                            tone="warning"
                            icon={<ServerOff aria-hidden />}
                            title={t("push.noVapidTitle")}
                            description={t("push.noVapidBody", { env: "NEXT_PUBLIC_VAPID_PUBLIC_KEY" })}
                        />
                    ) : status === "unsupported" ? (
                        <EmptyState variant="inline" icon={<BellOff aria-hidden />} title={t("push.unsupportedTitle")} description={t("push.unsupportedBody")} />
                    ) : (
                        <>
                            <p className="text-sm text-muted-foreground">{t(`push.explain.${status}`)}</p>
                            {status === "subscribed" ? (
                                <p className="truncate font-mono text-xs text-muted-foreground" title={state.endpoint}>{state.endpoint}</p>
                            ) : null}
                            <Button
                                variant={status === "subscribed" ? "outline" : "default"}
                                loading={pending}
                                disabled={status === "denied"}
                                onClick={onToggle}
                            >
                                {status === "subscribed" ? t("push.unsubscribe") : t("push.subscribe")}
                            </Button>
                        </>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
