/**
 * Empty-state panels shown when the user can't see library data:
 *  - <NotSignedIn />   — no Auth.js session
 *  - <NoCompanion />   — signed in but no localhost companion linked
 *
 * The component itself is purely presentational: parents resolve the
 * translated strings (via `getTranslations` from next-intl/server) and
 * pass them in as props. This keeps the component sync, jsdom-test-
 * friendly, and free of next-intl provider plumbing in tests.
 *
 * Backwards-compat: callers can still pass a raw `feature` string and
 * the component will fall back to the original English copy.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Laptop, LockKeyhole } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import { SignInButton } from "@/components/sign-in-button";

interface CommonProps {
    /** Pre-translated feature label, e.g. "your dashboard" / "tabloul tău". */
    feature?: string;
    /** Optional pre-translated overrides; defaults to English fallbacks. */
    title?: string;
    description?: string;
    ctaLabel?: string;
    /** Decorative content behind the card (see `EmptyState.backdrop`). */
    backdrop?: ReactNode;
}

export function NotSignedIn({
    feature = "your library",
    title,
    description,
    ctaLabel,
    backdrop,
}: CommonProps) {
    return (
        <EmptyState
            icon={<LockKeyhole aria-hidden />}
            title={title ?? `Sign in to see ${feature}`}
            description={description ?? `Tracks, playlists, and scans are stored per user. Sign in to access ${feature}.`}
            actions={<SignInButton label={ctaLabel ?? "Sign in"} />}
            backdrop={backdrop}
        />
    );
}

export function NoCompanion({
    feature = "your library",
    title,
    description,
    ctaLabel,
}: CommonProps) {
    return (
        <EmptyState
            icon={<Laptop aria-hidden />}
            title={title ?? `Connect a companion to see ${feature}`}
            description={description ?? `${feature} now lives on your local companion app. Install it and pair it with this account to get going.`}
            actions={
                <Button render={<Link href="/devices" />}>
                    <Laptop aria-hidden /> {ctaLabel ?? "Manage devices"}
                </Button>
            }
        />
    );
}
