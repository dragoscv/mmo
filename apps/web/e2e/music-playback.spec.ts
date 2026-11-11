import { test, expect, type Page } from "@playwright/test";

/**
 * WP17-105 — what the desktop listings of MixAI Music promise, in a real browser, as a GUEST of the public demo
 * server (Connect → Try the demo): the Playback settings, a harmonic radio request, a real crossfade (both
 * `<audio>` elements audible at once, then the next song alone at full volume) and the "Play on TV" control.
 * The interface language follows the browser (the cloud runner gets Romanian), so locators accept EN and RO.
 * Run: `node scripts/e2e-cloud/run.mjs --target https://music.mixai.ro e2e/music-playback.spec.ts --project=chromium`
 * (or `--target vm-prod` for the tree before a deploy).
 */

const PLAYBACK_KEY = "mixai:music:playback";

interface Deck { paused: boolean; volume: number; rate: number; t: number; d: number; ready: number }

async function connectDemo(page: Page) {
    await page.goto("/connect?demo=1");
    await page.waitForFunction(() => (localStorage.getItem("mixai-web:guest-servers") ?? "").includes("demo.mixai.ro"), null, { timeout: 60_000, polling: 500 });
}

async function passProfileGate(page: Page) {
    const reviewer = page.getByRole("region").getByRole("button", { name: /^R?\s*Reviewer$/i }).first();
    if (await reviewer.waitFor({ timeout: 8_000 }).then(() => true, () => false)) {
        await reviewer.click();
        await reviewer.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    }
}

function decks(page: Page): Promise<Deck[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAudioElement>("audio[data-mixai-web-music]")).map((a) => ({
            paused: a.paused, volume: a.volume, rate: a.playbackRate, t: a.currentTime, d: a.duration, ready: a.readyState,
        })));
}

/** next-intl renders a missing message as its key path; none may be on screen. */
async function expectNoRawKeys(page: Page) {
    await expect(page.getByText(/\bmx\.(music|player)\.[a-z]/i)).toHaveCount(0);
}

test.use({ colorScheme: "dark" });

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem("mixai:prefs:v1", JSON.stringify({ mode: "dark" }));
        localStorage.setItem("mixai:onboarding:dismissed", "1");
    });
});

test("playback settings: crossfade is off by default, the slider and the automix switch persist", async ({ page }) => {
    test.setTimeout(180_000);
    await connectDemo(page);
    await page.goto("/media/music");
    await passProfileGate(page);
    await page.getByTestId("music-home").waitFor({ timeout: 30_000 });

    await page.getByTestId("music-playback-open").first().click();
    const panel = page.getByTestId("music-playback");
    await expect(panel).toBeVisible();
    await expectNoRawKeys(page);

    const slider = page.getByTestId("music-crossfade");
    await expect(slider).toHaveValue("0");
    const automix = page.getByTestId("music-automix");
    await expect(automix).toHaveAttribute("aria-checked", "true");

    await slider.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveValue("6");
    expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), PLAYBACK_KEY)).toEqual({ crossfadeSec: 6, automix: true });

    await automix.click();
    await expect(automix).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), PLAYBACK_KEY)).toEqual({ crossfadeSec: 6, automix: false });

    // Survives a reload.
    await page.reload();
    await passProfileGate(page);
    await page.getByTestId("music-playback-open").first().click();
    await expect(page.getByTestId("music-crossfade")).toHaveValue("6");
    await expect(page.getByTestId("music-automix")).toHaveAttribute("aria-checked", "false");
});

