"use client";

import Link from "@/components/host/host-context";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, CloudUpload, Lock, LogOut, Plus, Server, Users, Wifi, WifiOff } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@mmo/ui";
import { linkGuestServer } from "@/actions/guest-server";
import { isGuestConnection } from "@/lib/mmo/guest-server";
import { connectionKey, useMmo } from "./mmo-provider";
import { ProfileAvatar } from "./profile-avatar";

/** Hub status dot + active profile avatar → menu (switch profile / manage / servers, D59). */
export function ProfileMenu() {
    const t = useTranslations("mx.shell");
    const { profile, clients, server, servers, guest, signedIn, selectServer, forgetGuest, hubStatus, devices, profileChanged } = useMmo();
    const [linking, setLinking] = useState(false);
    const others = devices.filter((d) => !d.guest).length;
    const serverName = server?.name || "MMO Server";
    const statusLabel = t(`hub.${hubStatus}`, { server: serverName });
    const addToAccount = async () => {
        if (!server || linking) return;
        setLinking(true);
        const r = await linkGuestServer({ baseUrl: server.baseUrl, token: server.token, name: server.name }).catch(() => null);
        setLinking(false);
        if (r?.ok) {
            toast.success(t("profile.addedToAccount", { server: serverName }));
            forgetGuest(server.baseUrl);
            location.reload();
        } else toast.error(t("profile.addFailed", { server: serverName }));
    };
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
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{t("profile.servers")}</DropdownMenuLabel>
                        {servers.map((s) => {
                            const active = server ? connectionKey(s) === connectionKey(server) : false;
                            return (
                                <DropdownMenuItem key={connectionKey(s)} onClick={() => { if (!active) selectServer(connectionKey(s)); }} aria-current={active ? "true" : undefined}>
                                    {active ? <Check aria-hidden className="size-4" /> : <Server aria-hidden className="size-4" />} {s.name || s.baseUrl}
                                </DropdownMenuItem>
                            );
                        })}
                        <DropdownMenuItem render={<Link href="/connect" />}>
                            <Plus aria-hidden className="size-4" /> {t("profile.addServer")}
                        </DropdownMenuItem>
                        {guest && server && signedIn ? (
                            <DropdownMenuItem onClick={() => void addToAccount()} disabled={linking || !server.baseUrl.startsWith("https://")}>
                                <CloudUpload aria-hidden className="size-4" /> {t("profile.addToAccount", { server: serverName })}
                            </DropdownMenuItem>
                        ) : null}
                        {guest && server && isGuestConnection(server) ? (
                            <DropdownMenuItem onClick={() => forgetGuest(server.baseUrl)}>
                                <LogOut aria-hidden className="size-4" /> {t("profile.disconnect", { server: serverName })}
                            </DropdownMenuItem>
                        ) : null}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
        </div>
    );
}
