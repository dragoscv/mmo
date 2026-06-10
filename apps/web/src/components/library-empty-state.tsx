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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Laptop, LogIn, Music } from "lucide-react";

interface CommonProps {
    /** Pre-translated feature label, e.g. "your dashboard" / "tabloul tău". */
    feature?: string;
    /** Optional pre-translated overrides; defaults to English fallbacks. */
    title?: string;
    description?: string;
    ctaLabel?: string;
}

export function NotSignedIn({
    feature = "your library",
    title,
    description,
    ctaLabel,
}: CommonProps) {
    return (
        <div className="flex h-full min-h-[60vh] w-full items-center justify-center p-6">
            <Card className="max-w-md text-center">
                <CardHeader>
                    <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <Music className="h-6 w-6" />
                    </div>
                    <CardTitle>{title ?? `Sign in to see ${feature}`}</CardTitle>
                    <CardDescription>
                        {description ?? `Tracks, playlists, and scans are stored per user. Sign in to access ${feature}.`}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Button asChild>
                        <Link href="/login"><LogIn className="mr-2 h-4 w-4" /> {ctaLabel ?? "Sign in"}</Link>
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}

export function NoCompanion({
    feature = "your library",
    title,
    description,
    ctaLabel,
}: CommonProps) {
    return (
        <div className="flex h-full min-h-[60vh] w-full items-center justify-center p-6">
            <Card className="max-w-md text-center">
                <CardHeader>
                    <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <Laptop className="h-6 w-6" />
                    </div>
                    <CardTitle>{title ?? `Connect a companion to see ${feature}`}</CardTitle>
                    <CardDescription>
                        {description ?? `${feature} now lives on your local companion app. Install it and pair it with this account to get going.`}
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                    <Button asChild>
                        <Link href="/devices"><Laptop className="mr-2 h-4 w-4" /> {ctaLabel ?? "Manage devices"}</Link>
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