test("default settings (crossfade off): the next song starts at the end, the two never overlap", async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await connectDemo(page);
    await page.goto("/media/music");
    await passProfileGate(page);
    const album = page.locator('main a[href*="/album/"]').first();
    await album.waitFor({ timeout: 30_000 });
    await album.click();
    await page.getByTestId("music-album").waitFor({ timeout: 30_000 });
    await page.getByTestId("music-radio").first().click();
    await page.waitForURL(/\/media\/music\/now-playing/, { timeout: 30_000 });
    expect(await page.evaluate((k) => localStorage.getItem(k), PLAYBACK_KEY), "nothing stored: the defaults apply").toBeNull();
    const title = page.getByTestId("np-title");
    await title.waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await decks(page)).some((d) => !d.paused && d.t > 1 && Number.isFinite(d.d)), { timeout: 45_000, message: "no deck is playing" }).toBe(true);
    const first = (await title.textContent()) ?? "";

    await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll<HTMLAudioElement>("audio[data-mixai-web-music]")).find((x) => !x.paused);
        if (a && Number.isFinite(a.duration)) a.currentTime = Math.max(0, a.duration - 8);
    });
    let overlap = 0, samples = 0, changed = false;
    const until = Date.now() + 45_000;
    while (Date.now() < until) {
        const playing = (await decks(page)).filter((d) => !d.paused);
        samples++;
        if (playing.length === 2) overlap++;
        if (((await title.textContent()) ?? "") !== first) { changed = true; break; }
        await page.waitForTimeout(200);
    }
    console.log(`WP17-105 default path: ${samples} samples 200 ms apart, overlap samples ${overlap}, next song started: ${changed}`);
    expect(changed, "the next song never started").toBe(true);
    expect(overlap, "two songs were audible together although crossfade is off").toBe(0);
    await expect.poll(async () => {
        const pl = (await decks(page)).filter((d) => !d.paused);
        return pl.length === 1 && pl[0]!.volume > 0.99 && pl[0]!.rate === 1 && pl[0]!.t > 0.5;
    }, { timeout: 30_000, message: "the next song is not playing alone at full volume and native tempo" }).toBe(true);
    expect(errors, "uncaught page errors").toEqual([]);
});

