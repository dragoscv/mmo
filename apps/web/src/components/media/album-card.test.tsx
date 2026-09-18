import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionTrack } from "@/lib/companion-library";
import type { Album } from "@/lib/media/listen-types";

const play = vi.fn();
vi.mock("@/components/player-context", () => ({ usePlayer: () => ({ play }) }));
vi.mock("@/actions/track-plays", () => ({ getTracksByCloudIds: vi.fn(async () => []) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AlbumCard } from "./album-card";
import { toast } from "sonner";

const album: Album = { key: "k", title: "Discovery", artist: "Daft Punk", year: 2001, cover: null, trackCount: 3, trackIds: [11, 12, 13] };
const labels = { play: "Play album", tracks: "{count} tracks", empty: "Nothing to play" };
const track = (id: number): CompanionTrack => ({ id, title: `T${id}` } as unknown as CompanionTrack);

afterEach(() => { cleanup(); play.mockClear(); });

describe("AlbumCard", () => {
    it("renders title, artist · year · track count and an accessible play button", () => {
        render(<AlbumCard album={album} labels={labels} resolveTracks={async () => []} />);
        expect(screen.getByRole("button", { name: "Play album: Discovery — Daft Punk" })).toBeInTheDocument();
        expect(screen.getByText("Discovery")).toBeInTheDocument();
        expect(screen.getByText("Daft Punk · 2001 · 3 tracks")).toBeInTheDocument();
        expect(screen.getByRole("listitem")).toBeInTheDocument();
    });

    it("resolves the album's tracks and plays them as the queue", async () => {
        const resolve = vi.fn(async (ids: number[]) => ids.map(track));
        render(<AlbumCard album={album} labels={labels} resolveTracks={resolve} />);
        fireEvent.click(screen.getByRole("button"));
        await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
        expect(resolve).toHaveBeenCalledWith([11, 12, 13]);
        const [first, queue] = play.mock.calls[0] as [CompanionTrack, CompanionTrack[]];
        expect(first.id).toBe(11);
        expect(queue.map((t) => t.id)).toEqual([11, 12, 13]);
    });

    it("toasts and does not play when nothing resolves", async () => {
        render(<AlbumCard album={album} labels={labels} resolveTracks={async () => []} />);
        fireEvent.click(screen.getByRole("button"));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nothing to play"));
        expect(play).not.toHaveBeenCalled();
        expect(screen.getByRole("button")).toHaveAttribute("aria-invalid", "true");
    });
});
