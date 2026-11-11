// Regenerate the fixtures (community trust, PUBLIC test key from fixture.mjs) used by the Rust
// cross-check tests:
//   fixtures/sample-signed.mixaipack  manifest v1 bundle, id com.example.test.sample
//   fixtures/sample-style.mixaipack   manifest v2 skin with a full `style` block, id com.example.test.style
//   node apps/mixai/sdk/tools/make-fixture.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPack } from "../lib/pack.mjs";
import { sha256Hex } from "../lib/sign.mjs";
import { TEST_KEY_ID, TEST_SEED, sampleFiles, styleSampleFiles } from "./fixture.mjs";

mkdirSync(new URL("../fixtures/", import.meta.url), { recursive: true });
for (const [name, files] of [["sample-signed", sampleFiles()], ["sample-style", styleSampleFiles()]]) {
	const out = new URL(`../fixtures/${name}.mixaipack`, import.meta.url);
	const { bytes } = buildPack(files, { seed: TEST_SEED, keyId: TEST_KEY_ID, embedPubkey: true });
	writeFileSync(out, bytes);
	console.log(`${fileURLToPath(out)} ${bytes.length} B sha256 ${sha256Hex(bytes)}`);
}
