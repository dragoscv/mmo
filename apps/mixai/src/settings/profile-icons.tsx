import { House, Radio, Speaker, User } from "lucide-react";
import type { ProfileIcon } from "./profiles-core";

export function ProfileGlyph({ icon, className }: { icon: ProfileIcon; className?: string }) {
    const Icon = icon === "home" ? House : icon === "club" ? Speaker : icon === "streaming" ? Radio : User;
    return <Icon className={className} aria-hidden />;
}
