/**
 * Streaming XMLTV parser (no DOM, no dependency).
 *
 * A small tag scanner fed with text chunks: memory stays bounded by the
 * largest single element, so 50 MB+ guides parse without building a tree.
 * `loadXmltv` streams from http(s) or a local path and transparently gunzips
 * (gzip magic bytes, not just a `.gz` suffix).
 */

import fs from "node:fs";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { defaultFetch, HttpError, isHttpUrl, type FetchLike } from "./util";

export interface XmltvChannel {
    id: string;
    displayNames: string[];
    icon: string | null;
}

export interface XmltvProgramme {
    channel: string;
    start: number;
    stop: number;
    title: string;
    subtitle: string | null;
    description: string | null;
    category: string | null;
    episodeNum: string | null;
    icon: string | null;
}

export interface XmltvHandlers {
    onChannel?: (c: XmltvChannel) => void;
    onProgramme?: (p: XmltvProgramme) => void;
}

/**
 * XMLTV time → epoch ms. Accepts `YYYYMMDDhhmmss +HHMM`, `+HH:MM`, `Z`,
 * missing seconds/minutes, or no offset (treated as UTC).
 */
export function parseXmltvTime(s: string | undefined | null): number | null {
    if (!s) return null;
    const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-]\d{2}:?\d{2})?/i.exec(s);
    if (!m) return null;
    const [, y, mo, d, h = "0", mi = "0", se = "0", tz] = m;
    let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
    if (tz && tz.toUpperCase() !== "Z") {
        const sign = tz[0] === "-" ? -1 : 1;
        const digits = tz.slice(1).replace(":", "");
        const offMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
        ms -= sign * offMin * 60_000;
    }
    return Number.isFinite(ms) ? ms : null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

export function decodeEntities(s: string): string {
    if (s.indexOf("&") < 0) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
        if (ent[0] === "#") {
            const cp = ent[1] === "x" || ent[1] === "X" ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
            return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
        }
        return NAMED[ent.toLowerCase()] ?? whole;
    });
}

function parseTagAttrs(s: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? "");
    return out;
}

/** Index of the `>` closing a tag that starts at `from` (skips quoted attribute values), or -1. */
function tagEnd(buf: string, from: number): number {
    let quote = 0;
    for (let i = from; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (quote) { if (c === quote) quote = 0; continue; }
        if (c === 34 || c === 39) { quote = c; continue; }
        if (c === 62) return i;
    }
    return -1;
}

const CAPTURED = new Set(["display-name", "title", "sub-title", "desc", "category", "episode-num"]);

type Ctx =
    | { kind: "channel"; data: XmltvChannel }
    | { kind: "programme"; data: XmltvProgramme; episodeSystem: string | null; titleLang: boolean };

export class XmltvParser {
    private buf = "";
    private ctx: Ctx | null = null;
    private capture: { tag: string; text: string; attrs: Record<string, string> } | null = null;
    channels = 0;
    programmes = 0;

    constructor(private readonly handlers: XmltvHandlers) {}

    feed(chunk: string): void {
        this.buf += chunk;
        const buf = this.buf;
        let pos = 0;
        for (;;) {
            const lt = buf.indexOf("<", pos);
            if (lt < 0) {
                if (this.capture) this.capture.text += buf.slice(pos);
                pos = buf.length;
                break;
            }
            if (this.capture && lt > pos) this.capture.text += buf.slice(pos, lt);
            pos = lt;
            if (buf.startsWith("<!--", lt)) {
                const end = buf.indexOf("-->", lt + 4);
                if (end < 0) break;
                pos = end + 3;
                continue;
            }
            if (buf.startsWith("<![CDATA[", lt)) {
                const end = buf.indexOf("]]>", lt + 9);
                if (end < 0) break;
                if (this.capture) this.capture.text += buf.slice(lt + 9, end).replace(/&/g, "&amp;");
                pos = end + 3;
                continue;
            }
            if (lt + 1 >= buf.length) break;
            const gt = tagEnd(buf, lt + 1);
            if (gt < 0) break;
            this.tag(buf.slice(lt + 1, gt));
            pos = gt + 1;
        }
        this.buf = buf.slice(pos);
    }

    end(): void {
        this.buf = "";
        this.ctx = null;
        this.capture = null;
    }

    private tag(raw: string): void {
        const c0 = raw[0];
        if (c0 === "?" || c0 === "!") return;
        if (c0 === "/") { this.close(raw.slice(1).trim().toLowerCase()); return; }
        const selfClosing = raw.endsWith("/");
        const body = selfClosing ? raw.slice(0, -1) : raw;
        const sp = body.search(/\s/);
        const name = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
        const attrs = sp < 0 ? {} : parseTagAttrs(body.slice(sp + 1));
        if (name === "channel") {
            this.ctx = { kind: "channel", data: { id: attrs.id ?? "", displayNames: [], icon: null } };
            if (selfClosing) this.close("channel");
            return;
        }
        if (name === "programme") {
            const start = parseXmltvTime(attrs.start);
            const stop = parseXmltvTime(attrs.stop);
            this.ctx = {
                kind: "programme",
                episodeSystem: null,
                titleLang: false,
                data: {
                    channel: attrs.channel ?? "",
                    start: start ?? Number.NaN,
                    // Missing stop is legal in XMLTV; assume one hour (service trims to the next start).
                    stop: stop ?? (start !== null ? start + 3_600_000 : Number.NaN),
                    title: "", subtitle: null, description: null, category: null, episodeNum: null, icon: null,
                },
            };
            if (selfClosing) this.close("programme");
            return;
        }
        if (!this.ctx) return;
        if (name === "icon") {
            if (attrs.src && !this.ctx.data.icon) this.ctx.data.icon = attrs.src;
            return;
        }
        if (CAPTURED.has(name) && !selfClosing) this.capture = { tag: name, text: "", attrs };
    }

