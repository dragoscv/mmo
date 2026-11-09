#!/usr/bin/env node
// MixAI Decks store package check (WP19-24): field limits per store, RO/EN parity, banned claims,
// data-safety answers vs the Android manifest, privacy policy section present in both locales.
//
//   node scripts/decks-store-check.mjs           exit 1 on any problem
//   node scripts/decks-store-check.mjs --self-test   mutation self-test of the checks
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");

// Limits: Google Play (title 30, short 80, full 4000, release notes 500), App Store (name 30, subtitle 30,
// promo 170, keywords 100 joined by commas, description 4000, what's new 4000), Microsoft Store (features 200 each,
// max 20; keywords max 7, 40 each; release notes 1500).
const LIMITS = { title: 30, shortDescription: 80, subtitle: 30, promotionalText: 170, description: 4000, releaseNotes: 500 };
// Claims stores reject or that we cannot prove.
const BANNED = [/\bbest\b/i, /\b#1\b/, /\bnumber one\b/i, /\bfree forever\b/i, /\bspotify\b/i, /\btidal\b/i, /\bbeatport\b/i,
    /\bcel mai bun\b/i, /\bgratuit pentru totdeauna\b/i, /\bunlimited\b/i, /\bnelimitat\b/i];

export function check({ listing, safety, manifest, privacyEn, privacyRo }) {
    const errors = [];
    const locales = listing.locales ?? {};
    for (const need of ["en", "ro"]) if (!locales[need]) errors.push(`missing locale ${need}`);
    const keysOf = (o) => Object.keys(o ?? {}).sort().join(",");
    if (locales.en && locales.ro && keysOf(locales.en) !== keysOf(locales.ro)) errors.push("en/ro fields differ");
    for (const [loc, l] of Object.entries(locales)) {
        for (const [field, max] of Object.entries(LIMITS)) {
            const v = l[field];
            if (typeof v !== "string" || !v.trim()) errors.push(`${loc}.${field} missing`);
            else if ([...v].length > max) errors.push(`${loc}.${field} is ${[...v].length} > ${max}`);
        }
        const kw = (l.keywords ?? []).join(",");
        if ([...kw].length > 100) errors.push(`${loc}.keywords ${[...kw].length} > 100 (App Store)`);
        if ((l.features ?? []).length === 0 || l.features.length > 20) errors.push(`${loc}.features count`);
        for (const f of l.features ?? []) if ([...f].length > 200) errors.push(`${loc}.feature too long: ${f}`);
        const text = Object.values(l).flat().join("\n");
        for (const re of BANNED) if (re.test(text)) errors.push(`${loc}: banned claim ${re}`);
    }
    if (locales.en && locales.ro) {
        const bullets = (s) => (s.match(/•/g) ?? []).length;
        if (bullets(locales.en.description) !== bullets(locales.ro.description)) errors.push("en/ro description bullet count differs");
    }
    for (const u of [listing.privacyUrl?.en, listing.privacyUrl?.ro, listing.supportUrl]) {
        if (!/^https:\/\//.test(u ?? "")) errors.push(`url not https: ${u}`);
    }
    // Data safety vs manifest.
    const declared = [...manifest.matchAll(/uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1]).sort();
    const explained = Object.keys(safety.permissions ?? {}).sort();
    if (declared.join(",") !== explained.join(",")) errors.push(`manifest permissions [${declared}] != data-safety [${explained}]`);
    if (safety.collectsData !== false || safety.sharesData !== false) {
        if (!/collect/i.test(privacyEn)) errors.push("data-safety says data is collected but privacy policy does not say so");
    }
    if (safety.apple?.tracking !== false) errors.push("apple.tracking must be false (no ATT prompt)");
    // Privacy policy covers Decks in both locales.
    const decksSection = (raw) => JSON.parse(raw).sections?.decks?.body ?? "";
    for (const [loc, raw] of [["en", privacyEn], ["ro", privacyRo]]) {
        const body = decksSection(raw);
        if (body.length < 100) errors.push(`privacy ${loc}: no Decks section`);
    }
    return errors;
}

function load() {
    return {
        listing: JSON.parse(read("apps/decks-android/store/listing.json")),
        safety: JSON.parse(read("apps/decks-android/store/data-safety.json")),
        manifest: read("apps/decks-android/app/src/main/AndroidManifest.xml"),
        privacyEn: read("apps/web/messages/wp16/privacy.en.json"),
        privacyRo: read("apps/web/messages/wp16/privacy.ro.json"),
    };
}

function selfTest() {
    const base = load();
    const clone = () => structuredClone(base);
    const mutants = [
        ["title too long", (d) => { d.listing.locales.en.title = "x".repeat(31); }],
        ["missing ro field", (d) => { delete d.listing.locales.ro.subtitle; }],
        ["banned claim", (d) => { d.listing.locales.ro.description += " Cel mai bun DJ."; }],
        ["keywords too long", (d) => { d.listing.locales.en.keywords.push("y".repeat(80)); }],
        ["undeclared permission", (d) => { d.manifest += '<uses-permission android:name="android.permission.RECORD_AUDIO" />'; }],
        ["tracking", (d) => { d.safety.apple.tracking = true; }],
        ["no privacy section", (d) => { const j = JSON.parse(d.privacyRo); delete j.sections.decks; d.privacyRo = JSON.stringify(j); }],
        ["bullet mismatch", (d) => { d.listing.locales.ro.description = d.listing.locales.ro.description.replace("•", "-"); }],
    ];
    let ok = check(base).length === 0;
    if (!ok) console.error("baseline not clean:", check(base));
    for (const [name, mutate] of mutants) {
        const d = clone();
        mutate(d);
        const caught = check(d).length > 0;
        console.log(`${caught ? "caught " : "MISSED "} ${name}`);
        ok &&= caught;
    }
    process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();
else {
    const errors = check(load());
    for (const e of errors) console.error(`decks-store-check: ${e}`);
    console.log(`decks-store-check: ${errors.length === 0 ? "OK" : `${errors.length} problem(s)`}`);
    process.exit(errors.length === 0 ? 0 : 1);
}
