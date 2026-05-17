"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    User, UserCircle, Library, Music, Clapperboard, Disc3, Piano, Waves, Mic,
    Monitor, Smartphone, Bell, Palette, Settings as SettingsIcon, ShieldCheck,
    type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Entry =
    | { kind: "link"; href: string; label: string; icon: LucideIcon; exact?: boolean }
    | { kind: "header"; label: string };

const sections: Entry[] = [
    { kind: "link", href: "/settings", label: "Overview", icon: SettingsIcon, exact: true },
    { kind: "header", label: "Cont" },
    { kind: "link", href: "/settings/account", label: "Cont & facturare", icon: User },
    { kind: "link", href: "/settings/profiles", label: "Profiluri vizionare", icon: UserCircle },
    { kind: "link", href: "/settings/security", label: "Securitate", icon: ShieldCheck },
    { kind: "header", label: "Bibliotecă" },
    { kind: "link", href: "/settings/library", label: "Bibliotecă (general)", icon: Library },
    { kind: "link", href: "/settings/music", label: "Music", icon: Music },
    { kind: "link", href: "/settings/video", label: "Video", icon: Clapperboard },
    { kind: "header", label: "Producție" },
    { kind: "link", href: "/settings/mixer", label: "Mixer", icon: Disc3 },
    { kind: "link", href: "/settings/daw", label: "DAW", icon: Piano },
    { kind: "link", href: "/settings/sound-editor", label: "Sound Editor", icon: Waves },
    { kind: "link", href: "/settings/live", label: "Live", icon: Mic },
    { kind: "header", label: "Dispozitive" },
    { kind: "link", href: "/settings/companions", label: "Companions", icon: Monitor },
    { kind: "link", href: "/settings/devices", label: "Devices & remote", icon: Smartphone },
    { kind: "header", label: "Sistem" },
    { kind: "link", href: "/settings/notifications", label: "Notificări", icon: Bell },
    { kind: "link", href: "/settings/appearance", label: "Aspect & limbă", icon: Palette },
    { kind: "link", href: "/settings/advanced", label: "Avansat", icon: SettingsIcon },
];

export function SettingsSidebar() {
    const pathname = usePathname();
    return (
        <aside className="hidden md:flex flex-col w-64 border-r border-border bg-background/40 p-3 gap-1 shrink-0">
            <h2 className="px-3 py-2 text-lg font-bold">Setări</h2>
            <nav className="flex flex-col gap-0.5">
                {sections.map((s, i) => {
                    if (s.kind === "header") {
                        return (
                            <div key={`h-${i}`} className="px-3 pt-3 pb-1 text-[.7rem] uppercase tracking-wider text-muted-foreground">
                                {s.label}
                            </div>
                        );
                    }
                    const active = s.exact ? pathname === s.href : pathname?.startsWith(s.href);
                    const Icon = s.icon;
                    return (
                        <Link
                            key={s.href}
                            href={s.href}
                            className={cn(
                                "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors",
                                active ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                            )}
                        >
                            <Icon className="h-4 w-4" />
                            {s.label}
                        </Link>
                    );
                })}
            </nav>
        </aside>
    );
}
