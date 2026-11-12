// Run: node --test apps/mixai/src/i18n/parity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { appMessages } from "./messages.ts";
import { shellMessages } from "./messages-shell.ts";
import { settingsMessages } from "./messages-settings.ts";
import { packMessages } from "./messages-pack.ts";
import { libraryMessages } from "./messages-library.ts";
import { deckMessages } from "./messages-deck.ts";
import { lookMessages } from "./messages-look.ts";
import { wavesMessages } from "./messages-waves.ts";
import { mixerMessages } from "./messages-mixer.ts";
import { deckTabsMessages } from "./messages-decktabs.ts";
import { skinsMessages } from "./messages-skins.ts";
import { linkMessages } from "./messages-link.ts";
import { practiceMessages } from "./messages-practice.ts";
import { remoteMessages } from "./messages-remote.ts";
import { copilotMessages } from "./messages-copilot.ts";

const all = {
    appMessages,
    shellMessages,
    settingsMessages,
    packMessages,
    libraryMessages,
    deckMessages,
    lookMessages,
    wavesMessages,
    mixerMessages,
    deckTabsMessages,
    skinsMessages,
    linkMessages,
    practiceMessages,
    remoteMessages,
    copilotMessages,
};

test("every catalogue has the same keys in en and ro, and no empty strings", () => {
    for (const [name, c] of Object.entries(all)) {
        const en = Object.keys(c.en).sort();
        const ro = Object.keys(c.ro).sort();
        assert.deepEqual(ro, en, `${name}: en/ro key sets differ`);
        for (const [k, v] of Object.entries({ ...c.en, ...c.ro })) assert.ok(String(v).trim().length > 0, `${name}.${k} empty`);
    }
});

test("no key is defined in two catalogues", () => {
    const seen = new Map<string, string>();
    for (const [name, c] of Object.entries(all))
        for (const k of Object.keys(c.en)) {
            assert.ok(!seen.has(k), `${k} in ${seen.get(k)} and ${name}`);
            seen.set(k, name);
        }
});
