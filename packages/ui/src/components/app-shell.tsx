"use client";

import * as React from "react";
import { cn } from "../lib/cn.ts";
import { SidebarProvider, type SidebarProviderProps } from "./sidebar.tsx";

export interface AppShellProps extends Omit<React.ComponentProps<"div">, "children"> {
  children: React.ReactNode;
  /** `<Sidebar>…</Sidebar>`; rendered as the left column on `md+`. */
  sidebar?: React.ReactNode;
  /** Top bar; row 1 of the grid. */
  header?: React.ReactNode;
  /** `<BottomTabBar>`; fixed on mobile, its height feeds `--shell-bottom-offset`. */
  bottomBar?: React.ReactNode;
  /** Mini-player docked at the bottom; row 3 of the grid. */
  player?: React.ReactNode;
  mainClassName?: string;
  sidebarProps?: Omit<SidebarProviderProps, "children">;
}

/**
 * Application frame: `[sidebar] | [header / main / player]` on desktop,
 * `[header / main]` + fixed bottom tab bar on mobile.
 *
 * Exposes `--shell-bottom-offset` (player + tab bar + safe-bottom) on the root
 * so pages can `pb-[var(--shell-bottom-offset)]`, and `--shell-player-height`.
 */
export function AppShell({ children, sidebar, header, bottomBar, player, className, mainClassName, sidebarProps, style, ...props }: AppShellProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const playerRef = React.useRef<HTMLDivElement>(null);
  const barRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const playerH = playerRef.current?.getBoundingClientRect().height ?? 0;
      // The tab bar is `fixed` and `md:hidden`; measure the first visible fixed child.
      const barEl = barRef.current?.firstElementChild as HTMLElement | null;
      const barVisible = barEl ? getComputedStyle(barEl).display !== "none" : false;
      const barH = barVisible && barEl ? barEl.getBoundingClientRect().height : 0; // includes safe-bottom padding
      const safeBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-bottom")) || 0;
      root.style.setProperty("--shell-player-height", `${playerH}px`);
      root.style.setProperty("--shell-tabbar-height", `${barH}px`);
      // player row already sits inside the grid; only fixed things need offset — plus safe area when no bar.
      const offset = barH > 0 ? barH + playerH : playerH + safeBottom;
      root.style.setProperty("--shell-bottom-offset", `${offset}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    if (playerRef.current) ro.observe(playerRef.current);
    const barEl = barRef.current?.firstElementChild;
    if (barEl) ro.observe(barEl);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [bottomBar, player]);

  return (
    <SidebarProvider {...sidebarProps}>
      <div
        ref={rootRef}
        data-slot="app-shell"
        className={cn("flex h-dvh w-full overflow-hidden bg-background text-foreground", "ultrawide:mx-auto ultrawide:max-w-[240rem] ultrawide:px-[clamp(1rem,4vw,6rem)]", className)}
        style={{ ["--shell-bottom-offset" as string]: "var(--safe-bottom, 0px)", ...style }}
        {...props}
      >
        {sidebar}
        <div data-slot="app-shell-body" className="grid h-full min-w-0 flex-1 grid-rows-[auto_1fr_auto]">
          <div data-slot="app-shell-header" className="z-(--z-sticky) empty:hidden">
            {header}
          </div>
          <main
            data-scroll-container
            data-slot="app-shell-main"
            className={cn("relative min-h-0 overflow-y-auto overscroll-contain pb-[var(--shell-tabbar-height,0px)]", mainClassName)}
          >
            {children}
          </main>
          <div ref={playerRef} data-slot="app-shell-player" className="z-(--z-player) empty:hidden">
            {player}
          </div>
        </div>
        <div ref={barRef} data-slot="app-shell-bottom-bar" className="contents">
          {bottomBar}
        </div>
      </div>
    </SidebarProvider>
  );
}
