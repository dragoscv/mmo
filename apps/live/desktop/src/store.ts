/**
 * App store: engine lifecycle (Rust commands) + protocol state (reducer) + UI panels.
 * Meters do NOT live here (see lib/meter-bus.ts).
 */
import { create } from "zustand";
import { EngineConnection } from "./lib/connection";
import { parseCatalogue, type FxSpec } from "./lib/params";
import { applyOptimistic, initialProtocol, reduce, trackPending, type ClientMsg, type ProtocolState } from "./lib/protocol";
import { api, isTauri, type EngineConfig, type Settings, type StartResult } from "./lib/tauri";

export type EngineStatus = "stopped" | "starting" | "connecting" | "running" | "reconnecting" | "error";
export type Panel = "setup" | "pair" | "settings" | null;

export interface Notice {
    id: number;
    kind: "error" | "success" | "info";
    key: string;
    vars?: Record<string, string | number>;
}

interface Store {
    status: EngineStatus;
    start: StartResult | null;
    engineError: string | null;
    proto: ProtocolState;
    catalogue: FxSpec[];
    catalogueError: boolean;
    settings: Settings;
    settingsLoaded: boolean;
    panel: Panel;
    selectedInsert: number | null;
    notices: Notice[];

    init(): Promise<void>;
    startEngine(config: EngineConfig): Promise<boolean>;
    stopEngine(): Promise<void>;
    setLan(lan: boolean): Promise<void>;
    send(msg: ClientMsg): void;
    /** Like `send`, but coalesces rapid updates with the same key (knob drags) to one per frame. */
    sendCoalesced(key: string, msg: ClientMsg): void;
    openPanel(p: Panel): void;
    selectInsert(id: number | null): void;
    notify(kind: Notice["kind"], key: string, vars?: Notice["vars"]): void;
    dismiss(id: number): void;
}

let conn: EngineConnection | null = null;
let noticeId = 1;
/** Stable empty arrays for selectors (a fresh `[]` per call makes zustand re-render forever). */
export const EMPTY_CHAIN: never[] = [];
const coalesced = new Map<string, ClientMsg>();
let flushTimer: number | undefined;

const DEFAULT_SETTINGS: Settings = { device: null, lastPreset: null, lan: false };

/** Engine error codes with a dedicated, localised message (`errors.code.<code>`); others show the raw message. */
const LOCALISED_CODES = new Set(["factory_preset", "unknown_binding", "unknown_preset"]);

export const useStore = create<Store>((set, get) => {
    const connect = (r: StartResult) => {
        conn?.close();
        set({ status: "connecting", proto: initialProtocol });
        conn = new EngineConnection(r.port, r.token, {
            onOpen: () => {
                set({ status: "running" });
                void loadCatalogue();
            },
            onClose: (retry) => {
                if (retry && get().start) set({ status: get().status === "running" ? "reconnecting" : get().status });
            },
            onMessage: (m) => {
                const before = get().proto;
                const proto = reduce(before, m);
                set({ proto });
                if (m.type === "error") {
                    if (LOCALISED_CODES.has(m.code)) get().notify(m.code === "factory_preset" ? "info" : "error", `errors.code.${m.code}`, { message: m.message });
                    else get().notify("error", "errors.command", { message: m.message });
                }
                if (m.type === "state" && proto.state && proto.state.preset !== get().settings.lastPreset) {
                    persist({ ...get().settings, lastPreset: proto.state.preset });
                }
            },
        });
        conn.start();
    };

    const loadCatalogue = async () => {
        try {
            set({ catalogue: parseCatalogue(await api.fxCatalogue()), catalogueError: false });
        } catch {
            set({ catalogueError: true });
        }
    };

    const persist = (s: Settings) => {
        set({ settings: s });
        void api.saveSettings(s).catch(() => {});
    };

    return {
        status: "stopped",
        start: null,
        engineError: null,
        proto: initialProtocol,
        catalogue: [],
        catalogueError: false,
        settings: DEFAULT_SETTINGS,
        settingsLoaded: false,
        panel: null,
        selectedInsert: null,
        notices: [],

        async init() {
            if (!isTauri()) {
                set({ settingsLoaded: true, panel: "setup" });
                get().notify("info", "errors.notTauri");
                return;
            }
            const settings = await api.loadSettings().catch(() => DEFAULT_SETTINGS);
            set({ settings, settingsLoaded: true });
            const st = await api.engineStatus().catch(() => null);
            if (st?.start) {
                set({ start: st.start });
                connect(st.start);
            } else if (settings.device) {
                const preset = settings.lastPreset ?? settings.device.preset;
                await get().startEngine({ ...settings.device, preset, lan: settings.lan });
            } else {
                set({ panel: "setup" });
            }
        },

        async startEngine(config) {
            set({ status: "starting", engineError: null });
            conn?.close();
            conn = null;
            try {
                const r = await api.startEngine(config);
                set({ start: r });
                persist({ ...get().settings, device: { ...config, lan: false }, lan: config.lan });
                connect(r);
                return true;
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                set({ status: "error", engineError: message, start: null });
                get().notify("error", "errors.start", { message });
                return false;
            }
        },

        async stopEngine() {
            conn?.close();
            conn = null;
            await api.stopEngine().catch(() => {});
            set({ status: "stopped", start: null, proto: initialProtocol });
        },

        async setLan(lan) {
            const device = get().settings.device;
            if (!device) return;
            const preset = get().proto.state?.preset ?? get().settings.lastPreset ?? device.preset;
            persist({ ...get().settings, lan });
            await get().startEngine({ ...device, preset, lan });
        },

        send(msg) {
            const id = conn?.send(msg) ?? null;
            if (id == null) return;
            const proto = trackPending(get().proto, id);
            set({ proto: { ...proto, state: applyOptimistic(proto.state, msg) } });
        },

        sendCoalesced(key, msg) {
            const proto = get().proto;
            set({ proto: { ...proto, state: applyOptimistic(proto.state, msg) } });
            coalesced.set(key, msg);
            if (flushTimer !== undefined) return;
            flushTimer = window.setTimeout(() => {
                flushTimer = undefined;
                const batch = [...coalesced.values()];
                coalesced.clear();
                for (const m of batch) {
                    const id = conn?.send(m) ?? null;
                    if (id != null) set({ proto: trackPending(get().proto, id) });
                }
            }, 33);
        },

        openPanel(panel) {
            set({ panel });
        },

        selectInsert(selectedInsert) {
            set({ selectedInsert });
        },

        notify(kind, key, vars) {
            const n: Notice = { id: noticeId++, kind, key, vars };
            set({ notices: [...get().notices.slice(-3), n] });
            window.setTimeout(() => get().dismiss(n.id), kind === "error" ? 8000 : 4000);
        },

        dismiss(id) {
            set({ notices: get().notices.filter((n) => n.id !== id) });
        },
    };
});

/** Wire Rust `engine://exit` events into the store (called once from main). */
export function handleEngineExit(message: string) {
    conn?.close();
    conn = null;
    useStore.setState({ status: "error", engineError: message, start: null });
    useStore.getState().notify("error", "errors.exited", { message });
}
