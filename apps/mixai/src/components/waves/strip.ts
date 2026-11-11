/**
 * Pre-rendered waveform of one deck layer: tiles of `TILE` columns, one column per device
 * pixel, each column the peak of the source points it covers. A frame only blits the visible
 * tiles (`drawImage`); a tile is drawn once, when it scrolls into view, and again only when
 * what it shows changes (track, zoom, lane size, colours, stem gains).
 *
 * Columns are numbered on the source: column `c` covers the time `[c, c + 1) / pxPerSec`, so a
 * tile never depends on the scroll position and the shape does not shimmer while it moves.
 */
import { columnPeak } from "./wave-math.ts";

/** Columns (device pixels along the time axis) per tile. */
export const TILE = 512;
/** Envelopes of one strip: three bands, or four stem sub-lanes. */
const MAX_PARTS = 4;

interface Tile {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    /** Tile number on the source it holds, -1 = nothing valid. */
    index: number;
}

export class WaveStrip {
    /** Ring of tiles: tile `i` of the source lives in slot `i % slots.length`. */
    private slots: (Tile | null)[] = [];
    private stale = true;
    private key: object | null = null;
    private pps = 0;
    private pxPerSec = 0;
    private thick = 0;
    private vertical = false;
    private count = 0;
    private n = 0;
    private len = 0;
    private lanes: (Uint8Array | null)[] = [null, null, null, null];
    private colors: string[] = ["", "", "", ""];
    private ks: number[] = [0, 0, 0, 0];
    private a0s: number[] = [0, 0, 0, 0];
    private a1s: number[] = [0, 0, 0, 0];
    private dirs: number[] = [0, 0, 0, 0];

    /** Tiles drawn since the strip was made (for the dev counters). */
    rendered = 0;

    /**
     * Start describing this frame's strip: `thick` device px on the amplitude axis, `pxPerSec`
     * columns per second. `key` = the wave object (its identity is the track).
     */
    begin(key: object, pps: number, pxPerSec: number, thick: number, vertical: boolean): void {
        if (this.key !== key || this.pps !== pps || this.pxPerSec !== pxPerSec || this.thick !== thick || this.vertical !== vertical) {
            this.key = key;
            this.pps = pps;
            this.pxPerSec = pxPerSec;
            this.thick = thick;
            this.vertical = vertical;
            this.stale = true;
        }
        this.n = 0;
        this.len = 0;
    }

    /**
     * One envelope: `lane` (0..255 per point) in `color`, `k` device px per unit, inside
     * `[a0, a1)` of the strip. `dir` 0 = mirrored around the middle of that range, -1 = grows
     * from `a1`, 1 = grows from `a0`.
     */
    part(lane: Uint8Array, color: string, k: number, a0: number, a1: number, dir: number): void {
        const i = this.n;
        if (i >= MAX_PARTS) return;
        this.n = i + 1;
        if (lane.length > this.len) this.len = lane.length;
        if (this.lanes[i] !== lane || this.colors[i] !== color || this.ks[i] !== k || this.a0s[i] !== a0 || this.a1s[i] !== a1 || this.dirs[i] !== dir) {
            this.lanes[i] = lane;
            this.colors[i] = color;
            this.ks[i] = k;
            this.a0s[i] = a0;
            this.a1s[i] = a1;
            this.dirs[i] = dir;
            this.stale = true;
        }
    }

    /**
     * Draw the source columns `[first, first + length)` from the start of the time axis of
     * `ctx`, the strip starting at `at` on the amplitude axis.
     */
    blit(ctx: CanvasRenderingContext2D, first: number, length: number, at: number): void {
        if (this.count !== this.n) {
            this.count = this.n;
            this.stale = true;
        }
        if (this.n === 0 || !(this.pxPerSec > 0) || !(length > 0) || !(this.thick >= 1)) return;
        const need = Math.ceil(length / TILE) + 2;
        if (this.slots.length !== need) {
            // The window grew or shrank (zoom, resize): new ring, old tiles are reused.
            const old = this.slots;
            this.slots = [];
            for (let i = 0; i < need; i++) this.slots.push(old[i] ?? null);
            this.stale = true;
        }
        if (this.stale) {
            this.stale = false;
            for (const t of this.slots) if (t) t.index = -1;
        }
        const lastColumn = Math.ceil((this.len / this.pps) * this.pxPerSec);
        const from = Math.max(0, Math.floor(first / TILE));
        const to = Math.min(Math.floor((first + length - 1) / TILE), Math.floor((lastColumn - 1) / TILE));
        for (let index = from; index <= to; index++) {
            const slot = index % need;
            let tile = this.slots[slot] ?? null;
            if (!tile) {
                const canvas = document.createElement("canvas");
                const c2d = canvas.getContext("2d");
                if (!c2d) return;
                tile = this.slots[slot] = { canvas, ctx: c2d, index: -1 };
            }
            if (tile.index !== index) this.render(tile, index);
            const along = index * TILE - first;
            if (this.vertical) ctx.drawImage(tile.canvas, at, along);
            else ctx.drawImage(tile.canvas, along, at);
        }
    }

    private render(tile: Tile, index: number): void {
        const { ctx, canvas } = tile;
        const vertical = this.vertical;
        const thick = this.thick;
        const w = vertical ? thick : TILE;
        const h = vertical ? TILE : thick;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        } else {
            ctx.clearRect(0, 0, w, h);
        }
        const pointsPerPx = this.pps / this.pxPerSec;
        const base = index * TILE;
        for (let p = 0; p < this.n; p++) {
            const lane = this.lanes[p]!;
            const k = this.ks[p]!;
            const a0 = this.a0s[p]!;
            const a1 = Math.min(thick, this.a1s[p]!);
            const dir = this.dirs[p]!;
            const room = dir === 0 ? (a1 - a0) / 2 : a1 - a0;
            const mid = (a0 + a1) / 2;
            let any = false;
            ctx.beginPath();
            for (let c = 0; c < TILE; c++) {
                let amp = columnPeak(lane, base + c, pointsPerPx) * k;
                if (amp > room) amp = room;
                let from: number;
                let to: number;
                if (dir === 0) {
                    from = Math.round(mid - amp);
                    to = Math.round(mid + amp);
                } else if (dir < 0) {
                    from = Math.round(a1 - amp);
                    to = a1;
                } else {
                    from = a0;
                    to = Math.round(a0 + amp);
                }
                if (to <= from) continue;
                any = true;
                if (vertical) ctx.rect(from, c, to - from, 1);
                else ctx.rect(c, from, 1, to - from);
            }
            if (!any) continue;
            ctx.fillStyle = this.colors[p]!;
            ctx.fill();
        }
        tile.index = index;
        this.rendered++;
    }
}