test("radio asks for harmonic order; two songs really overlap in a crossfade; Play on TV opens", async ({ page }) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript((k) => localStorage.setItem(k, JSON.stringify({ crossfadeSec: 8, automix: true })), PLAYBACK_KEY);
    await connectDemo(page);
    await page.goto("/media/music");
    await passProfileGate(page);
    const album = page.locator('main a[href*="/album/"]').first();
    await album.waitFor({ timeout: 30_000 });
    await album.click();
    await page.getByTestId("music-album").waitFor({ timeout: 30_000 });

    // 1. Radio from the album: the request carries order=harmonic and the server answers with tracks.
    const radio = page.getByTestId("music-radio").first();
    const [req] = await Promise.all([page.waitForRequest((r) => r.url().includes("/media/music/radio"), { timeout: 30_000 }), radio.click()]);
    expect(new URL(req.url()).searchParams.get("order")).toBe("harmonic");
    const res = await req.response();
    expect(res?.status()).toBe(200);
    const body = (await res!.json()) as { tracks: Array<{ id: string; title: string; albumId?: string | null; track?: number | null; disc?: number | null; bpm?: number | null }> };
    expect(body.tracks.length).toBeGreaterThan(1);
    const withBpm = body.tracks.filter((t) => typeof t.bpm === "number" && t.bpm > 0).length;
    // Songs that follow each other on one album never crossfade (they stay gapless): start from the first pair that is not one.
    const continuation = (a: (typeof body.tracks)[number], b: (typeof body.tracks)[number]) =>
        !!a.albumId && a.albumId === b.albumId && (a.disc ?? 1) === (b.disc ?? 1) && typeof a.track === "number" && typeof b.track === "number" && b.track === a.track + 1;
    const hasBpm = (t: (typeof body.tracks)[number]) => typeof t.bpm === "number" && t.bpm > 0;
    const pairs = body.tracks.map((t, i) => ({ i, t, n: body.tracks[i + 1] })).filter((x) => x.n !== undefined && !continuation(x.t, x.n));
    expect(pairs.length, "every pair in the radio is an album continuation").toBeGreaterThan(0);
    // Prefer a pair where both songs carry a tempo (the beat-matched path), within the first few songs; else the first pair.
    const at = (pairs.find((x) => x.i <= 6 && hasBpm(x.t) && hasBpm(x.n!)) ?? pairs[0]!).i;
    const [ta, tb] = [body.tracks[at]!, body.tracks[at + 1]!];
    console.log(`WP17-105 radio: ${body.tracks.length} tracks, ${withBpm} with bpm; crossfade pair at index ${at}: bpm ${ta.bpm ?? "-"} -> ${tb.bpm ?? "-"} (${hasBpm(ta) && hasBpm(tb) ? "tempo on both: beat-matched when within 6 %" : "no tempo on one side: plain crossfade"})`);

    // 2. It plays (the radio button opens Now Playing itself; a full page load here would drop the player).
    await page.waitForURL(/\/media\/music\/now-playing/, { timeout: 30_000 });
    const title = page.getByTestId("np-title");
    await title.waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await decks(page)).some((d) => !d.paused && d.t > 1), { timeout: 45_000, message: "no deck is playing (codec or autoplay?)" }).toBe(true);
    for (let i = 0; i < at; i++) {
        await page.getByRole("button", { name: /^(Next|Următoarea)$/ }).first().click();
        await expect(title).toHaveText(body.tracks[i + 1]!.title, { timeout: 20_000 });
    }
    await expect.poll(async () => (await decks(page)).some((d) => !d.paused && d.t > 1 && Number.isFinite(d.d)), { timeout: 45_000, message: "the song before the crossfade is not playing" }).toBe(true);
    const first = (await title.textContent()) ?? "";

    // 3. Jump near the end of the song and watch both decks: an overlap with both audible, then the handoff.
    await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll<HTMLAudioElement>("audio[data-mixai-web-music]")).find((x) => !x.paused);
        if (a && Number.isFinite(a.duration)) a.currentTime = Math.max(0, a.duration - 22);
    });
    let overlap = 0, minOut = 1, maxIn = 0, rateSeen = 1;
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
        const ds = await decks(page);
        const playing = ds.filter((d) => !d.paused);
        if (playing.length === 2) {
            overlap++;
            const [lo, hi] = [...playing].sort((x, y) => x.volume - y.volume);
            maxIn = Math.max(maxIn, lo!.volume);
            minOut = Math.min(minOut, hi!.volume);
            for (const d of playing) if (Math.abs(d.rate - 1) > Math.abs(rateSeen - 1)) rateSeen = d.rate;
        }
        if (overlap > 0 && playing.length === 1 && ((await title.textContent()) ?? "") !== first) break;
        await page.waitForTimeout(250);
    }
    console.log(`WP17-105 crossfade: overlap samples ${overlap} (250 ms apart), quieter deck reached ${maxIn.toFixed(2)}, louder deck fell to ${minOut.toFixed(2)}, tempo rate seen ${rateSeen.toFixed(4)}`);
    expect(overlap, "both decks were never playing at the same time").toBeGreaterThanOrEqual(4);
    expect(maxIn, "the incoming song never became audible during the overlap").toBeGreaterThan(0.2);
    expect(minOut, "the outgoing song never got quieter during the overlap").toBeLessThan(0.98);
    await expect(title).not.toHaveText(first, { timeout: 30_000 });
    // After the handoff: one deck, full volume, and the tempo back at 1 once the glide is over.
    await expect.poll(async () => {
        const p = (await decks(page)).filter((d) => !d.paused);
        return p.length === 1 && p[0]!.volume > 0.99 && Math.abs(p[0]!.rate - 1) < 0.001;
    }, { timeout: 30_000, message: "after the crossfade the next song is not alone at full volume and native tempo" }).toBe(true);

    // 4. Play on TV: the control opens with real strings (a guest of the demo server usually has no TV to pick).
    await page.getByTestId("music-send-to-tv").click();
    await expect(page.getByRole("dialog", { name: /^(Play the queue on|Redă coada pe)$/ })).toBeVisible();
    await expectNoRawKeys(page);

    expect(errors, "uncaught page errors").toEqual([]);
});
