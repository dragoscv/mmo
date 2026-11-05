"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Lock, Users, Wifi, WifiOff } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@mmo/ui";
import { useMmo } from "./mmo-provider";
import { ProfileAvatar } from "./profile-avatar";

/** Hub status dot + active profile avatar → menu (switch / manage). */
export function ProfileMenu() {
    const t = useTranslations("mx.shell");
    const { profile, clients, server, hubStatus, devices, profileChanged } = useMmo();
    const others = devices.filter((d) => !d.guest).length;
    const serverName = server?.name || "MMO Server";
    const statusLabel = t(`hub.${hubStatus}`, { server: serverName });
    return (
        <div className="mx-topbar-end">
            <span className="mx-hub" data-status={hubStatus} title={statusLabel}>
                {hubStatus === "connected" ? <Wifi aria-hidden className="size-4" /> : <WifiOff aria-hidden className="size-4" />}
                <span className="sr-only">{statusLabel}</span>
            </span>
            {profile ? (
                <DropdownMenu>
                    <DropdownMenuTrigger className="mx-profile-btn" aria-label={t("profile.menu", { name: profile.name })}>
                        <ProfileAvatar profile={profile} size={32} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuLabel>
                            {profile.name}
                            {profile.kind === "kid" ? ` · ${t("profile.kid")}` : ""}
                            {profile.hasPin ? <Lock aria-hidden className="ml-1 inline size-3" /> : null}
                        </DropdownMenuLabel>
                        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                            {statusLabel} · {t("hub.devices", { count: Math.max(0, others - 1) })}
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => { clients?.profiles.signOut(); profileChanged(); }}>
                            <Users aria-hidden className="size-4" /> {t("profile.switch")}
                        </DropdownMenuItem>
                        <DropdownMenuItem render={<Link href="/profiles" />}>{t("profile.manage")}</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
        </div>
    );
}
