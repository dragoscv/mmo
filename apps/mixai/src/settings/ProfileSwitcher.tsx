/**
 * Compact quick switch for settings profiles (title bar). Switching applies
 * the profile directly (undo available in the settings modal footer).
 */
import { ChevronDown, Settings2 } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    cn,
} from "@mmo/ui";
import { useT } from "@/i18n";
import { useUiStore } from "@/state/ui-store";
import { useProfilesStore } from "./profiles-store";
import { isEmptyProfile } from "./profiles-core";
import { ProfileGlyph } from "./profile-icons";
import { useUndoStore } from "./undo-store";

export interface ProfileSwitcherProps {
    className?: string;
}

export function ProfileSwitcher({ className }: ProfileSwitcherProps) {
    const t = useT();
    const profiles = useProfilesStore((s) => s.profiles);
    const active = useProfilesStore((s) => s.active);
    const switchTo = useProfilesStore((s) => s.switchTo);
    const setStatus = useUndoStore((s) => s.setStatus);
    const current = profiles.find((p) => p.id === active);

    const onPick = async (id: string) => {
        const p = profiles.find((x) => x.id === id);
        if (!p) return;
        if (isEmptyProfile(p)) {
            useUiStore.getState().openSettings("profiles");
            return;
        }
        const ok = await switchTo(id, t("settings.undoProfile", { name: p.name }));
        if (ok) setStatus(t("settings.profileSwitched", { name: p.name }));
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button variant="ghost" size="sm" className={cn("gap-1.5", className)} aria-label={t("settings.profileSwitcher", { name: current?.name ?? t("settings.profileNone") })} />
                }
            >
                {current ? <ProfileGlyph icon={current.icon} className="size-4" /> : null}
                <span className="max-w-28 truncate">{current?.name ?? t("settings.profileNone")}</span>
                <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuRadioGroup value={active ?? ""} onValueChange={(v) => void onPick(String(v))}>
                    {profiles.map((p) => (
                        <DropdownMenuRadioItem key={p.id} value={p.id}>
                            <ProfileGlyph icon={p.icon} className="size-4" />
                            <span className="flex-1 truncate">{p.name}</span>
                            {isEmptyProfile(p) && <span className="text-xs text-muted-foreground">{t("settings.profileEmptyBadge")}</span>}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => useUiStore.getState().openSettings("profiles")}>
                    <Settings2 className="size-4" aria-hidden /> {t("settings.profileManage")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
