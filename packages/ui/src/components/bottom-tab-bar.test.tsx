import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/theme-provider";
import { BottomTabBar, BOTTOM_TAB_BAR_HEIGHT, type BottomTabItem } from "./bottom-tab-bar";

const item = (id: string, extra: Partial<BottomTabItem> = {}): BottomTabItem => ({ id, label: id.toUpperCase(), icon: <svg aria-hidden />, href: `/${id}`, ...extra });

const mount = (props: Partial<React.ComponentProps<typeof BottomTabBar>>) =>
  render(
    <ThemeProvider>
      <BottomTabBar items={[]} {...props} />
    </ThemeProvider>,
  );

const tabsIn = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>('[data-slot="bottom-tab"]'));

describe("BottomTabBar", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders every item as a link when they fit (≤ maxSlots) and no More button", () => {
    mount({ items: ["a", "b", "c", "d", "e"].map((id) => item(id)) });
    const nav = screen.getByRole("navigation");
    const tabs = tabsIn(nav);
    expect(tabs).toHaveLength(5);
    expect(tabs.map((t) => t.tagName)).toEqual(["A", "A", "A", "A", "A"]);
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual(["/a", "/b", "/c", "/d", "/e"]);
    expect(screen.queryByRole("button", { name: "Mai mult" })).toBeNull();
    expect(nav.style.height).toBe(`calc(${BOTTOM_TAB_BAR_HEIGHT} + var(--safe-bottom, 0px))`);
  });

  it("active item gets aria-current=page + data-active; others do not", () => {
    mount({ items: [item("a"), item("b", { active: true }), item("c")] });
    const tabs = tabsIn(screen.getByRole("navigation"));
    expect(tabs.map((t) => t.getAttribute("aria-current"))).toEqual([null, "page", null]);
    expect(tabs.map((t) => t.hasAttribute("data-active"))).toEqual([false, true, false]);
  });

  it("overflow: shows maxSlots-1 items + More; More opens a sheet with the rest", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"].map((id) => item(id));
    mount({ items });
    const nav = screen.getByRole("navigation");
    const visible = tabsIn(nav);
    expect(visible).toHaveLength(5);
    expect(visible.slice(0, 4).map((t) => t.textContent)).toEqual(["A", "B", "C", "D"]);
    const more = screen.getByRole("button", { name: "Mai mult" });
    expect(more).toHaveAttribute("aria-haspopup", "dialog");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("G")).toBeNull();

    act(() => more.click());
    expect(more).toHaveAttribute("aria-expanded", "true");
    const sheet = document.querySelector('[data-slot="bottom-tab-more"]')!;
    expect(tabsIn(sheet).map((t) => t.textContent)).toEqual(["E", "F", "G"]);
  });

  it("More is marked active when the active item lives in the overflow, and selecting closes the sheet", () => {
    const onSelect = vi.fn();
    const items = ["a", "b", "c", "d", "e", "f"].map((id) => item(id));
    items[5] = { ...items[5]!, active: true, onSelect };
    mount({ items });
    const more = screen.getByRole("button", { name: "Mai mult" });
    expect(more).toHaveAttribute("data-active", "true");
    act(() => more.click());
    const f = document.querySelector<HTMLElement>('[data-slot="bottom-tab-more"] [data-slot="bottom-tab"][data-active]')!;
    expect(f.textContent).toBe("F");
    act(() => f.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(more).toHaveAttribute("aria-expanded", "false");
  });

  it("respects a custom maxSlots and moreLabel", () => {
    mount({ items: ["a", "b", "c", "d"].map((id) => item(id)), maxSlots: 3, moreLabel: "Extra" });
    const nav = screen.getByRole("navigation");
    expect(tabsIn(nav)).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Extra" })).toBeInTheDocument();
  });

  it("items without href render as buttons and call onSelect", () => {
    const onSelect = vi.fn();
    mount({ items: [{ id: "x", label: "X", icon: <svg aria-hidden />, onSelect }] });
    const tab = tabsIn(screen.getByRole("navigation"))[0]!;
    expect(tab.tagName).toBe("BUTTON");
    act(() => tab.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
