/**
 * Empty-state panels shown when the user can't see library data:
 *  - <NotSignedIn />   — no Auth.js session
 *  - <NoCompanion />   — signed in but no localhost companion linked
 *
 * Designed to be inert-friendly: pages still render their chrome, but
 * the main content slot displays one of these centered cards.
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Laptop, LogIn, Music } from "lucide-react";

export function NotSignedIn({ feature = "your library" }: { feature?: string }) {
    return (
        <div className="flex h-full min-h-[60vh] w-full items-center justify-center p-6">
            <Card className="max-w-md text-center">
                <CardHeader>
                    <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <Music className="h-6 w-6" />
                    </div>
                    <CardTitle>Sign in to see {feature}</CardTitle>
                    <CardDescription>
                        Tracks, playlists, and scans are stored per user. Sign in to access {feature}.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Button asChild>
                        <Link href="/login"><LogIn className="mr-2 h-4 w-4" /> Sign in</Link>
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}

export function NoCompanion({ feature = "your library" }: { feature?: string }) {
    return (
        <div className="flex h-full min-h-[60vh] w-full items-center justify-center p-6">
            <Card className="max-w-md text-center">
                <CardHeader>
                    <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <Laptop className="h-6 w-6" />
                    </div>
                    <CardTitle>Connect a companion to see {feature}</CardTitle>
                    <CardDescription>
                        {feature} now lives on your local companion app. Install it and pair it with this account to get going.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                    <Button asChild>
                        <Link href="/devices"><Laptop className="mr-2 h-4 w-4" /> Manage devices</Link>
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
