import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient } from "./hub";

/** Minimal WebSocket double: records what the client sends, lets the test play the server. */
class FakeSocket {
    static last: FakeSocket | null = null;
    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) { FakeSocket.last = this; }
    send(text: string): void { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
    close(): void { this.readyState = 3; }
    open(): void { this.readyState = 1; this.onopen?.(); }
    server(msg: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
    cmds(): Array<Record<string, unknown>> { return this.sent.filter((m) => m.type === "cmd"); }
}

const cfg = { baseUrl: "http://srv.test:17899", token: "T", userId: "", scope: "" };

describe("HubClient.commandAwait", () => {
    let hub: HubClient;
    let sock: FakeSocket;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal("WebSocket", FakeSocket);
        hub = new HubClient(cfg, () => "p1", "1.0.0");
        hub.start();
        sock = FakeSocket.last!;
    });
    afterEach(() => {
        hub.stop();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("sends `cmd` to the target and resolves with that command's ack only", async () => {
        sock.open();
        const args = { trackIds: ["tr_1", "tr_2"], index: 1, positionSec: 12, shuffle: false, repeat: "all" };
        const pending = hub.commandAwait("tv-1", "play", args);
        const cmd = sock.cmds()[0]!;
        expect(cmd).toMatchObject({ type: "cmd", target: "tv-1", action: "play", args });
        expect(typeof cmd.seq).toBe("string");

        let settled = false;
        void pending.then(() => { settled = true; });
        sock.server({ type: "ack", seq: "someone-else", ok: true });
        await Promise.resolve();
        expect(settled).toBe(false);

        sock.server({ type: "ack", seq: cmd.seq, ok: false, error: "tracks_not_found", from: "tv-1" });
        await expect(pending).resolves.toEqual({ ok: false, seq: cmd.seq, error: "tracks_not_found", from: "tv-1" });
    });

    it("treats an ack without `ok:false` as success and stops listening afterwards", async () => {
        sock.open();
        const pending = hub.commandAwait("tv-1", "play", {});
        const seq = sock.cmds()[0]!.seq;
        sock.server({ type: "ack", seq, ok: true });
        await expect(pending).resolves.toEqual({ ok: true, seq });
        expect(hub.acks.size).toBe(0);
    });

    it("answers `timeout` when the device never acks", async () => {
        sock.open();
        const pending = hub.commandAwait("tv-1", "play", {}, 5_000);
        vi.advanceTimersByTime(4_999);
        let settled = false;
        void pending.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        vi.advanceTimersByTime(1);
        await expect(pending).resolves.toMatchObject({ ok: false, error: "timeout" });
        expect(hub.acks.size).toBe(0);
    });

    it("answers `offline` at once while the socket is not open, without sending", async () => {
        await expect(hub.commandAwait("tv-1", "play", {})).resolves.toMatchObject({ ok: false, error: "offline" });
        expect(sock.cmds()).toHaveLength(0);
        expect(hub.acks.size).toBe(0);
    });
});
