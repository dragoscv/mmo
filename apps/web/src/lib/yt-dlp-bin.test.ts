/**
 * yt-dlp binary resolver tests.
 *
 * Locks the resolution precedence without hitting the network:
 *   - YT_DLP_PATH override wins and is returned verbatim (trimmed).
 *   - A system yt-dlp on PATH is used when the probe succeeds.
 *   - The result is memoised across calls.
 *
 * The download path (cold start, no system binary) is intentionally not
 * exercised here — it performs a real ~30 MB GitHub fetch and is covered
 * by the integration behaviour in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock child_process.spawn so the PATH probe is deterministic and never
// actually launches a process.
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

interface FakeProc {
    on: (event: string, cb: (arg?: unknown) => void) => FakeProc;
    kill: () => void;
}

/** Build a fake child process that emits `close` with the given exit code. */
function fakeProc(exitCode: number | null, emitError = false): FakeProc {
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    const proc: FakeProc = {
        on(event, cb) {
            (handlers[event] ??= []).push(cb);
            return proc;
        },
        kill() { /* no-op */ },
    };
    // Fire asynchronously to mimic a real spawn.
    setTimeout(() => {
        if (emitError) {
            handlers["error"]?.forEach((cb) => cb(new Error("ENOENT")));
            return;
        }
        handlers["close"]?.forEach((cb) => cb(exitCode));
    }, 0);
    return proc;
}

describe("resolveYtDlpBinary", () => {
    beforeEach(() => {
        spawnMock.mockReset();
        delete process.env.YT_DLP_PATH;
        delete process.env.YT_DLP_VERSION;
        vi.resetModules();
    });

    afterEach(() => {
        delete process.env.YT_DLP_PATH;
        delete process.env.YT_DLP_VERSION;
    });

    it("returns YT_DLP_PATH override verbatim (trimmed), without probing", async () => {
        process.env.YT_DLP_PATH = "  /opt/bin/yt-dlp  ";
        const { resolveYtDlpBinary, _resetYtDlpBinaryCache } = await import("./yt-dlp-bin");
        _resetYtDlpBinaryCache();

        const bin = await resolveYtDlpBinary();
        expect(bin).toBe("/opt/bin/yt-dlp");
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it("uses a system yt-dlp when the PATH probe succeeds", async () => {
        spawnMock.mockImplementation(() => fakeProc(0));
        const { resolveYtDlpBinary, _resetYtDlpBinaryCache } = await import("./yt-dlp-bin");
        _resetYtDlpBinaryCache();

        const bin = await resolveYtDlpBinary();
        expect(bin).toBe("yt-dlp");
        expect(spawnMock).toHaveBeenCalledWith("yt-dlp", ["--version"], expect.anything());
    });

    it("memoises the resolved binary across calls", async () => {
        spawnMock.mockImplementation(() => fakeProc(0));
        const { resolveYtDlpBinary, _resetYtDlpBinaryCache } = await import("./yt-dlp-bin");
        _resetYtDlpBinaryCache();

        const a = await resolveYtDlpBinary();
        const b = await resolveYtDlpBinary();
        expect(a).toBe(b);
        // Second call must not re-probe.
        expect(spawnMock).toHaveBeenCalledTimes(1);
    });
});
