"use client";

import * as React from "react";
import { Command as Cmdk } from "cmdk";
import { SearchIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { useUiT } from "../i18n/index";
import { Dialog, DialogContent } from "./dialog";
import { KbdCombo } from "./kbd";
import { useRegisterShortcut } from "../lib/shortcuts-registry";

// ─── Primitives ─────────────────────────────────────────────────────────────

export function Command({ className, ...props }: React.ComponentProps<typeof Cmdk>) {
  return (
    <Cmdk
      data-slot="command"
      className={cn("flex h-full w-full flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground", className)}
      {...props}
    />
  );
}

export function CommandInput({ className, placeholder, ...props }: React.ComponentProps<typeof Cmdk.Input>) {
  const t = useUiT();
  return (
    <div data-slot="command-input-wrapper" className="flex h-12 items-center gap-2 border-b border-border px-3">
      <SearchIcon className="size-4 shrink-0 opacity-50" aria-hidden />
      <Cmdk.Input
        data-slot="command-input"
        placeholder={placeholder ?? t("command.placeholder")}
        className={cn(
          "flex h-12 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: React.ComponentProps<typeof Cmdk.List>) {
  return (
    <Cmdk.List
      data-slot="command-list"
      className={cn("max-h-[min(60dvh,24rem)] scroll-py-1 overflow-x-hidden overflow-y-auto overscroll-contain p-1", className)}
      {...props}
    />
  );
}

export function CommandEmpty({ className, children, ...props }: React.ComponentProps<typeof Cmdk.Empty>) {
  const t = useUiT();
  return (
    <Cmdk.Empty data-slot="command-empty" className={cn("py-6 text-center text-sm text-muted-foreground", className)} {...props}>
      {children ?? t("common.noResults")}
    </Cmdk.Empty>
  );
}

export function CommandGroup({ className, ...props }: React.ComponentProps<typeof Cmdk.Group>) {
  return (
    <Cmdk.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: React.ComponentProps<typeof Cmdk.Separator>) {
  return <Cmdk.Separator data-slot="command-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export function CommandItem({ className, ...props }: React.ComponentProps<typeof Cmdk.Item>) {
  return (
    <Cmdk.Item
      data-slot="command-item"
      className={cn(
        "relative flex h-row cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none compact:h-8",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg]:text-muted-foreground data-[selected=true]:[&_svg]:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandShortcut({ className, keys, ...props }: React.ComponentProps<"span"> & { keys?: string[] }) {
  return (
    <span data-slot="command-shortcut" className={cn("ml-auto flex items-center gap-1 text-xs tracking-widest text-muted-foreground", className)} {...props}>
      {keys ? keys.map((k) => <KbdCombo key={k} combo={k} />) : props.children}
    </span>
  );
}

export const CommandLoading = Cmdk.Loading;

// ─── Dialog ─────────────────────────────────────────────────────────────────

export type CommandGroupId = "navigate" | "actions" | "theme" | (string & {});

export interface CommandItemDef {
  id: string;
  label: string;
  group: CommandGroupId;
  icon?: React.ReactNode;
  keywords?: string[];
  shortcut?: string[];
  disabled?: boolean;
  onSelect: () => void;
}

export interface CommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItemDef[];
  /** Custom `<CommandGroup>`s rendered after the generated ones. */
  children?: React.ReactNode;
  placeholder?: string;
  /** Override heading labels per group id (defaults: i18n `command.navigate|actions|theme`). */
  groupLabels?: Record<string, string>;
  className?: string;
}

const BUILTIN_GROUP_ORDER: CommandGroupId[] = ["navigate", "actions", "theme"];

export function CommandDialog({ open, onOpenChange, items, children, placeholder, groupLabels, className }: CommandDialogProps) {
  const t = useUiT();

  const groups = React.useMemo(() => {
    const map = new Map<string, CommandItemDef[]>();
    for (const item of items) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    const ordered = [...BUILTIN_GROUP_ORDER.filter((g) => map.has(g)), ...Array.from(map.keys()).filter((g) => !BUILTIN_GROUP_ORDER.includes(g))];
    return ordered.map((g) => ({ id: g, items: map.get(g) ?? [] }));
  }, [items]);

  const headingFor = (g: string) => {
    if (groupLabels?.[g]) return groupLabels[g];
    if (g === "navigate") return t("command.navigate");
    if (g === "actions") return t("command.actions");
    if (g === "theme") return t("command.theme");
    return g;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        size="md"
        mobile="sheet"
        className={cn("gap-0 overflow-hidden p-0 sm:top-[18%] sm:-translate-y-0 max-sm:pb-[var(--safe-bottom)]", className)}
        aria-label={placeholder ?? t("command.placeholder")}
      >
        <Command loop>
          <CommandInput placeholder={placeholder} autoFocus />
          <CommandList>
            <CommandEmpty />
            {groups.map((g, gi) => (
              <React.Fragment key={g.id}>
                {gi > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={headingFor(g.id)}>
                  {g.items.map((item) => (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      keywords={[item.label, ...(item.keywords ?? [])]}
                      disabled={item.disabled}
                      onSelect={() => {
                        onOpenChange(false);
                        item.onSelect();
                      }}
                    >
                      {item.icon}
                      <span className="truncate">{item.label}</span>
                      {item.shortcut?.length ? <CommandShortcut keys={item.shortcut} /> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </React.Fragment>
            ))}
            {children}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/** Owns the open state and registers `mod+k` (global) in the shortcuts registry. */
export function useCommandPalette(options: { label?: string; group?: string } = {}) {
  const [open, setOpen] = React.useState(false);
  const toggle = React.useCallback(() => setOpen((o) => !o), []);
  const t = useUiT();
  useRegisterShortcut(
    {
      id: "command-palette",
      keys: ["mod+k"],
      label: options.label ?? t("command.placeholder"),
      group: options.group ?? "general",
      global: true,
      handler: toggle,
    },
    [toggle, options.label, options.group, t],
  );
  return { open, setOpen, toggle };
}
