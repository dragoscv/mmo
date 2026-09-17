"use client";

import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useRender } from "@base-ui/react/use-render";
import { mergeProps } from "@base-ui/react/merge-props";
import { PanelLeftIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { useUiT } from "../i18n/index";
import { useIsMobile } from "../hooks/index";

// ─── Persistence ────────────────────────────────────────────────────────────

const STORAGE_KEY = "mixai:sidebar";
const LEGACY_KEY = "sidebar-collapsed";

function readCollapsed(defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { collapsed?: boolean };
      return Boolean(parsed.collapsed);
    }
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy !== null) {
      const collapsed = legacy === "true" || legacy === "1";
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ collapsed }));
      window.localStorage.removeItem(LEGACY_KEY);
      return collapsed;
    }
  } catch {
    /* private mode */
  }
  return defaultValue;
}

function writeCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ collapsed }));
  } catch {
    /* ignore */
  }
}

// ─── Context ────────────────────────────────────────────────────────────────

export interface SidebarContextValue {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggleCollapsed: () => void;
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
  isMobile: boolean;
  /** Toggles the right thing for the current viewport. */
  toggle: () => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within <SidebarProvider>");
  return ctx;
}

export interface SidebarProviderProps {
  children: React.ReactNode;
  defaultCollapsed?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function SidebarProvider({ children, defaultCollapsed = false, collapsed: controlled, onCollapsedChange }: SidebarProviderProps) {
  const [internal, setInternal] = React.useState(defaultCollapsed);
  const [hydrated, setHydrated] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const isMobile = useIsMobile();

  React.useEffect(() => {
    if (controlled === undefined) setInternal(readCollapsed(defaultCollapsed));
    setHydrated(true);
  }, [controlled, defaultCollapsed]);

  const collapsed = controlled ?? internal;
  const setCollapsed = React.useCallback(
    (v: boolean) => {
      if (controlled === undefined) {
        setInternal(v);
        writeCollapsed(v);
      }
      onCollapsedChange?.(v);
    },
    [controlled, onCollapsedChange],
  );
  const toggleCollapsed = React.useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);

  React.useEffect(() => {
    if (!isMobile) setMobileOpen(false);
  }, [isMobile]);

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      collapsed,
      setCollapsed,
      toggleCollapsed,
      mobileOpen,
      setMobileOpen,
      isMobile,
      toggle: () => (isMobile ? setMobileOpen((o) => !o) : toggleCollapsed()),
    }),
    [collapsed, setCollapsed, toggleCollapsed, mobileOpen, isMobile],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div data-slot="sidebar-provider" data-sidebar-hydrated={hydrated || undefined} className="contents">
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

// ─── Desktop rail ───────────────────────────────────────────────────────────

export interface SidebarProps extends React.ComponentProps<"aside"> {
  /** Also render the mobile panel with the same children. Default true. */
  withMobile?: boolean;
}

export function Sidebar({ className, children, withMobile = true, ...props }: SidebarProps) {
  const { collapsed } = useSidebar();
  return (
    <>
      <aside
        data-slot="sidebar"
        data-state={collapsed ? "collapsed" : "expanded"}
        data-collapsed={collapsed || undefined}
        className={cn(
          "group/sidebar hidden h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex",
          "transition-[width] duration-(--dur-base) ease-(--ease-out)",
          collapsed ? "w-[3.75rem]" : "w-64",
          className,
        )}
        {...props}
      >
        {children}
      </aside>
      {withMobile ? <SidebarMobile>{children}</SidebarMobile> : null}
    </>
  );
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-header" className={cn("flex h-14 shrink-0 items-center gap-2 px-3 group-data-[collapsed]/sidebar:justify-center group-data-[collapsed]/sidebar:px-0", className)} {...props} />;
}

export function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-content" className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2 py-2", className)} {...props} />;
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-footer" className={cn("flex shrink-0 flex-col gap-2 border-t border-sidebar-border p-2", className)} {...props} />;
}

export function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group" className={cn("relative flex w-full min-w-0 flex-col gap-0.5", className)} {...props} />;
}

export function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        "flex h-8 shrink-0 items-center px-2 text-xs font-medium text-sidebar-foreground/60 transition-opacity duration-(--dur-fast) group-data-[collapsed]/sidebar:h-2 group-data-[collapsed]/sidebar:overflow-hidden group-data-[collapsed]/sidebar:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="sidebar-menu" className={cn("flex w-full min-w-0 flex-col gap-0.5", className)} {...props} />;
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("group/menu-item relative", className)} {...props} />;
}

export interface SidebarMenuButtonProps extends Omit<React.ComponentPropsWithoutRef<"button">, "children">, Pick<useRender.ComponentProps<"button">, "render"> {
  active?: boolean;
  icon?: React.ReactNode;
  /** Text label; also becomes `title` when collapsed. */
  label: React.ReactNode;
  badge?: React.ReactNode;
  children?: React.ReactNode;
}

