/**
 * All app catalogues merged. Each area owns one `messages-<area>.ts` file so
 * parallel work never collides on one big file. Every module exports
 * `{ en: {...}, ro: {...} } as const` with identical key sets (parity checked by
 * src/i18n/parity.test.ts).
 */
import { appMessages } from "./messages";
import { shellMessages } from "./messages-shell";
import { settingsMessages } from "./messages-settings";
import { packMessages } from "./messages-pack";
import { libraryMessages } from "./messages-library";
import { deckMessages } from "./messages-deck";
import { lookMessages } from "./messages-look";
import { wavesMessages } from "./messages-waves";
import { mixerMessages } from "./messages-mixer";
import { deckTabsMessages } from "./messages-decktabs";
import { skinsMessages } from "./messages-skins";
import { linkMessages } from "./messages-link";
import { practiceMessages } from "./messages-practice";
import { remoteMessages } from "./messages-remote";
import { copilotMessages } from "./messages-copilot";
import { setlogMessages } from "./messages-setlog";
import { gigMessages } from "./messages-gig";

export const catalogs = [
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
    // Before the set tracklist: src/setlog/contract.test.ts pins `setlogMessages` as the last entry.
    gigMessages,
    setlogMessages,
] as const;

type Merge<T extends readonly { en: Record<string, string> }[]> = T extends readonly [infer H, ...infer R]
    ? (H extends { en: infer E } ? E : never) & (R extends readonly { en: Record<string, string> }[] ? Merge<R> : unknown)
    : unknown;

export type AllMessages = Merge<typeof catalogs>;
export type AppMessageKey = keyof AllMessages & string;

function merge(locale: "en" | "ro"): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of catalogs) Object.assign(out, c[locale] as Record<string, string>);
    return out;
}

export const mergedMessages = { en: merge("en"), ro: merge("ro") } as const;
