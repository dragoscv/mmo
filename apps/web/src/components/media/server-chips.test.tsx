import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";
import { ThemeProvider } from "@mmo/ui";
import type { ServerChip } from "@/lib/media/home";
import type { HomeRow } from "@/lib/media/types";
import { ServerChips } from "./server-chips";
import { WatchRows } from "./watch-rows";

vi.mock("./media-card", () => ({
    MediaCard: ({ item }: { item: { title: string } }) => <span role="listitem">{item.title}</span>,
}));
vi.mock("./media-row", () => ({
    MediaRow: ({ title, children }: { title: string; children: React.ReactNode }) => (
        <section><h2>{title}</h2><div role="list">{children}</div></section>
    ),
}));

const messages = {
    home: {
        servers: {
            label: "Filter by server", all: "All servers", offline: "offline", countLabel: "servers",
            unreachableSince: "Unreachable since {when}", noneForSelection: "Nothing to play on the selected servers.",
        },
    },
};

const chips: ServerChip[] = [
    { id: "A", name: "Desk", online: true, apiUrl: "http://a", lastSeenAt: new Date(0), count: 2 },
    { id: "B", name: "NAS", online: false, apiUrl: "http://b", lastSeenAt: new Date(1_000), count: 1 },
];

const rows: HomeRow[] = [
    {
        id: "continue", title: { ro: "Continuă", en: "Continue" }, kind: "mixed", items: [
            { kind: "movie", tmdbId: 1, title: "OnlyDesk", inLibrary: true, sources: [{ serverId: "A", serverName: "Desk" }] },
            { kind: "movie", tmdbId: 2, title: "Both", inLibrary: true, sources: [{ serverId: "A", serverName: "Desk" }, { serverId: "B", serverName: "NAS" }] },
        ],
    },
    { id: "top_picks", title: { ro: "Top", en: "Top" }, kind: "mixed", items: [{ kind: "tv", tmdbId: 3, title: "External", inLibrary: false }] },
];

function wrap(ui: React.ReactNode, search = "", onUrlUpdate?: (e: UrlUpdateEvent) => void) {
    return render(
        <NuqsTestingAdapter searchParams={search} onUrlUpdate={onUrlUpdate}>
            <NextIntlClientProvider locale="en" messages={messages}>
                <ThemeProvider>{ui}</ThemeProvider>
            </NextIntlClientProvider>
        </NuqsTestingAdapter>,
    );
}

afterEach(() => cleanup());

describe("ServerChips", () => {
    it("renders All + one chip per server with counts, offline greyed", () => {
        wrap(<ServerChips chips={chips} now={60_000} />);
        expect(screen.getByRole("button", { name: "All servers" })).toHaveAttribute("aria-pressed", "true");
        const desk = screen.getByRole("button", { name: /Desk/ });
        expect(desk).toHaveTextContent("Desk2");
        expect(desk).not.toHaveAttribute("data-offline");
        const nas = screen.getByRole("button", { name: /NAS/ });
        expect(nas).toHaveTextContent("NAS1offline");
        expect(nas).toHaveAttribute("data-offline");
    });

    it("writes the selection to ?servers=", async () => {
        const updates: UrlUpdateEvent[] = [];
        wrap(<ServerChips chips={chips} now={0} />, "", (e) => updates.push(e));
        fireEvent.click(screen.getByRole("button", { name: /Desk/ }));
        await waitFor(() => expect(updates.at(-1)?.searchParams.get("servers")).toBe("A"));
    });

    it("selecting every server collapses back to All", async () => {
        const updates: UrlUpdateEvent[] = [];
        wrap(<ServerChips chips={chips} now={0} />, "?servers=A", (e) => updates.push(e));
        fireEvent.click(screen.getByRole("button", { name: /NAS/ }));
        await waitFor(() => expect(updates.length).toBeGreaterThan(0));
        expect(updates.at(-1)?.searchParams.get("servers")).toBeNull();
    });

    it("hides itself with a single server", () => {
        const { container } = wrap(<ServerChips chips={chips.slice(0, 1)} now={0} />);
        expect(container.querySelector('[data-slot="server-chips"]')).toBeNull();
    });
});

describe("WatchRows filter", () => {
    it("shows everything without a selection", () => {
        wrap(<WatchRows rows={rows} />);
        expect(screen.getAllByRole("listitem").map((n) => n.textContent)).toEqual(["OnlyDesk", "Both", "External"]);
    });

    it("keeps only titles sourced by the selected server and drops external rows", () => {
        wrap(<WatchRows rows={rows} />, "?servers=B");
        expect(screen.getAllByRole("listitem").map((n) => n.textContent)).toEqual(["Both"]);
        expect(screen.queryByText("Top")).toBeNull();
    });

    it("renders the empty message when nothing matches", () => {
        wrap(<WatchRows rows={rows} />, "?servers=Z");
        expect(screen.getByText("Nothing to play on the selected servers.")).toBeInTheDocument();
    });
});
