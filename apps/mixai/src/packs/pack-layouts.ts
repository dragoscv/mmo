/**
 * Layouts contributed by installed packs, namespaced by pack id.
 *
 * A pack layout's own id ("festival-4") is only unique inside its pack. In the layout store it
 * becomes `<packId>/<layoutId>` ("ro.mixai.bundle.festival-pro/festival-4"): the "/" can never
 * appear in a built-in or user layout id (validateLayout only accepts a slug), so a pack can not
 * shadow a built-in, overwrite a user layout, or collide with another pack.
 */
import { validateLayout } from "../layout/solver.ts";
import { PANEL_IDS, type LayoutDoc } from "../layout/types.ts";

export interface PackLayoutSource {
    manifest: { id: string };
    layouts?: unknown[];
}

export const PACK_LAYOUT_SEP = "/";

export function packLayoutId(packId: string, layoutId: string): string {
    return `${packId}${PACK_LAYOUT_SEP}${layoutId}`;
}

export function isPackLayoutId(id: string): boolean {
    return id.includes(PACK_LAYOUT_SEP);
}

/** The pack-local part of a layout id (the id itself for built-in and user layouts). */
export function localLayoutId(id: string): string {
    const i = id.lastIndexOf(PACK_LAYOUT_SEP);
    return i < 0 ? id : id.slice(i + 1);
}

/** Valid layouts of every pack, with namespaced ids. Invalid layouts and duplicates are dropped. */
export function packLayouts(list: readonly PackLayoutSource[]): LayoutDoc[] {
    const out: LayoutDoc[] = [];
    const seen = new Set<string>();
    for (const p of list) {
        for (const raw of p.layouts ?? []) {
            if (validateLayout(raw, PANEL_IDS).length > 0) continue;
            const l = raw as LayoutDoc;
            const id = packLayoutId(p.manifest.id, l.id);
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ ...l, id });
        }
    }
    return out;
}

/**
 * Decks 1.3.0 stored pack layouts by their bare id. Map such a reference to the namespaced id when
 * it is not a built-in/user layout and exactly one pack layout carries that local id.
 */
export function remapLegacyRef(ref: string, ownIds: ReadonlySet<string>, pack: readonly LayoutDoc[]): string {
    if (isPackLayoutId(ref) || ownIds.has(ref)) return ref;
    const hits = pack.filter((l) => localLayoutId(l.id) === ref);
    return hits.length === 1 ? hits[0]!.id : ref;
}
