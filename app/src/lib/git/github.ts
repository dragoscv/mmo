/**
 * GitHub-backed project history.
 *
 * STATUS: scaffold. Not wired up.
 *
 * Design:
 *   - User connects their GitHub via Auth.js (separate OAuth provider).
 *     Store the encrypted access token on `user.githubToken` or in a
 *     dedicated `user_oauth_tokens` table.
 *   - On first cloud-side `createSnapshot()` call for a project that has
 *     `gitEnabled: true`, lazily ensure a private repo exists named
 *     `mmo-project-{externalId}` (or a single mono-repo with one
 *     folder per project — TBD with the user).
 *   - Each snapshot becomes a commit on `main`. Document JSONB is
 *     pretty-printed into `project.json`; binary assets that were new
 *     in this snapshot are uploaded via the GitHub Contents API or LFS
 *     for large files (>50 MB).
 *   - `gitCommitSha` on `project_snapshots` lets the UI link back.
 *
 * TODO:
 *   1. Add GitHub OAuth provider to `app/src/auth.ts`.
 *   2. Add `app/drizzle/0018_user_github.sql` for token storage.
 *   3. Implement the functions below using @octokit/rest.
 *   4. UI: settings page + project-level "Connect to GitHub" toggle.
 */

export interface GithubConnection {
    userId: string;
    login: string;
    accessToken: string; // encrypted at rest
}

export interface CommitSnapshotInput {
    userId: string;
    projectKind: string;
    projectExternalId: string;
    snapshotExternalId: string;
    label: string | null;
    document: Record<string, unknown>;
    /** sha256 → file name; bytes fetched from GCS or companion. */
    assets?: Record<string, string>;
}

export async function connectGithub(_userId: string, _code: string): Promise<GithubConnection> {
    throw new Error("connectGithub: not implemented (scaffold)");
}

export async function ensureProjectRepo(
    _conn: GithubConnection,
    _projectExternalId: string,
    _projectName: string,
): Promise<{ owner: string; repo: string }> {
    throw new Error("ensureProjectRepo: not implemented (scaffold)");
}

export async function commitSnapshot(_input: CommitSnapshotInput): Promise<{ sha: string; url: string }> {
    throw new Error("commitSnapshot: not implemented (scaffold)");
}

export async function listRemoteSnapshots(
    _conn: GithubConnection,
    _projectExternalId: string,
): Promise<Array<{ sha: string; message: string; date: string }>> {
    throw new Error("listRemoteSnapshots: not implemented (scaffold)");
}
