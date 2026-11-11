/**
 * Optimistic "set and roll back" logic of the crossfader curve / assign controls (no React, no
 * store, no bridge: tested with `node --test`). The wiring to the real store and engine is in
 * `xfader-bridge.ts`.
 */
import type { DeckId, DeckState, MixerState } from "../../bridge/types.ts";

export type XfCurve = MixerState["crossfaderCurve"];
export type XfAssign = DeckState["crossfaderAssign"];

/** What the setters need from the outside (the real store + bridge, or fakes in tests). */
export interface XfPorts {
    getCurve: () => XfCurve;
    putCurve: (curve: XfCurve) => void;
    getAssign: (deck: DeckId) => XfAssign;
    putAssign: (deck: DeckId, assign: XfAssign) => void;
    sendCurve: (curve: XfCurve) => Promise<unknown>;
    sendAssign: (deck: DeckId, assign: XfAssign) => Promise<unknown>;
    /** Called once per kind of refusal ("curve" / "assign"), not once per click. */
    warn: (what: string, err: unknown) => void;
}

/**
 * The two setters over `ports`. Each patches the store at once, sends the command, and when the
 * engine refuses puts the previous value back, unless something newer (a later click, an engine
 * snapshot) already replaced the value it wrote. Resolves true = applied, false = rolled back.
 */
export function makeXfader(ports: XfPorts) {
    const warned = new Set<string>();
    const refuse = (what: string, err: unknown) => {
        if (warned.has(what)) return;
        warned.add(what);
        ports.warn(what, err);
    };
    return {
        async setCurve(curve: XfCurve): Promise<boolean> {
            const before = ports.getCurve();
            if (before === curve) return true;
            ports.putCurve(curve);
            try {
                await ports.sendCurve(curve);
                return true;
            } catch (err) {
                if (ports.getCurve() === curve) ports.putCurve(before);
                refuse("curve", err);
                return false;
            }
        },
        async setAssign(deck: DeckId, assign: XfAssign): Promise<boolean> {
            const before = ports.getAssign(deck);
            if (before === assign) return true;
            ports.putAssign(deck, assign);
            try {
                await ports.sendAssign(deck, assign);
                return true;
            } catch (err) {
                if (ports.getAssign(deck) === assign) ports.putAssign(deck, before);
                refuse("assign", err);
                return false;
            }
        },
    };
}
