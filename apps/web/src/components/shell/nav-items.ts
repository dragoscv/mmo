import { Ellipsis, type LucideIcon } from "lucide-react";
import { navTree, findActiveParent, isLeafActive, type NavLeaf, type NavParent } from "@/components/sidebar/nav-tree";

export interface ShellTab {
    id: string;
    /** `nav.*` i18n key. */
    key: string;
    /** English fallback when the key is missing. */
    label: string;
    href?: string;
    icon: LucideIcon;
    /** When true the tab opens the mobile sidebar instead of navigating. */
    more?: boolean;
}

/** Root nav keys that get a bottom-tab slot, in order. */
const TAB_KEYS = ["dashboard", "library", "watch", "music"] as const;

function nodeByKey(key: string): NavLeaf | NavParent | undefined {
    return navTree.find((n) => n.key === key);
}

/** Href for a node: leaves link to themselves, parents to their first child. */
export function nodeHref(node: NavLeaf | NavParent): string {
    return node.kind === "leaf" ? node.href : node.children[0].href;
}

export const shellTabs: ShellTab[] = [
    ...TAB_KEYS.flatMap((key): ShellTab[] => {
        const node = nodeByKey(key);
        if (!node) return [];
        return [{ id: key, key, label: node.label, href: nodeHref(node), icon: node.icon }];
    }),
    { id: "more", key: "more", label: "More", icon: Ellipsis, more: true },
];

/** Whether a root-level tab is active for `pathname`. */
export function isTabActive(tab: ShellTab, pathname: string): boolean {
    if (tab.more) return false;
    const node = nodeByKey(tab.key);
    if (!node) return false;
    if (node.kind === "leaf") return isLeafActive(node, pathname);
    return findActiveParent(pathname)?.key === node.key;
}

/** Nav-tree label for the current route (parent › leaf collapsed to the leaf). */
export function currentNavLabel(pathname: string): { key: string; label: string } | null {
    const parent = findActiveParent(pathname);
    if (parent) {
        const leaf = parent.children.find((c) => isLeafActive(c, pathname));
        if (leaf) return { key: leaf.key, label: leaf.label };
        return { key: parent.key, label: parent.label };
    }
    for (const n of navTree) {
        if (n.kind === "leaf" && isLeafActive(n, pathname)) return { key: n.key, label: n.label };
    }
    return null;
}
