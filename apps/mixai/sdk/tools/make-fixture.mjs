// Regenerate fixtures/sample-signed.mixaipack (community trust, PUBLIC test key from helpers.mjs).
// Used by the Rust cross-check test: it must inspect as trust=community, id com.example.test.sample.
//   node apps/mixai/sdk/tools/make-fixture.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPack } from "../lib/pack.mjs";
import { sha256Hex } from "../lib/sign.mjs";
import { TEST_KEY_ID, TEST_SEED, sampleFiles } from "./fixture.mjs";

const out = new URL("../fixtures/sample-signed.mixaipack", import.meta.url);
mkdirSync(new URL("../fixtures/", import.meta.url), { recursive: true });
const { bytes } = buildPack(sampleFiles(), { seed: TEST_SEED, keyId: TEST_KEY_ID, embedPubkey: true });
writeFileSync(out, bytes);
console.log(`${fileURLToPath(out)} ${bytes.length} B sha256 ${sha256Hex(bytes)}`);
