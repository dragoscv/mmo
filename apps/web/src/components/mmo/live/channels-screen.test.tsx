import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import type { LiveTvChannel, LiveTvSource } from "@/lib/mmo/media-types";
import en from "../../../../messages/wp16/live.en.json";
import { ChannelsScreen } from "./channels-screen";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/media/live" }));

const source = { id: "s1", kind: "m3u", name: "S", url: "u", hasPassword: false, enabled: true, refreshHours: 24, channelCount: 2, tunerLimit: 1, createdAt: 0, updatedAt: 0 } as LiveTvSource;
const ch = (id: string, over: Partial<LiveTvChannel> = {}): LiveTvChannel => ({ id, sourceId: "s1", name: id, archiveDays: 0, catchup: false, hidden: false, favourite: false, ...over });

let livetv: Record<string, ReturnType<typeof vi.fn>>;
vi.mock("../mmo-provider", () => ({ useMmo: () => ({ clients: { livetv } }) }));

function mount() {
    return render(
        <NextIntlClientProvider locale="en" messages={{ mx: { live: en } }} timeZone="UTC">
            <ChannelsScreen />
        </NextIntlClientProvider>,
    );
}

afterEach(() => { cleanup(); push.mockReset(); });
beforeAll(() => {
    // jsdom has no matchMedia; narrow viewport → no hls preview panel in tests.
    window.matchMedia = ((q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => undefined, removeEventListener: () => undefined,
        addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
});

describe("ChannelsScreen", () => {
    it("shows the add-source empty state when the server has no sources", async () => {
        livetv = {
            channels: vi.fn().mockResolvedValue([]), sources: vi.fn().mockResolvedValue([]), groups: vi.fn().mockResolvedValue([]),
            now: vi.fn().mockResolvedValue({ now: 0, channels: [] }), logoUrl: vi.fn().mockReturnValue(null),
        };
        mount();
        const cta = await screen.findByRole("link", { name: /Add an M3U \/ Xtream \/ HDHomeRun source/ });
        expect(cta.getAttribute("href")).toBe("/media/live/sources?add=1");
    });

    it("lists channels with now/next, filters by group and opens the player", async () => {
        const now = Date.now();
        livetv = {
            channels: vi.fn().mockResolvedValue([ch("news", { name: "News 24", number: "1", group: "News" }), ch("sport", { name: "Sport", number: "2", group: "Sport", favourite: true })]),
            sources: vi.fn().mockResolvedValue([source]),
            groups: vi.fn().mockResolvedValue([{ name: "News", count: 1 }, { name: "Sport", count: 1 }]),
            now: vi.fn().mockResolvedValue({ now, channels: [{ channelId: "news", now: { channelId: "news", start: now - 60_000, stop: now + 60_000, title: "Headlines" } }] }),
            logoUrl: vi.fn().mockReturnValue(null),
        };
        mount();
        await screen.findByText("News 24");
        await screen.findByText("Headlines");
        // Favourites first (default on): Sport precedes News 24.
        const rows = screen.getAllByRole("button", { name: /^Watch / });
        expect(rows[0]?.getAttribute("aria-label")).toMatch(/^Watch Sport/);
        fireEvent.click(screen.getByRole("button", { name: /^News/ }));
        await waitFor(() => expect(screen.queryByText("Sport", { selector: ".lv-row-name" })).toBeNull());
        fireEvent.click(screen.getByRole("button", { name: /^Watch News 24/ }));
        expect(push).toHaveBeenCalledWith("/media/live/play/news");
    });
});
