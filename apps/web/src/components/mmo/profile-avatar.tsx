import type { Profile } from "@/lib/mmo/media-types";

/** Initial-letter avatar tinted by the profile colour (server stores a CSS colour or null → accent). */
export function ProfileAvatar({ profile, size = 40 }: { profile: Pick<Profile, "name" | "color" | "avatar">; size?: number }) {
    const letter = (profile.name.trim()[0] ?? "?").toUpperCase();
    const tint = profile.color && /^(#[0-9a-f]{3,8}|oklch\([^)]*\)|hsl\([^)]*\))$/i.test(profile.color) ? profile.color : "var(--primary)";
    return (
        <span
            aria-hidden
            className="mx-avatar"
            style={{ width: size, height: size, fontSize: size * 0.42, ["--mx-avatar" as string]: tint }}
        >
            {profile.avatar && /^\p{Extended_Pictographic}/u.test(profile.avatar) ? profile.avatar : letter}
        </span>
    );
}
