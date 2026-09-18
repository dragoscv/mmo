import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "../theme/theme-provider";
import { Sidebar, SidebarContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "./sidebar";

const MOBILE_QUERY = "(max-width: 47.99rem)";

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

function Probe() {
  const { collapsed, isMobile } = useSidebar();
  return <output data-testid="probe">{`${collapsed}|${isMobile}`}</output>;
}

const mount = (ui: React.ReactNode, providerProps: Partial<React.ComponentProps<typeof SidebarProvider>> = {}) =>
  render(
    <ThemeProvider>
      <SidebarProvider {...providerProps}>{ui}</SidebarProvider>
    </ThemeProvider>,
  );

describe("Sidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockViewport(false);
  });

  it("marks only the active item with aria-current=page and data-active", () => {
    mount(
      <Sidebar withMobile={false}>
        <SidebarContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton label="Library" active render={<a href="/library" />} />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton label="Mixer" render={<a href="/mixer" />} />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>,
    );
    const active = screen.getByRole("link", { name: "Library" });
    const inactive = screen.getByRole("link", { name: "Mixer" });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active).toHaveAttribute("data-active");
    expect(active).toHaveAttribute("href", "/library");
    expect(inactive).not.toHaveAttribute("aria-current");
    expect(inactive).not.toHaveAttribute("data-active");
  });

  it("collapse toggles data-state, width class and the collapsed title on items", () => {
    mount(
      <>
        <Sidebar withMobile={false}>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton label="Library" />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <Probe />
      </>,
    );
    const aside = document.querySelector('[data-slot="sidebar"]')!;
    const item = screen.getByRole("button", { name: "Library" });
    expect(aside).toHaveAttribute("data-state", "expanded");
    expect(aside).not.toHaveAttribute("data-collapsed");
    expect(aside.className).toContain("w-64");
    expect(item).not.toHaveAttribute("title");

    act(() => screen.getByRole("button", { name: "Collapse sidebar" }).click());
    expect(aside).toHaveAttribute("data-state", "collapsed");
    expect(aside).toHaveAttribute("data-collapsed", "true");
    expect(aside.className).toContain("w-[3.75rem]");
    expect(aside.className).not.toContain("w-64");
    // collapsed → label hidden, so the text moves to `title`
    expect(item).toHaveAttribute("title", "Library");
    expect(screen.getByTestId("probe").textContent).toBe("true|false");

    act(() => screen.getByRole("button", { name: "Expand sidebar" }).click());
    expect(aside).toHaveAttribute("data-state", "expanded");
    expect(screen.getByTestId("probe").textContent).toBe("false|false");
  });

  it("controlled mode: does not persist and reports via onCollapsedChange", () => {
    const seen: boolean[] = [];
    mount(
      <>
        <Sidebar withMobile={false}>
          <SidebarContent>rail</SidebarContent>
        </Sidebar>
        <SidebarTrigger />
      </>,
      { collapsed: false, onCollapsedChange: (v) => seen.push(v) },
    );
    act(() => screen.getByRole("button", { name: "Mai mult" }).click());
    expect(seen).toEqual([true]);
    // parent owns the state → DOM unchanged until it re-renders with collapsed=true
    expect(document.querySelector('[data-slot="sidebar"]')).toHaveAttribute("data-state", "expanded");
    expect(window.localStorage.getItem("mixai:sidebar")).toBeNull();
  });

  it("hydrates the collapsed state from localStorage and migrates the legacy key", () => {
    window.localStorage.setItem("sidebar-collapsed", "true");
    mount(
      <Sidebar withMobile={false}>
        <SidebarContent>rail</SidebarContent>
      </Sidebar>,
    );
    expect(document.querySelector('[data-slot="sidebar"]')).toHaveAttribute("data-state", "collapsed");
    expect(JSON.parse(window.localStorage.getItem("mixai:sidebar")!)).toEqual({ collapsed: true });
    expect(window.localStorage.getItem("sidebar-collapsed")).toBeNull();
  });

  it("mobile: clicking a menu item closes the drawer", () => {
    mockViewport(true);
    mount(
      <>
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton label="Library" />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <SidebarTrigger />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Mai mult" });
    act(() => trigger.click());
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Drawer + rail both render the item; the drawer copy lives inside the dialog popup.
    const inDrawer = document.querySelector('[data-slot="sidebar-mobile"] [data-slot="sidebar-menu-button"]') as HTMLElement | null;
    expect(inDrawer).not.toBeNull();
    act(() => inDrawer!.click());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