    private close(name: string): void {
        if (this.capture && this.capture.tag === name) {
            this.applyCapture(this.capture.tag, decodeEntities(this.capture.text).trim(), this.capture.attrs);
            this.capture = null;
            return;
        }
        if (name === "channel" && this.ctx?.kind === "channel") {
            const c = this.ctx.data;
            this.ctx = null;
            if (c.id) { this.channels++; this.handlers.onChannel?.(c); }
            return;
        }
        if (name === "programme" && this.ctx?.kind === "programme") {
            const p = this.ctx.data;
            this.ctx = null;
            if (p.channel && Number.isFinite(p.start) && Number.isFinite(p.stop) && p.stop > p.start) {
                if (!p.title) p.title = "—";
                this.programmes++;
                this.handlers.onProgramme?.(p);
            }
        }
    }

    private applyCapture(tag: string, text: string, attrs: Record<string, string>): void {
        const ctx = this.ctx;
        if (!ctx || !text) return;
        if (ctx.kind === "channel") {
            if (tag === "display-name") ctx.data.displayNames.push(text);
            return;
        }
        const p = ctx.data;
        switch (tag) {
            case "title":
                if (!p.title) p.title = text;
                break;
            case "sub-title":
                p.subtitle ??= text;
                break;
            case "desc":
                p.description ??= text;
                break;
            case "category":
                p.category ??= text;
                break;
            case "episode-num": {
                // Prefer the human `onscreen` form; else keep the first one.
                const system = attrs.system ?? null;
                if (!p.episodeNum || (system === "onscreen" && ctx.episodeSystem !== "onscreen")) {
                    p.episodeNum = text;
                    ctx.episodeSystem = system;
                }
                break;
            }
        }
    }
}

/** Parse a full XMLTV document from a string (tests, small files). */
export function parseXmltv(text: string): { channels: XmltvChannel[]; programmes: XmltvProgramme[] } {
    const channels: XmltvChannel[] = [];
    const programmes: XmltvProgramme[] = [];
    const p = new XmltvParser({ onChannel: (c) => channels.push(c), onProgramme: (x) => programmes.push(x) });
    p.feed(text);
    p.end();
    return { channels, programmes };
}

async function* openBytes(location: string, fetchImpl: FetchLike, signal: AbortSignal): AsyncGenerator<Buffer> {
    if (isHttpUrl(location)) {
        const res = await fetchImpl(location, { signal, headers: { "accept-encoding": "gzip" } });
        if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
        if (!res.body) return;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) yield Buffer.from(chunk);
        return;
    }
    const stream = fs.createReadStream(location.replace(/^file:\/\//i, ""));
    for await (const chunk of stream) yield chunk as Buffer;
}

async function* gunzipIfNeeded(src: AsyncGenerator<Buffer>): AsyncGenerator<Buffer> {
    const first = await src.next();
    if (first.done) return;
    const head = first.value;
    const all = (async function* () { yield head; yield* src; })();
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
        const gunzip = Readable.from(all).pipe(zlib.createGunzip());
        for await (const chunk of gunzip) yield chunk as Buffer;
        return;
    }
    yield* all;
}

export interface LoadXmltvResult { channels: number; programmes: number; bytes: number }

/**
 * Stream-parse an XMLTV url or path. Handlers run synchronously per element,
 * so callers can batch inserts. Timeout covers the whole download.
 */
export async function loadXmltv(
    location: string,
    handlers: XmltvHandlers,
    opts: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<LoadXmltvResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 5 * 60_000);
    timer.unref?.();
    const parser = new XmltvParser(handlers);
    let bytes = 0;
    let decoder: TextDecoder | null = null;
    try {
        for await (const chunk of gunzipIfNeeded(openBytes(location, opts.fetch ?? defaultFetch, ac.signal))) {
            if (!decoder) {
                const prolog = chunk.subarray(0, 200).toString("latin1");
                const enc = /encoding\s*=\s*["']([^"']+)["']/i.exec(prolog)?.[1]?.toLowerCase();
                decoder = new TextDecoder(enc === "iso-8859-1" || enc === "latin1" || enc === "windows-1252" ? "latin1" : "utf-8");
            }
            bytes += chunk.length;
            parser.feed(decoder.decode(chunk, { stream: true }));
        }
        if (decoder) parser.feed(decoder.decode());
        parser.end();
        return { channels: parser.channels, programmes: parser.programmes, bytes };
    } catch (err) {
        if (ac.signal.aborted) throw new Error("XMLTV download timed out");
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
