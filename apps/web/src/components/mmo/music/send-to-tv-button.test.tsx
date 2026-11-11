import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import musicEn from "../../../../messages/wp16/music.en.json";
import musicRo from "../../../../messages/wp16/music.ro.json";
import playerEn from "../../../../messages/wp16/player.en.json";
import playerRo from "../../../../messages/wp16/player.ro.json";
import type { HubDevice } from "@/lib/mmo/media-types";

const dev = (o: Partial<HubDevice>): HubDevice => ({
    deviceId: "d", name: "N", platform: "android-tv", caps: ["play", "music"], profileId: null, app: null, connectedAt: 0, guest: false, nowPlaying: null, ...o,
});

const fake = {
    devices: [] as HubDevice[],
    hubStatus: "connected",
    setQueue: vi.fn(async (_q: unknown) => null),
    commandAwait: vi.fn(async (_id: string, _action: string, _args: unknown) => ({ ok: true } as { ok: boolean; error?: string })),
    pause: vi.fn(),
    toastOk: vi.fn(),
    toastErr: vi.fn(),
};

vi.mock("../mmo-provider", () => ({
    useMmo: () => ({ clients: { music: { setQueue: fake.setQueue }, hub: { commandAwait: fake.commandAwait } }, devices: fake.devices, hubStatus: fake.hubStatus }),
}));
vi.mock("@/lib/mmo/hub", () => ({ deviceId: () => "self" }));
vi.mock("sonner", () => ({ toast: { success: (m: string) => fake.toastOk(m), error: (m: string) => fake.toastErr(m) } }));
vi.mock("@/lib/mmo/web-music-player", () => ({
    webMusicPlayer: {
        getState: () => ({ queue: [{ id: "tr_1" }, { id: "tr_2" }, { id: "tr_3" }], index: 1, shuffle: false, repeat: "all" }),
        getProgress: () => ({ position: 33.7, duration: 200 }),
        pause: () => fake.pause(),
    },
}));

const { SendQueueToTv } = await import("./send-to-tv-button");

/** `mx.music.tv` — the block `messages/wp16/music.{en,ro}.json` must carry (the component reads these keys). */
const TV = {
    en: {
        button: "Play on TV",
        title: "Play the queue on",
        sent: "The queue is now playing on {device}",
        errEmpty: "There is nothing in the queue to send.",
        errNotFound: "{device} could not find these songs. Check that it is connected to the same server.",
    },
    ro: {
        button: "Redă pe TV",
        title: "Redă coada pe",
        sent: "Coada se redă acum pe {device}",
        errEmpty: "Nu există nimic în coadă de trimis.",
        errNotFound: "{device} nu a găsit aceste melodii. Verifică dacă este conectat la același server.",
    },
};
const WITH_DEVICE = ["sent", "errNotFound"];

/** Keys of `TV.en` that `music.tv` lacks (or that lost their `{device}` placeholder). */
function missingTvKeys(music: unknown): string[] {
    const tv = (music as { tv?: Record<string, unknown> }).tv ?? {};
    return Object.keys(TV.en).filter((k) => typeof tv[k] !== "string" || tv[k] === "" || (WITH_DEVICE.includes(k) && !(tv[k] as string).includes("{device}")));
}

function renderBtn(locale: "en" | "ro" = "en") {
    return render(
        <NextIntlClientProvider locale={locale} messages={{ mx: { music: { tv: TV[locale] }, player: locale === "en" ? playerEn : playerRo } }}>
            <SendQueueToTv />
        </NextIntlClientProvider>,
    );
}

describe("mx.music.tv messages", () => {
    it("the check itself: complete blocks pass, a missing key or placeholder is reported", () => {
        expect(missingTvKeys({ tv: TV.en })).toEqual([]);
        expect(missingTvKeys({ tv: TV.ro })).toEqual([]);
        expect(missingTvKeys({})).toEqual(Object.keys(TV.en));
        expect(missingTvKeys({ tv: { ...TV.en, sent: "The queue is playing", errEmpty: "" } })).toEqual(["sent", "errEmpty"]);
    });
    it("music.en.json and music.ro.json carry every key the button reads", () => {
        expect({ en: missingTvKeys(musicEn), ro: missingTvKeys(musicRo) }).toEqual({ en: [], ro: [] });
    });
});

describe("SendQueueToTv", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fake.hubStatus = "connected";
        fake.devices = [dev({ deviceId: "self", name: "This browser" }), dev({ deviceId: "old", name: "Old TV", caps: ["play"] }), dev({ deviceId: "tv-1", name: "Living room" })];
        fake.commandAwait.mockResolvedValue({ ok: true });
    });
    afterEach(() => cleanup());

    it("lists only music-capable devices and hands the queue over in one click, then pauses here", async () => {
        renderBtn();
        fireEvent.click(screen.getByRole("button", { name: "Play on TV" }));
        const item = await screen.findByRole("button", { name: /Living room/ });
        expect(screen.queryByRole("button", { name: /Old TV/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /This browser/ })).toBeNull();

        fireEvent.click(item);
        await waitFor(() => expect(fake.toastOk).toHaveBeenCalledWith("The queue is now playing on Living room"));
        expect(fake.setQueue).toHaveBeenCalledWith({ trackIds: ["tr_1", "tr_2", "tr_3"], index: 1, positionSec: 33, shuffle: false, repeat: "all" });
        expect(fake.commandAwait).toHaveBeenCalledTimes(1);
        expect(fake.commandAwait).toHaveBeenCalledWith("tv-1", "play", { trackIds: ["tr_1", "tr_2", "tr_3"], index: 1, positionSec: 33, shuffle: false, repeat: "all" });
        expect(fake.pause).toHaveBeenCalledTimes(1);
        expect(fake.toastErr).not.toHaveBeenCalled();
    });

    it("keeps playing here and says why when the TV refuses (RO)", async () => {
        fake.commandAwait.mockResolvedValue({ ok: false, error: "tracks_not_found" });
        renderBtn("ro");
        fireEvent.click(screen.getByRole("button", { name: "Redă pe TV" }));
        fireEvent.click(await screen.findByRole("button", { name: /Living room/ }));
        await waitFor(() => expect(fake.toastErr).toHaveBeenCalledWith("Living room nu a găsit aceste melodii. Verifică dacă este conectat la același server."));
        expect(fake.pause).not.toHaveBeenCalled();
        expect(fake.toastOk).not.toHaveBeenCalled();
    });

    it("uses the shared cast wording for a TV that does not answer", async () => {
        fake.commandAwait.mockResolvedValue({ ok: false, error: "timeout" });
        renderBtn();
        fireEvent.click(screen.getByRole("button", { name: "Play on TV" }));
        fireEvent.click(await screen.findByRole("button", { name: /Living room/ }));
        await waitFor(() => expect(fake.toastErr).toHaveBeenCalledWith("Living room did not answer in time."));
        expect(fake.pause).not.toHaveBeenCalled();
    });

    it("explains how to get a TV listed when none takes music", async () => {
        fake.devices = [dev({ deviceId: "old", name: "Old TV", caps: ["play"] })];
        renderBtn();
        fireEvent.click(screen.getByRole("button", { name: "Play on TV" }));
        expect(await screen.findByText("No TV is online")).toBeTruthy();
        expect(fake.commandAwait).not.toHaveBeenCalled();
    });
});
