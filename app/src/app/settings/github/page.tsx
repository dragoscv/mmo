import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/auth";
import { db } from "@/db";
import { userOauthTokens } from "@/db/schema-projects-normalized";
import { and, eq } from "drizzle-orm";
import { Check, ExternalLink } from "lucide-react";

function GithubMark({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
            <path d="M12 .5A11.5 11.5 0 0 0 .5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.55v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.74 1.27 3.41.97.1-.76.41-1.27.74-1.56-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.42.36.79 1.07.79 2.17v3.21c0 .3.21.66.8.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z" />
        </svg>
    );
}
const Github = GithubMark;

/**
 * GitHub connection page.
 *
 * Lets a signed-in (Google) user link their GitHub account so that
 * `createSnapshot()` can mirror project history to a private
 * `<github-login>/mmo-projects` repo. The OAuth token is stored
 * encrypted in `user_oauth_tokens` by the Auth.js linkAccount event.
 */
export default async function GithubSettingsPage() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login");

    const row = await db
        .select({ login: userOauthTokens.login, scope: userOauthTokens.scope })
        .from(userOauthTokens)
        .where(and(eq(userOauthTokens.userId, session.user.id), eq(userOauthTokens.provider, "github")))
        .limit(1);
    const linked = row.length > 0;
    const login = row[0]?.login ?? null;

    async function link() {
        "use server";
        await signIn("github", { redirectTo: "/settings/github" });
    }

    async function unlink() {
        "use server";
        const s = await auth();
        if (!s?.user?.id) return;
        await db
            .delete(userOauthTokens)
            .where(and(eq(userOauthTokens.userId, s.user.id), eq(userOauthTokens.provider, "github")));
        // Note: we keep the user's Google session; only the GitHub link is removed.
    }

    return (
        <main className="mx-auto max-w-2xl px-4 py-12">
            <h1 className="text-2xl font-semibold mb-2 flex items-center gap-3">
                <Github className="h-6 w-6" />
                GitHub
            </h1>
            <p className="text-white/60 text-sm mb-8">
                Connect your GitHub account to mirror project snapshots into a private
                <code className="mx-1 px-1.5 py-0.5 bg-white/5 rounded text-xs">mmo-projects</code>
                repository. Every snapshot becomes a commit; you keep full version history
                even if you sign out.
            </p>

            {linked ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 flex items-start gap-3">
                    <Check className="h-5 w-5 text-emerald-400 mt-0.5" />
                    <div className="flex-1">
                        <div className="text-emerald-100 font-medium">
                            Connected as <span className="font-mono">{login ?? "(unknown login)"}</span>
                        </div>
                        <div className="text-emerald-300/70 text-xs mt-1">
                            New snapshots will be pushed to{" "}
                            <a
                                href={`https://github.com/${login}/mmo-projects`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline inline-flex items-center gap-1"
                            >
                                {login}/mmo-projects <ExternalLink className="h-3 w-3" />
                            </a>
                            .
                        </div>
                        <form action={unlink} className="mt-3">
                            <button
                                type="submit"
                                className="text-xs px-3 py-1.5 rounded border border-white/15 hover:border-white/30 text-white/70"
                            >
                                Disconnect
                            </button>
                        </form>
                    </div>
                </div>
            ) : (
                <form action={link}>
                    <button
                        type="submit"
                        className="flex items-center gap-2 px-4 py-2.5 rounded-md bg-white text-black font-medium hover:bg-white/90"
                    >
                        <Github className="h-4 w-4" />
                        Connect GitHub
                    </button>
                    <p className="text-xs text-white/40 mt-3">
                        We request the <code>repo</code> scope so we can create your private
                        snapshot repo. You can revoke access any time in{" "}
                        <a
                            href="https://github.com/settings/applications"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline"
                        >
                            GitHub settings
                        </a>
                        .
                    </p>
                </form>
            )}
        </main>
    );
}
