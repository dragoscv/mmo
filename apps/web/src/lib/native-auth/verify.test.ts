import { describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { APPLE_ISSUER, IdTokenError, sha256Hex, verifyAppleIdentityToken, verifyGoogleIdToken } from "./verify";

async function issuer() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const mint = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string } = {}) =>
        new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setIssuer(opts.iss ?? APPLE_ISSUER)
            .setAudience(opts.aud ?? "ro.mixai.app")
            .setSubject("001234.abc")
            .setIssuedAt()
            .setExpirationTime(opts.exp ?? "5m")
            .sign(privateKey);
    return { keys, mint };
}

const expectCode = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toBeInstanceOf(IdTokenError);
    await expect(p).rejects.toMatchObject({ code });
};

describe("verifyAppleIdentityToken", () => {
    it("accepts a valid token whose nonce is the sha256 of the raw nonce", async () => {
        const { keys, mint } = await issuer();
        const token = await mint({ nonce: sha256Hex("raw-nonce-123"), email: "A@privaterelay.appleid.com", email_verified: "true" });
        const id = await verifyAppleIdentityToken(token, { audiences: ["ro.mixai.app"], rawNonce: "raw-nonce-123", keys });
        expect(id).toMatchObject({ provider: "apple", sub: "001234.abc", email: "a@privaterelay.appleid.com", emailVerified: true });
    });

    it("rejects a nonce mismatch (replayed token)", async () => {
        const { keys, mint } = await issuer();
        const token = await mint({ nonce: sha256Hex("other") });
        await expectCode(verifyAppleIdentityToken(token, { audiences: ["ro.mixai.app"], rawNonce: "raw-nonce-123", keys }), "nonce_mismatch");
    });

    it("rejects a token for another app (aud)", async () => {
        const { keys, mint } = await issuer();
        const token = await mint({ nonce: sha256Hex("raw-nonce-123") }, { aud: "com.evil.app" });
        await expectCode(verifyAppleIdentityToken(token, { audiences: ["ro.mixai.app"], rawNonce: "raw-nonce-123", keys }), "invalid_token");
    });

    it("rejects a wrong issuer and an expired token", async () => {
        const { keys, mint } = await issuer();
        const wrongIss = await mint({ nonce: sha256Hex("n-12345678") }, { iss: "https://evil.example" });
        await expectCode(verifyAppleIdentityToken(wrongIss, { audiences: ["ro.mixai.app"], rawNonce: "n-12345678", keys }), "invalid_token");
        const expired = await mint({ nonce: sha256Hex("n-12345678") }, { exp: "-10m" });
        await expectCode(verifyAppleIdentityToken(expired, { audiences: ["ro.mixai.app"], rawNonce: "n-12345678", keys }), "invalid_token");
    });

    it("rejects garbage and a token signed by another key", async () => {
        const { keys } = await issuer();
        const other = await issuer();
        await expectCode(verifyAppleIdentityToken("not.a.jwt", { audiences: ["ro.mixai.app"], rawNonce: "n-12345678", keys }), "invalid_token");
        const forged = await other.mint({ nonce: sha256Hex("n-12345678") });
        await expectCode(verifyAppleIdentityToken(forged, { audiences: ["ro.mixai.app"], rawNonce: "n-12345678", keys }), "invalid_token");
    });

    it("is misconfigured without audiences", async () => {
        const { keys, mint } = await issuer();
        const token = await mint({ nonce: "x" });
        await expectCode(verifyAppleIdentityToken(token, { audiences: [], rawNonce: "x", keys }), "misconfigured");
    });
});

describe("verifyGoogleIdToken", () => {
    it("accepts a token for one of the configured client ids", async () => {
        const { keys, mint } = await issuer();
        const token = await mint({ email: "u@gmail.com", email_verified: true, name: "U" }, { iss: "https://accounts.google.com", aud: "web.apps.googleusercontent.com" });
        const id = await verifyGoogleIdToken(token, { audiences: ["android.apps.googleusercontent.com", "web.apps.googleusercontent.com"], keys });
        expect(id).toMatchObject({ provider: "google", email: "u@gmail.com", emailVerified: true, name: "U" });
    });

    it("rejects Apple-issued tokens and unknown audiences", async () => {
        const { keys, mint } = await issuer();
        const apple = await mint({}, { aud: "web.apps.googleusercontent.com" });
        await expectCode(verifyGoogleIdToken(apple, { audiences: ["web.apps.googleusercontent.com"], keys }), "invalid_token");
        const otherAud = await mint({}, { iss: "accounts.google.com", aud: "x.apps.googleusercontent.com" });
        await expectCode(verifyGoogleIdToken(otherAud, { audiences: ["web.apps.googleusercontent.com"], keys }), "invalid_token");
    });
});
