import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/theme-provider";
import { AppShell } from "./app-shell";
import { BottomTabBar } from "./bottom-tab-bar";
import { Sidebar, SidebarContent, SidebarTrigger } from "./sidebar";

const MOBILE_QUERY = "(max-width: 47.99rem)";

/** matchMedia mock where only the mobile query flips with `mobile`. */
function mockViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query === MOBILE_QUERY ? mobile : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const shell = (props: Partial<React.ComponentProps<typeof AppShell>> = {}) =>
  render(
    <ThemeProvider>
      <AppShell
        sidebar={
          <Sidebar withMobile={false}>
            <SidebarContent>rail</SidebarContent>
          </Sidebar>
        }
        header={<SidebarTrigger />}
        bottomBar={<BottomTabBar items={[{ id: "a", label: "A", icon: <span />, href: "/a" }]} />}
        {...props}
      >
        <p>page</p>
      </AppShell>
    </ThemeProvider>,
  );

describe("AppShell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("ResizeObserver", RO);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("desktop: sidebar rail is expanded and the trigger collapses it (persisted)", () => {
    mockViewport(false);
    shell();
    const aside = document.querySelector('[data-slot="sidebar"]')!;
    expect(aside).toHaveAttribute("data-state", "expanded");
    expect(aside.className).toContain("w-64");
    const trigger = screen.getByRole("button", { name: "Mai mult" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    act(() => trigger.click());
    expect(aside).toHaveAttribute("data-state", "collapsed");
    expect(aside.className).toContain("w-[3.75rem]");
    expect(aside.className).not.toContain("w-64");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(window.localStorage.getItem("mixai:sidebar")!)).toEqual({ collapsed: true });
  });

  it("mobile: the trigger toggles the drawer, not the rail", () => {
    mockViewport(true);
    shell();
    const aside = document.querySelector('[data-slot="sidebar"]')!;
    const trigger = screen.getByRole("button", { name: "Mai mult" });
    expect(trigger).toHaveAttribute("aria-expanded", "false"); // mobileOpen
    act(() => trigger.click());
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(aside).toHaveAttribute("data-state", "expanded"); // rail untouched
    expect(window.localStorage.getItem("mixai:sidebar")).toBeNull();
  });

  it("renders the bottom tab bar as a fixed md:hidden nav and pads <main> by its measured height", () => {
    mockViewport(true);
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const r = orig.call(this);
      if (this.getAttribute("data-slot") === "bottom-tab-bar") return { ...r, height: 56 } as DOMRect;
      return r;
    };
    try {
      shell();
      const nav = document.querySelector('nav[data-slot="bottom-tab-bar"]')!;
      expect(nav.className).toContain("fixed");
      expect(nav.className).toContain("md:hidden");
      expect(nav.className).toContain("pb-[var(--safe-bottom)]");
      const root = document.querySelector<HTMLElement>('[data-slot="app-shell"]')!;
      expect(root.style.getPropertyValue("--shell-tabbar-height")).toBe("56px");
      expect(root.style.getPropertyValue("--shell-bottom-offset")).toBe("56px");
      const main = document.querySelector("main")!;
      expect(main.className).toContain("pb-[var(--shell-tabbar-height,0px)]");
      expect(main).toHaveAttribute("data-scroll-container");
    } finally {
      Element.prototype.getBoundingClientRect = orig;
    }
  });

  it("without a bottom bar the offset falls back to the safe-area", () => {
    mockViewport(false);
    shell({ bottomBar: undefined });
    const root = document.querySelector<HTMLElement>('[data-slot="app-shell"]')!;
    expect(root.style.getPropertyValue("--shell-tabbar-height")).toBe("0px");
    expect(root.style.getPropertyValue("--shell-bottom-offset")).toBe("0px");
  });

  it("player height feeds --shell-player-height", () => {
    mockViewport(false);
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const r = orig.call(this);
      if (this.getAttribute("data-slot") === "app-shell-player") return { ...r, height: 72 } as DOMRect;
      return r;
    };
    try {
      shell({ bottomBar: undefined, player: <div>player</div> });
      const root = document.querySelector<HTMLElement>('[data-slot="app-shell"]')!;
      expect(root.style.getPropertyValue("--shell-player-height")).toBe("72px");
      expect(root.style.getPropertyValue("--shell-bottom-offset")).toBe("72px");
    } finally {
      Element.prototype.getBoundingClientRect = orig;
    }
  });
});
