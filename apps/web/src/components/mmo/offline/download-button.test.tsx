import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../messages/wp16/offline.en.json";
import ro from "../../../../messages/wp16/offline.ro.json";
import { Emitter } from "@/lib/mmo/emitter";
import type { OfflineChange, OfflineItem } from "@/lib/mmo/offline/types";

const fake = {
    changed: new Emitter<OfflineChange>(),
    current: null as OfflineItem | null,
    get: vi.fn(async () => fake.current),
    enqueue: vi.fn(async () => "k"),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    setCreds: vi.fn(),
};

vi.mock("@/lib/mmo/offline/manager", () => ({ offlineManager: () => fake }));

const { DownloadButton } = await import("./download-button");

const item = { serverId: "srv", profileId: "p1", kind: "movie" as const, id: "f1", title: "Dune", url: "https://srv.test/video/direct/f1?t=T" };

function rec(over: Partial<OfflineItem>): OfflineItem {
    return {
        key: "srv:p1:movie:f1", scope: "srv:p1", serverId: "srv", profileId: "p1", kind: "movie", id: "f1", title: "Dune",
        subtitle: null, durationSec: null, url: "https://srv.test/video/direct/f1", auth: ["t"], hasPoster: false, size: 200,
        bytes: 0, parts: [], mime: null, acceptRanges: false, status: "queued", error: null, addedAt: 1, updatedAt: 1, completedAt: null,
        ...over,
    };
}

function renderBtn(locale: "en" | "ro" = "en") {
    return render(
        <NextIntlClientProvider locale={locale} messages={{ mx: { offline: locale === "en" ? en : ro } }}>
            <DownloadButton item={item} />
        </NextIntlClientProvider>,
    );
}

describe("DownloadButton", () => {
    beforeEach(() => { fake.current = null; vi.clearAllMocks(); });
    afterEach(() => cleanup());

    it("starts a download and hands the live credentials to the manager", async () => {
        renderBtn();
        const btn = await screen.findByRole("button", { name: "Download Dune for offline" });
        fireEvent.click(btn);
        expect(fake.enqueue).toHaveBeenCalledWith(item);
        expect(fake.setCreds).toHaveBeenCalledWith("srv", { token: "T", userId: "" });
    });

    it("shows progress, pauses on press and announces progress politely", async () => {
        fake.current = rec({ status: "downloading", bytes: 100 });
        renderBtn();
        const btn = await screen.findByRole("button", { name: /Downloading Dune, 50%/ });
        expect(btn.textContent).toContain("50%");
        expect((await screen.findByText("Dune: 50% downloaded")).getAttribute("aria-live")).toBe("polite");
        fireEvent.click(btn);
        expect(fake.pause).toHaveBeenCalledWith("srv:p1:movie:f1");
    });

    it("links to downloads when done and offers retry on error (RO)", async () => {
        fake.current = rec({ status: "error", error: { code: "network" } });
        renderBtn("ro");
        const retry = await screen.findByRole("button", { name: "Descărcarea pentru Dune a eșuat. Apasă pentru a reîncerca." });
        fireEvent.click(retry);
        expect(fake.enqueue).toHaveBeenCalled();
    });

    it("renders the downloaded state as a link", async () => {
        fake.current = rec({ status: "done", bytes: 200 });
        renderBtn();
        const link = await screen.findByLabelText("Dune is downloaded. Open downloads.");
        expect(link.closest("a")?.getAttribute("href")).toBe("/media/downloads");
    });
});
