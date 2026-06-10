/**
 * Google Cloud Storage helper — signed URLs for user-owned files.
 *
 * Bucket: `mmo-user-files-prod` (provisioned via infra/terraform/database.tf)
 * Public access is **enforced off**. All reads/writes go through short-lived
 * signed URLs minted server-side after auth.
 *
 * Auth: the service account JSON lives in `GCP_SERVICE_ACCOUNT_KEY` as
 * base64-encoded JSON (so it round-trips through Vercel env without
 * newline issues). On local dev you can also fall back to ADC by leaving
 * the env unset and running `gcloud auth application-default login`.
 */

import { Storage } from "@google-cloud/storage";

const BUCKET = process.env.GCS_BUCKET ?? "mmo-user-files-prod";

let _storage: Storage | null = null;

function getStorage(): Storage {
    if (_storage) return _storage;
    const b64 = process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (b64 && b64.length > 100) {
        const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        _storage = new Storage({ credentials: json, projectId: json.project_id });
    } else {
        // ADC fallback (works locally with `gcloud auth application-default login`).
        _storage = new Storage();
    }
    return _storage;
}

/** Mint a 15-minute signed URL for uploading a file to GCS. */
export async function signedUploadUrl(
    objectKey: string,
    contentType: string,
): Promise<{ url: string; objectKey: string }> {
    const file = getStorage().bucket(BUCKET).file(objectKey);
    const [url] = await file.getSignedUrl({
        action: "write",
        version: "v4",
        expires: Date.now() + 15 * 60 * 1000,
        contentType,
    });
    return { url, objectKey };
}

/** Mint a short-lived signed URL for downloading a file from GCS. */
export async function signedDownloadUrl(
    objectKey: string,
    ttlSeconds = 300,
): Promise<string> {
    const file = getStorage().bucket(BUCKET).file(objectKey);
    const [url] = await file.getSignedUrl({
        action: "read",
        version: "v4",
        expires: Date.now() + ttlSeconds * 1000,
    });
    return url;
}

export async function deleteObject(objectKey: string): Promise<void> {
    await getStorage().bucket(BUCKET).file(objectKey).delete({ ignoreNotFound: true });
}

export const GCS_BUCKET = BUCKET;
