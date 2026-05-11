"use client";

import { useState } from "react";
import { signOutAndPurge } from "@/lib/auth-client";
import { useRenderCount } from "@/lib/dev-debugger";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import {
    User,
    Mail,
    Calendar,
    Shield,
    LogOut,
    Trash2,
    Loader2,
    Database,
    RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { resetUserPreferences, deleteUserAccount } from "@/actions/user-preferences";
import { clearSyncableLocalStorage, SYNCABLE_KEY_PREFIXES, SYNCABLE_KEYS } from "@/lib/syncable-keys";

interface ProfileClientProps {
    user: {
        id?: string;
        name?: string | null;
        email?: string | null;
        image?: string | null;
    };
}

export function ProfileClient({ user }: ProfileClientProps) {
    useRenderCount("Page:/profile");
    const [resetting, setResetting] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [resetDialogOpen, setResetDialogOpen] = useState(false);

    const initials = user.name
        ?.split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2) || "U";

    async function handleReset() {
        setResetting(true);
        try {
            const result = await resetUserPreferences();
            if (result.success) {
                clearSyncableLocalStorage();
                toast.success("All preferences reset to defaults. Reload the page to apply.");
                setResetDialogOpen(false);
            } else {
                toast.error("Failed to reset preferences");
            }
        } catch {
            toast.error("An error occurred while resetting preferences");
        } finally {
            setResetting(false);
        }
    }

    async function handleDeleteAccount() {
        setDeleting(true);
        try {
            const result = await deleteUserAccount();
            if (result.success) {
                toast.success("Account deleted");
                await signOutAndPurge({ callbackUrl: "/" });
            } else {
                toast.error("Failed to delete account");
            }
        } catch {
            toast.error("An error occurred while deleting account");
        } finally {
            setDeleting(false);
        }
    }

    return (
        <div className="max-w-2xl space-y-6">
            {/* Profile Card */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <User className="h-4 w-4 text-purple-400" />
                        Account Information
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex items-start gap-5">
                        {/* Avatar */}
                        <div className="shrink-0">
                            {user.image ? (
                                // eslint-disable-next-line @next/next/no-img-element -- dynamic blob/data/remote artwork; next/image cannot optimise unknown remotes
                                <img
                                    src={user.image}
                                    alt={user.name || "User"}
                                    className="h-20 w-20 rounded-2xl ring-2 ring-border shadow-lg"
                                    referrerPolicy="no-referrer"
                                />
                            ) : (
                                <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-purple-500/20 text-2xl font-bold text-purple-300 ring-2 ring-border">
                                    {initials}
                                </div>
                            )}
                        </div>

                        {/* Info */}
                        <div className="flex-1 space-y-3">
                            <div>
                                <h2 className="text-xl font-semibold">{user.name || "Unknown"}</h2>
                                <p className="text-sm text-muted-foreground">
                                    Signed in with Google
                                </p>
                            </div>

                            <div className="space-y-2">
                                <div className="flex items-center gap-2 text-sm">
                                    <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-muted-foreground">{user.email}</span>
                                </div>
                                <div className="flex items-center gap-2 text-sm">
                                    <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-muted-foreground">Google OAuth 2.0</span>
                                </div>
                                {user.id && (
                                    <div className="flex items-center gap-2 text-sm">
                                        <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                                        <span className="text-muted-foreground font-mono text-xs">
                                            ID: {user.id.slice(0, 8)}...
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Preferences */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Database className="h-4 w-4 text-blue-400" />
                        Synced Preferences
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                        Your UI state — window/panel layouts, mixer & EQ settings, FX chains, MIDI mapping,
                        theme, sidebar, DAW projects layout, and every other per-app preference — is
                        automatically synced to your <strong>active profile</strong> in the database when
                        signed in. Manage profiles (create, switch, import, export) from
                        <a href="/settings" className="underline ml-1">Settings → Profiles</a>.
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                        {SYNCABLE_KEY_PREFIXES.map((p) => (
                            <span
                                key={p}
                                className="inline-flex items-center rounded-md bg-purple-500/10 text-purple-300 px-2 py-1 text-xs font-mono"
                            >
                                {p}*
                            </span>
                        ))}
                        {SYNCABLE_KEYS.map((key) => (
                            <span
                                key={key}
                                className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-mono text-muted-foreground"
                            >
                                {key}
                            </span>
                        ))}
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setResetDialogOpen(true)}
                        className="gap-2"
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Reset All Preferences to Defaults
                    </Button>
                </CardContent>
            </Card>

            {/* Actions */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <Button
                        variant="outline"
                        className="w-full gap-2 justify-start"
                        onClick={() => signOutAndPurge({ callbackUrl: "/" })}
                    >
                        <LogOut className="h-4 w-4" />
                        Sign Out
                    </Button>

                    <Button
                        variant="destructive"
                        className="w-full gap-2 justify-start"
                        onClick={() => setDeleteDialogOpen(true)}
                    >
                        <Trash2 className="h-4 w-4" />
                        Delete Account
                    </Button>
                </CardContent>
            </Card>

            {/* Reset Confirmation Dialog */}
            <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Reset All Preferences?</DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                        This will clear all your saved UI preferences (theme, personalization, DAW settings, etc.)
                        and restore them to their default values. This action cannot be undone.
                    </p>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setResetDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleReset}
                            disabled={resetting}
                        >
                            {resetting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Reset Preferences
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete Account Confirmation Dialog */}
            <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Delete Account?</DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                        This will permanently delete your account and all associated data (preferences, sessions).
                        Your music library and tracks will not be affected. This action cannot be undone.
                    </p>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleDeleteAccount}
                            disabled={deleting}
                        >
                            {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Delete My Account
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
