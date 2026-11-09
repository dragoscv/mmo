import { useState } from "react";
import { Check, CopyPlus, Download, Pencil, Save, Trash, Upload } from "lucide-react";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogAction,
    Badge,
    Button,
    Input,
} from "@mmo/ui";
import { cn } from "@mmo/ui";
import { useT } from "@/i18n";
import { ProfileSection } from "../sections/ProfileSection";
import { Section } from "../sections/shared";
import { useProfilesStore } from "../profiles-store";
import { isEmptyProfile, isSeed, type SettingsProfile } from "../profiles-core";
import { ProfileGlyph } from "../profile-icons";
import { startImport, useFileDialogs } from "../SettingsFileDialogs";
import { useUndoStore } from "../undo-store";

function ProfileCard({ p, active }: { p: SettingsProfile; active: boolean }) {
    const t = useT();
    const store = useProfilesStore();
    const setStatus = useUndoStore((s) => s.setStatus);
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(p.name);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const empty = isEmptyProfile(p);

    const switchTo = async () => {
        const ok = await store.switchTo(p.id, t("settings.undoProfile", { name: p.name }));
        setStatus(ok ? t("settings.profileSwitched", { name: p.name }) : t("settings.profileEmpty"));
    };
    const saveCurrent = async () => {
        await store.saveCurrent(p.id);
        setStatus(t("settings.profileSaved", { name: p.name }));
    };
    const commitRename = () => {
        store.rename(p.id, name);
        setEditing(false);
    };

    return (
        <li className={cn("grid gap-3 rounded-lg border p-3", active ? "border-primary bg-primary/5" : "border-border bg-card")}>
            <div className="flex items-center gap-2">
                <ProfileGlyph icon={p.icon} className="size-4 text-muted-foreground" />
                {editing ? (
                    <Input
                        size="sm"
                        autoFocus
                        aria-label={t("settings.profileRename")}
                        value={name}
                        maxLength={40}
                        onChange={(e) => setName(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") {
                                e.stopPropagation();
                                setName(p.name);
                                setEditing(false);
                            }
                        }}
                        className="h-7 flex-1"
                    />
                ) : (
                    <span className="flex-1 truncate font-medium">{p.name}</span>
                )}
                {active && (
                    <Badge>
                        <Check aria-hidden /> {t("settings.active")}
                    </Badge>
                )}
                {empty && !active && <Badge variant="secondary">{t("settings.profileEmptyBadge")}</Badge>}
            </div>
            <div className="flex flex-wrap gap-1.5">
                {empty ? (
                    <Button size="sm" onClick={() => void saveCurrent()}>
                        <Save aria-hidden /> {t("settings.profileSaveCurrent")}
                    </Button>
                ) : (
                    <>
                        <Button size="sm" variant={active ? "secondary" : "default"} onClick={() => void switchTo()}>
                            {t("settings.profileSwitch")}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void saveCurrent()}>
                            <Save aria-hidden /> {t("settings.profileOverwrite")}
                        </Button>
                    </>
                )}
                <Button size="icon-sm" variant="ghost" aria-label={`${t("settings.profileRename")} · ${p.name}`} onClick={() => setEditing(true)}>
                    <Pencil aria-hidden />
                </Button>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`${t("settings.profileDuplicate")} · ${p.name}`}
                    onClick={() => store.duplicate(p.id, t("settings.profileCopyName", { name: p.name }))}
                >
                    <CopyPlus aria-hidden />
                </Button>
                {!isSeed(p.id) && (
                    <Button size="icon-sm" variant="ghost" aria-label={`${t("settings.remove")} · ${p.name}`} onClick={() => setConfirmDelete(true)}>
                        <Trash aria-hidden />
                    </Button>
                )}
            </div>
            <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
                <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t("settings.profileDeleteTitle", { name: p.name })}</AlertDialogTitle>
                        <AlertDialogDescription>{t("settings.profileDeleteBody")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => store.remove(p.id)}>
                            {t("settings.remove")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </li>
    );
}

export function ProfilesTab() {
    const t = useT();
    const profiles = useProfilesStore((s) => s.profiles);
    const active = useProfilesStore((s) => s.active);
    const setExportOpen = useFileDialogs((s) => s.setExportOpen);
    const setStatus = useUndoStore((s) => s.setStatus);

    return (
        <div className="grid gap-6">
            <Section title={t("settings.profilesTitle")} settingId="profiles.list">
                <p className="text-xs text-muted-foreground">{t("settings.profilesHint")}</p>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                    {profiles.map((p) => (
                        <ProfileCard key={p.id} p={p} active={p.id === active} />
                    ))}
                </ul>
            </Section>
            <Section title={t("settings.fileTitle")} settingId="profiles.file">
                <p className="text-xs text-muted-foreground">{t("settings.fileHint")}</p>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
                        <Download aria-hidden /> {t("settings.export")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void startImport(() => setStatus(t("settings.importInvalid")))}>
                        <Upload aria-hidden /> {t("settings.import")}
                    </Button>
                </div>
            </Section>
            <Section title={t("settings.profile")} settingId="profiles.backup">
                <ProfileSection />
            </Section>
        </div>
    );
}
