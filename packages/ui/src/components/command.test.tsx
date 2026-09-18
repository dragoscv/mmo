import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/theme-provider";
import { getShortcuts, installShortcutListener, registerShortcut, useInstallShortcutListener, type ShortcutDef } from "../lib/shortcuts-registry";
import { CommandDialog, useCommandPalette, type CommandItemDef } from "./command";
import { ShortcutsOverlay } from "./shortcuts";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const def = (over: Partial<ShortcutDef> = {}): ShortcutDef => ({ id: "t-save", keys: ["mod+s"], label: "Save project", group: "editor", handler: () => {}, ...over });

function Palette({ items, onOpen }: { items: CommandItemDef[]; onOpen?: (o: boolean) => void }) {
  useInstallShortcutListener();
  const { open, setOpen } = useCommandPalette({ label: "Open palette" });
  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        onOpen?.(o);
        setOpen(o);
      }}
      items={items}
    />
  );
}

describe("shortcuts registry", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("registerShortcut adds to the snapshot; the returned fn removes it", () => {
    const before = getShortcuts().length;
    const off = registerShortcut(def());
    cleanups.push(off);
    expect(getShortcuts().map((s) => s.id)).toContain("t-save");
    expect(getShortcuts()).toHaveLength(before + 1);
    off();
    expect(getShortcuts().map((s) => s.id)).not.toContain("t-save");
    expect(getShortcuts()).toHaveLength(before);
  });

  it("re-registering the same id replaces; a stale unregister does not remove the newer def", () => {
    const first = registerShortcut(def({ label: "v1" }));
    const second = registerShortcut(def({ label: "v2" }));
    cleanups.push(second);
    expect(getShortcuts().filter((s) => s.id === "t-save").map((s) => s.label)).toEqual(["v2"]);
    first(); // stale
    expect(getShortcuts().find((s) => s.id === "t-save")?.label).toBe("v2");
  });

  it("dispatches mod+k as ctrl+k on non-mac, skips non-global shortcuts inside inputs, honours `when`", () => {
    const handler = vi.fn();
    const when = vi.fn(() => true);
    cleanups.push(registerShortcut(def({ id: "t-k", keys: ["mod+k"], handler, when })));
    cleanups.push(installShortcutListener(window));

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    // wrong modifier → no fire
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: "k" });
    expect(handler).toHaveBeenCalledTimes(1);

    when.mockReturnValue(false);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    when.mockReturnValue(true);

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1); // not global → skipped in editable
    input.remove();
  });
});

describe("ShortcutsOverlay", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("ResizeObserver", RO);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists registered shortcuts under their group and drops them on unregister", () => {
    const off = registerShortcut(def({ id: "ov-1", keys: ["mod+shift+p"], label: "Publish mix", group: "mixer" }));
    render(
      <ThemeProvider>
        <ShortcutsOverlay open onOpenChange={() => {}} groupLabels={{ mixer: "Mixer tools" }} />
      </ThemeProvider>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Publish mix");
    expect(screen.getByRole("heading", { level: 3, name: "Mixer tools" })).toBeInTheDocument();
    // kbd rendering of the combo (non-mac platform in jsdom)
    expect(dialog).toHaveTextContent(/Ctrl/);
    expect(dialog).toHaveTextContent(/Shift/);
    expect(dialog).toHaveTextContent("P");

    act(() => off());
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Publish mix");
    expect(screen.queryByRole("heading", { level: 3, name: "Mixer tools" })).toBeNull();
  });
});

describe("CommandDialog + useCommandPalette", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("ResizeObserver", RO);
    Element.prototype.scrollIntoView ??= () => {};
  });
  afterEach(() => vi.unstubAllGlobals());

  it("mod+k opens the palette and registers itself in the shortcuts registry", () => {
    const go = vi.fn();
    const items: CommandItemDef[] = [{ id: "nav-lib", label: "Go to library", group: "navigate", onSelect: go, shortcut: ["g l"] }];
    const onOpen = vi.fn();
    render(
      <ThemeProvider>
        <Palette items={items} onOpen={onOpen} />
      </ThemeProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    const reg = getShortcuts().find((s) => s.id === "command-palette");
    expect(reg).toMatchObject({ keys: ["mod+k"], label: "Open palette", global: true });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(Array.from(document.querySelectorAll("[cmdk-group-heading]")).map((h) => h.textContent)).toEqual(["Navigare"]);
    expect(dialog).toHaveTextContent("Go to library");

    // selecting an item runs onSelect and closes
    fireEvent.click(screen.getByText("Go to library"));
    expect(go).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith(false);

    // toggling again closes
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("groups items in navigate → actions → theme order, then custom groups; groupLabels override headings", () => {
    const items: CommandItemDef[] = [
      { id: "z", label: "Zed", group: "zeta", onSelect: () => {} },
      { id: "t", label: "Toggle dark", group: "theme", onSelect: () => {} },
      { id: "a", label: "Rescan", group: "actions", onSelect: () => {} },
      { id: "n", label: "Library", group: "navigate", onSelect: () => {} },
    ];
    render(
      <ThemeProvider>
        <CommandDialog open onOpenChange={() => {}} items={items} groupLabels={{ zeta: "Zeta tools" }} />
      </ThemeProvider>,
    );
    const headings = Array.from(document.querySelectorAll("[cmdk-group-heading]")).map((h) => h.textContent);
    expect(headings).toEqual(["Navigare", "Acțiuni", "Temă", "Zeta tools"]);
    expect(document.querySelectorAll('[data-slot="command-separator"]')).toHaveLength(3);
  });

  it("unmounting the palette unregisters mod+k", () => {
    const { unmount } = render(
      <ThemeProvider>
        <Palette items={[]} />
      </ThemeProvider>,
    );
    expect(getShortcuts().some((s) => s.id === "command-palette")).toBe(true);
    unmount();
    expect(getShortcuts().some((s) => s.id === "command-palette")).toBe(false);
  });
});
