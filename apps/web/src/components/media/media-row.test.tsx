import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@mmo/ui";
import { MAX_ITEMS, MediaRow } from "./media-row";

// embla measures slides; jsdom has no layout, so a fake engine keeps the
// component's own wiring (arrows, keyboard, ARIA) under test.
const scrollTo = vi.fn();
const scrollNext = vi.fn();
const scrollPrev = vi.fn();
vi.mock("embla-carousel-react", () => ({
    default: () => {
        const api = {
            canScrollPrev: () => false,
            canScrollNext: () => true,
            slidesInView: () => [0, 1, 2],
            selectedScrollSnap: () => 0,
            scrollSnapList: () => [0, 1, 2, 3, 4],
            scrollTo,
            scrollNext,
            scrollPrev,
            on() { return api; },
            off() { return api; },
        };
        return [() => {}, api];
    },
}));

class RO { observe() {} unobserve() {} disconnect() {} }

const messages = {
    home: { row: { prev: "Scroll left", next: "Scroll right", seeAll: "See all ({count})", more: "+{count} more" } },
};

const wrap = (ui: React.ReactNode) => render(
    <NextIntlClientProvider locale="en" messages={messages}>
        <ThemeProvider>{ui}</ThemeProvider>
    </NextIntlClientProvider>,
);

const items = (n: number) => Array.from({ length: n }, (_, i) => <a key={i} href={`/media/movie/${i}`} role="listitem">Item {i}</a>);

beforeEach(() => vi.stubGlobal("ResizeObserver", RO));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); scrollTo.mockClear(); });

describe("MediaRow", () => {
    it("renders the title, a list with every item and both arrows", () => {
        wrap(<MediaRow id="r" title="Trending">{items(5)}</MediaRow>);
        expect(screen.getByRole("heading", { level: 2, name: "Trending" })).toBeInTheDocument();
        expect(screen.getByRole("list", { name: "Trending" })).toBeInTheDocument();
        expect(screen.getAllByRole("listitem")).toHaveLength(5);
        expect(screen.getByRole("button", { name: "Scroll left" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Scroll right" })).toBeEnabled();
    });

    it("next arrow pages by the visible slide count minus one", () => {
        wrap(<MediaRow title="T">{items(6)}</MediaRow>);
        fireEvent.click(screen.getByRole("button", { name: "Scroll right" }));
        expect(scrollTo).toHaveBeenCalledWith(2);
    });

    it("keyboard: ArrowRight pages, Home/End jump", () => {
        wrap(<MediaRow title="T">{items(6)}</MediaRow>);
        const list = screen.getByRole("list");
        fireEvent.keyDown(list, { key: "ArrowRight" });
        expect(scrollTo).toHaveBeenLastCalledWith(2);
        fireEvent.keyDown(list, { key: "End" });
        expect(scrollTo).toHaveBeenLastCalledWith(4);
        fireEvent.keyDown(list, { key: "Home" });
        expect(scrollTo).toHaveBeenLastCalledWith(0);
    });

    it("caps at MAX_ITEMS and shows a See all link when truncated", () => {
        wrap(<MediaRow title="Big" seeAllHref="/watch/movies">{items(MAX_ITEMS + 7)}</MediaRow>);
        // MAX_ITEMS cards + the "+N more" tile
        expect(screen.getAllByRole("listitem")).toHaveLength(MAX_ITEMS + 1);
        expect(screen.getByRole("link", { name: `See all (${MAX_ITEMS + 7})` })).toHaveAttribute("href", "/watch/movies");
        expect(screen.getByText("+7 more").closest("a")).toHaveAttribute("href", "/watch/movies");
    });
});
