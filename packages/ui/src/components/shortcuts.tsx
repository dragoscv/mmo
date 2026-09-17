"use client";

import * as React from "react";
import { cn } from "../lib/cn";
import { useUiT } from "../i18n/index";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog";
import { KbdCombo } from "./kbd";
import { detectPlatform, useRegisterShortcut, useShortcuts, type Platform, type ShortcutDef } from "../lib/shortcuts-registry";

export interface ShortcutsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Override group headings (default: the raw group id, capitalised). */
  groupLabels?: Record<string, string>;
  className?: string;
}

function groupShortcuts(list: ShortcutDef[]): Array<{ id: string; items: ShortcutDef[] }> {
  const map = new Map<string, ShortcutDef[]>();
  for (const s of list) {
    const arr = map.get(s.group) ?? [];
    arr.push(s);
    map.set(s.group, arr);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, items]) => ({ id, items: items.slice().sort((a, b) => a.label.localeCompare(b.label)) }));
}

export function ShortcutsOverlay({ open, onOpenChange, groupLabels, className }: ShortcutsOverlayProps) {
  const t = useUiT();
  const shortcuts = useShortcuts();
  const groups = React.useMemo(() => groupShortcuts(shortcuts), [shortcuts]);
  const [platform, setPlatform] = React.useState<Platform>("other");
  React.useEffect(() => setPlatform(detectPlatform()), []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className={cn("max-h-[85dvh] overflow-hidden", className)}>
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <div className="-mx-2 grid gap-6 overflow-y-auto px-2 pb-1 sm:grid-cols-2">
          {groups.length === 0 ? <p className="text-sm text-muted-foreground">{t("common.noResults")}</p> : null}
          {groups.map((g) => (
            <section key={g.id} aria-labelledby={`shortcuts-${g.id}`} className="flex flex-col gap-1">
              <h3 id={`shortcuts-${g.id}`} className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {groupLabels?.[g.id] ?? g.id.charAt(0).toUpperCase() + g.id.slice(1)}
              </h3>
              <ul className="flex flex-col">
                {g.items.map((s) => (
                  <li key={s.id} className="flex h-row items-center justify-between gap-3 rounded-md px-1 text-sm compact:h-8 hover:bg-muted/60">
                    <span className="truncate">{s.label}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {s.keys.map((k, i) => (
                        <React.Fragment key={k}>
                          {i > 0 ? <span className="text-xs text-muted-foreground">/</span> : null}
                          <KbdCombo combo={k} platform={platform} />
                        </React.Fragment>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Registers `?` (global) to toggle the overlay; returns its open state. */
export function useShortcutsOverlay() {
  const [open, setOpen] = React.useState(false);
  const toggle = React.useCallback(() => setOpen((o) => !o), []);
  const t = useUiT();
  useRegisterShortcut(
    {
      id: "shortcuts-overlay",
      keys: ["?"],
      label: t("shortcuts.title"),
      group: "general",
      global: true,
      handler: toggle,
    },
    [toggle, t],
  );
  return { open, setOpen, toggle };
}