export function SidebarMenuButton({ className, active = false, icon, label, badge, children, render, ...props }: SidebarMenuButtonProps) {
  const { collapsed, isMobile, setMobileOpen } = useSidebar();
  const titleText = typeof label === "string" ? label : undefined;
  const own: React.ComponentPropsWithoutRef<"button"> & Record<`data-${string}`, unknown> = {
    "data-slot": "sidebar-menu-button",
    "data-active": active || undefined,
    "aria-current": active ? "page" : undefined,
    title: collapsed && !isMobile ? titleText : undefined,
    className: cn(
      "flex h-row w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none transition-[background-color,color] duration-(--dur-fast) ease-(--ease-out)",
      "hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/40",
      "data-[active]:bg-sidebar-accent data-[active]:font-medium data-[active]:text-sidebar-accent-foreground",
      "compact:h-8 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      "group-data-[collapsed]/sidebar:justify-center group-data-[collapsed]/sidebar:px-0",
      className,
    ),
    onClick: (e) => {
      props.onClick?.(e);
      if (isMobile) setMobileOpen(false);
    },
    children: (
      <>
        {icon}
        <span className="min-w-0 flex-1 truncate group-data-[collapsed]/sidebar:hidden">{label}</span>
        {badge ? <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 text-[0.6875rem] font-medium text-primary group-data-[collapsed]/sidebar:hidden">{badge}</span> : null}
        {children}
      </>
    ),
  };
  const { onClick: _ignored, ...rest } = props;
  void _ignored;
  return useRender({ render: render ?? <button type="button" />, props: mergeProps<"button">(own, rest) });
}

export function SidebarTrigger({ className, ...props }: React.ComponentProps<"button">) {
  const { toggle, collapsed, isMobile, mobileOpen } = useSidebar();
  const t = useUiT();
  return (
    <button
      type="button"
      data-slot="sidebar-trigger"
      aria-label={t("common.more")}
      aria-expanded={isMobile ? mobileOpen : !collapsed}
      className={cn(
        "inline-flex size-control-sm shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
        className,
      )}
      onClick={(e) => {
        props.onClick?.(e);
        toggle();
      }}
      {...props}
    >
      <PanelLeftIcon className="size-4" aria-hidden />
    </button>
  );
}

/** Thin clickable edge that toggles collapse on desktop. */
export function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
  const { toggleCollapsed, collapsed } = useSidebar();
  return (
    <button
      type="button"
      data-slot="sidebar-rail"
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      tabIndex={-1}
      onClick={toggleCollapsed}
      className={cn(
        "absolute inset-y-0 -right-1.5 z-(--z-raised) hidden w-3 cursor-col-resize md:block after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent after:transition-colors hover:after:bg-sidebar-border",
        className,
      )}
      {...props}
    />
  );
}

// ─── Mobile panel (Base UI Dialog + swipe-to-close) ─────────────────────────

export interface SidebarMobileProps {
  children: React.ReactNode;
  className?: string;
  /** Panel width. */
  width?: string;
}

export function SidebarMobile({ children, className, width = "min(20rem,85vw)" }: SidebarMobileProps) {
  const { mobileOpen, setMobileOpen } = useSidebar();
  const t = useUiT();
  const start = React.useRef<{ x: number; y: number; t: number } | null>(null);
  const [dx, setDx] = React.useState(0);
  const dragging = React.useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    dragging.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const ddx = e.clientX - start.current.x;
    const ddy = e.clientY - start.current.y;
    if (!dragging.current) {
      if (Math.abs(ddx) < 8 || Math.abs(ddy) > Math.abs(ddx)) return;
      dragging.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDx(Math.min(0, ddx));
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    if (!start.current) return;
    const ddx = e.clientX - start.current.x;
    const dt = Math.max(1, performance.now() - start.current.t);
    const velocity = ddx / dt; // px/ms
    start.current = null;
    const el = e.currentTarget as HTMLElement;
    const w = el.getBoundingClientRect().width || 320;
    if (dragging.current && (ddx < -w * 0.35 || velocity < -0.5)) setMobileOpen(false);
    dragging.current = false;
    setDx(0);
  };

  return (
    <BaseDialog.Root open={mobileOpen} onOpenChange={setMobileOpen} modal>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-(--z-overlay) bg-black/50 backdrop-blur-[2px] transition-opacity duration-(--dur-base) data-ending-style:opacity-0 data-starting-style:opacity-0 md:hidden" />
        <BaseDialog.Popup
          data-slot="sidebar-mobile"
          aria-label={t("common.more")}
          className={cn(
            "fixed inset-y-0 left-0 z-(--z-modal) flex h-dvh flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-xl outline-none md:hidden",
            "pb-[var(--safe-bottom)] pt-[var(--safe-top)] pl-[var(--safe-left)]",
            dx === 0 && "transition-transform duration-(--dur-base) ease-(--ease-out) data-starting-style:-translate-x-full data-ending-style:-translate-x-full",
            className,
          )}
          style={{ width, transform: dx !== 0 ? `translateX(${dx}px)` : undefined, touchAction: "pan-y" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <div className="group/sidebar contents" data-state="expanded">
            {children}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
