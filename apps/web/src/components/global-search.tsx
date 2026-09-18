"use client";

/**
 * Legacy mount name kept for the sidebar search trigger and the mobile header.
 * The implementation moved to `command-palette.tsx` (WP9-02); this is a thin alias
 * with the same `{ open, onOpenChange }` contract.
 */
export { CommandPalette as GlobalSearch, type CommandPaletteProps as GlobalSearchProps } from "./command-palette";
