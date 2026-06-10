/**
 * GitHub-backed project history (real impl).
 *
 * One mono-repo per user: `<github-login>/mmo-projects`. Each project
 * lives at `projects/{kind}/{externalId}/project.json`; assets land at
 * `assets/{sha256}.bin`. Every snapshot is a commit on `main`.
 *
 * Token acquisition: `getGithubConnection(userId)` reads the user's
 * row from `user_oauth_tokens` (provider="github") and decrypts the
 * access_token via `token-crypto.ts`. The token is provisioned by
 * Auth.js's `linkAccount` event in `auth.ts` whenever a signed-in user
 * links their GitHub account.
 */

import { Octokit } from "@octokit/rest";
import { db } from "@/db";
import { eq, and } from "drizzle-orm";
import { userOauthTokens } from "@/db/schema-projects-normalized";
import { decryptToken } from "@/lib/token-crypto";

const DEFAULT_REPO = "mmo-projects";

export interface GithubConnection {
    userId: string;
    login: string;
    octokit: Octokit;
}

export interface CommitSnapshotInput {
    userId: string;
    projectKind: string;
    projectExternalId: string;
    snapshotExternalId: string;
    label: string | null;
    document: Record<string, unknown>;
    /** map of sha256 → base64 bytes (small assets only; large assets use LFS — TODO) */
    assets?: Record<string, string>;
}

export async function getGithubConnection(userId: string): Promise<GithubConnection | null> {
    const rows = await db
        .select()
        .from(userOauthTokens)
        .where(and(eq(userOauthTokens.userId, userId), eq(userOauthTokens.provider, "github")))
        .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    if (!row.accessTokenEnc) return null;
    const token = await decryptToken(row.accessTokenEnc);
    const octokit = new Octokit({ auth: token });
    const login = row.login ?? (await octokit.users.getAuthenticated()).data.login;
    return { userId, login, octokit };
}

export async function ensureMonorepo(conn: GithubConnection): Promise<{ owner: string; repo: string }> {
    const owner = conn.login;
    const repo = DEFAULT_REPO;
    try {
        await conn.octokit.repos.get({ owner, repo });
    } catch (e: unknown) {
        const status = (e as { status?: number })?.status;
        if (status !== 404) throw e;
        await conn.octokit.repos.createForAuthenticatedUser({
            name: repo,
            description: "Music Manager Online — project history (auto-managed).",
            private: true,
            auto_init: true,
        });
    }
    return { owner, repo };
}

async function putFile(
    conn: GithubConnection,
    owner: string,
    repo: string,
    path: string,
    contentB64: string,
    message: string,
): Promise<string> {
    let sha: string | undefined;
    try {
        const cur = await conn.octokit.repos.getContent({ owner, repo, path });
        if (!Array.isArray(cur.data) && "sha" in cur.data) sha = cur.data.sha;
    } catch (e) {
        if ((e as { status?: number })?.status !== 404) throw e;
    }
    const res = await conn.octokit.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: contentB64, sha,
    });
    return res.data.commit.sha ?? "";
}

export async function commitSnapshot(
    input: CommitSnapshotInput,
): Promise<{ sha: string; url: string } | null> {
    const conn = await getGithubConnection(input.userId);
    if (!conn) return null;
    const { owner, repo } = await ensureMonorepo(conn);

    const docPath = `projects/${input.projectKind}/${input.projectExternalId}/project.json`;
    const docB64 = Buffer.from(JSON.stringify(input.document, null, 2)).toString("base64");
    const message =
        `[${input.projectKind}] ${input.label ?? "snapshot"} (${input.snapshotExternalId})`;

    let lastSha = await putFile(conn, owner, repo, docPath, docB64, message);

    if (input.assets) {
        for (const [sha256, base64] of Object.entries(input.assets)) {
            const assetPath = `assets/${sha256}.bin`;
            lastSha = await putFile(conn, owner, repo, assetPath, base64, `${message} — asset ${sha256.slice(0, 8)}`);
        }
    }

    return {
        sha: lastSha,
        url: `https://github.com/${owner}/${repo}/commit/${lastSha}`,
    };
}

export async function listRemoteSnapshots(
    userId: string,
    projectKind: string,
    projectExternalId: string,
): Promise<Array<{ sha: string; message: string; date: string }>> {
    const conn = await getGithubConnection(userId);
    if (!conn) return [];
    const { owner, repo } = await ensureMonorepo(conn);
    const path = `projects/${projectKind}/${projectExternalId}/project.json`;
    const commits = await conn.octokit.repos.listCommits({ owner, repo, path, per_page: 50 });
    return commits.data.map(c => ({
        sha: c.sha,
        message: c.commit.message,
        date: c.commit.author?.date ?? c.commit.committer?.date ?? "",
    }));
}
