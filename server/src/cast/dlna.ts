/**
 * DLNA / UPnP MediaRenderer control — dependency-free.
 *
 * Discovery: SSDP M-SEARCH for `urn:schemas-upnp-org:device:MediaRenderer:1`
 * over UDP multicast (239.255.255.250:1900), 3 s window, 60 s cache.
 * Each LOCATION is fetched and parsed for friendlyName / UDN / the
 * AVTransport service controlURL.
 *
 * Control: SOAP 1.1 POSTs to the AVTransport controlURL —
 * SetAVTransportURI, Play, Pause, Stop, Seek, GetPositionInfo,
 * GetTransportInfo. Metadata is a minimal DIDL-Lite document.
 *
 * `upnp-client-ts` (last published 2023-12) was evaluated and rejected as
 * unmaintained; the protocol surface needed here is ~200 lines.
 *
 * Pure helpers (parseSsdpResponse, parseDeviceDescription, buildDidlLite,
 * buildSoapEnvelope) are exported for unit tests — no network involved.
 */

import dgram from "node:dgram";

export const SSDP_ADDR = "239.255.255.250";
export const SSDP_PORT = 1900;
export const MEDIA_RENDERER_ST = "urn:schemas-upnp-org:device:MediaRenderer:1";
const AVTRANSPORT_SERVICE_PREFIX = "urn:schemas-upnp-org:service:AVTransport:";
const AVTRANSPORT_URN = "urn:schemas-upnp-org:service:AVTransport:1";

const DISCOVERY_WINDOW_MS = 3_000;
const CACHE_TTL_MS = 60_000;

export interface DlnaRenderer {
    /** UDN without the `uuid:` prefix. */
    udn: string;
    friendlyName: string;
    manufacturer?: string;
    modelName?: string;
    /** Absolute URL of the AVTransport control endpoint. */
    controlUrl: string;
    /** Device description URL (LOCATION header). */
    location: string;
}

export interface SsdpResponse {
    location: string;
    st?: string;
    usn?: string;
}

// ─── Pure parsers ────────────────────────────────────────────────────────────

/** Parse an SSDP HTTP-over-UDP response into its useful headers. Returns
 *  null when there is no LOCATION header or the status line is not 200. */
export function parseSsdpResponse(raw: string): SsdpResponse | null {
    const lines = raw.split(/\r?\n/);
    const status = lines[0] ?? "";
    if (!/^HTTP\/1\.[01]\s+200\b/i.test(status)) return null;
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    if (!headers.location) return null;
    return { location: headers.location, st: headers.st, usn: headers.usn };
}

function xmlText(xml: string, tag: string): string | undefined {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "i").exec(xml);
    return m ? decodeXml(m[1].trim()) : undefined;
}

function decodeXml(s: string): string {
    return s
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
        .replace(/&amp;/g, "&");
}

export function escapeXml(s: string): string {
    return s
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Parse a UPnP device description document. Returns null when the device
 *  exposes no AVTransport service (not a renderer we can drive). URLs are
 *  resolved against `URLBase` when present, else the description URL. */
export function parseDeviceDescription(xml: string, location: string): DlnaRenderer | null {
    // First <device> block that has an AVTransport service. Embedded devices
    // are rare for renderers but handled by scanning every <service>.
    const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => m[1]);
    const av = services.find((s) => (xmlText(s, "serviceType") ?? "").startsWith(AVTRANSPORT_SERVICE_PREFIX));
    if (!av) return null;
    const controlPath = xmlText(av, "controlURL");
    if (!controlPath) return null;
    const base = xmlText(xml, "URLBase") || location;
    let controlUrl: string;
    try { controlUrl = new URL(controlPath, base).toString(); } catch { return null; }
    const udnRaw = xmlText(xml, "UDN") ?? "";
    const udn = udnRaw.replace(/^uuid:/i, "");
    if (!udn) return null;
    return {
        udn,
        friendlyName: xmlText(xml, "friendlyName") || udn,
        manufacturer: xmlText(xml, "manufacturer"),
        modelName: xmlText(xml, "modelName"),
        controlUrl,
        location,
    };
}

export interface DidlOptions {
    title: string;
    mime: string;
    /** "video" | "audio" — picks the upnp:class. */
    kind?: "video" | "audio";
    subtitleUrl?: string;
    thumb?: string;
}

/** Minimal DIDL-Lite metadata document accepted by every renderer tested
 *  (Samsung Tizen, LG webOS, Kodi, gmrender). */
export function buildDidlLite(url: string, opts: DidlOptions): string {
    const kind = opts.kind ?? (opts.mime.startsWith("audio/") ? "audio" : "video");
    const upnpClass = kind === "audio" ? "object.item.audioItem.musicTrack" : "object.item.videoItem.movie";
    const subs = opts.subtitleUrl
        ? `<res protocolInfo="http-get:*:text/vtt:*">${escapeXml(opts.subtitleUrl)}</res>` +
          `<sec:CaptionInfoEx sec:type="vtt">${escapeXml(opts.subtitleUrl)}</sec:CaptionInfoEx>`
        : "";
    const thumb = opts.thumb ? `<upnp:albumArtURI>${escapeXml(opts.thumb)}</upnp:albumArtURI>` : "";
    return (
        `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
        `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
        `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ` +
        `xmlns:sec="http://www.sec.co.kr/">` +
        `<item id="0" parentID="-1" restricted="1">` +
        `<dc:title>${escapeXml(opts.title)}</dc:title>` +
        `<upnp:class>${upnpClass}</upnp:class>` +
        thumb +
        `<res protocolInfo="http-get:*:${escapeXml(opts.mime)}:*">${escapeXml(url)}</res>` +
        subs +
        `</item></DIDL-Lite>`
    );
}

export function buildSoapEnvelope(action: string, args: Record<string, string | number>): string {
    const body = Object.entries(args)
        .map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`)
        .join("");
    return (
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
        `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
        `<s:Body><u:${action} xmlns:u="${AVTRANSPORT_URN}">` +
        `<InstanceID>0</InstanceID>${body}` +
        `</u:${action}></s:Body></s:Envelope>`
    );
}

/** Extract `<Tag>value</Tag>` pairs from a SOAP response body. */
export function parseSoapResponse(xml: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of xml.matchAll(/<([A-Za-z][\w]*)>([^<]*)<\/\1>/g)) {
        out[m[1]] = decodeXml(m[2]);
    }
    return out;
}

/** "H:MM:SS" → seconds; returns null on NOT_IMPLEMENTED or garbage. */
export function parseUpnpTime(s: string | undefined): number | null {
    if (!s) return null;
    const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/.exec(s.trim());
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function formatUpnpTime(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

let cache: { at: number; renderers: DlnaRenderer[] } | null = null;
let inflight: Promise<DlnaRenderer[]> | null = null;

async function ssdpSearch(windowMs: number): Promise<string[]> {
    return new Promise((resolve) => {
        const locations = new Set<string>();
        const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const msg = Buffer.from(
            `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\n` +
            `MX: 2\r\nST: ${MEDIA_RENDERER_ST}\r\n\r\n`,
        );
        const finish = () => {
            try { sock.close(); } catch { /* already closed */ }
            resolve([...locations]);
        };
        sock.on("error", finish);
        sock.on("message", (buf) => {
            const parsed = parseSsdpResponse(buf.toString("utf8"));
            if (parsed) locations.add(parsed.location);
        });
        sock.bind(0, () => {
            try { sock.setBroadcast(true); } catch { /* ignore */ }
            // Send twice — UDP multicast on Wi-Fi drops the first packet often.
            sock.send(msg, SSDP_PORT, SSDP_ADDR);
            setTimeout(() => { try { sock.send(msg, SSDP_PORT, SSDP_ADDR); } catch { /* closed */ } }, 400);
            setTimeout(finish, windowMs);
        });
    });
}

async function fetchDescription(location: string): Promise<DlnaRenderer | null> {
    try {
        const res = await fetch(location, { signal: AbortSignal.timeout(3_000) });
        if (!res.ok) return null;
        return parseDeviceDescription(await res.text(), location);
    } catch {
        return null;
    }
}

export async function discoverRenderers(force = false): Promise<DlnaRenderer[]> {
    if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.renderers;
    if (inflight) return inflight;
    inflight = (async () => {
        const locations = await ssdpSearch(DISCOVERY_WINDOW_MS);
        const described = await Promise.all(locations.map(fetchDescription));
        const byUdn = new Map<string, DlnaRenderer>();
        for (const r of described) if (r) byUdn.set(r.udn, r);
        const renderers = [...byUdn.values()].sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
        cache = { at: Date.now(), renderers };
        inflight = null;
        return renderers;
    })();
    return inflight;
}

async function findRenderer(udn: string): Promise<DlnaRenderer> {
    const cached = (await discoverRenderers()).find((r) => r.udn === udn);
    if (cached) return cached;
    const fresh = (await discoverRenderers(true)).find((r) => r.udn === udn);
    if (!fresh) throw new Error(`DLNA renderer ${udn} not found on the LAN`);
    return fresh;
}

// ─── SOAP control ────────────────────────────────────────────────────────────

async function soap(r: DlnaRenderer, action: string, args: Record<string, string | number> = {}): Promise<Record<string, string>> {
    const res = await fetch(r.controlUrl, {
        method: "POST",
        headers: {
            "Content-Type": "text/xml; charset=\"utf-8\"",
            SOAPACTION: `"${AVTRANSPORT_URN}#${action}"`,
        },
        body: buildSoapEnvelope(action, args),
        signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text();
    if (!res.ok) {
        const err = parseSoapResponse(text);
        throw new Error(`DLNA ${action} failed (${res.status})${err.errorDescription ? ": " + err.errorDescription : ""}`);
    }
    return parseSoapResponse(text);
}

export interface DlnaPlayOptions {
    title: string;
    mime: string;
    kind?: "video" | "audio";
    subtitleUrl?: string;
    thumb?: string;
    startSec?: number;
}

export async function play(udn: string, mediaUrl: string, opts: DlnaPlayOptions): Promise<void> {
    const r = await findRenderer(udn);
    // Some renderers reject SetAVTransportURI while PLAYING; a Stop first is harmless.
    await soap(r, "Stop").catch(() => undefined);
    await soap(r, "SetAVTransportURI", {
        CurrentURI: mediaUrl,
        CurrentURIMetaData: buildDidlLite(mediaUrl, opts),
    });
    await soap(r, "Play", { Speed: "1" });
    if (opts.startSec && opts.startSec > 2) {
        // Seek only works once the renderer has actually started; give it a moment.
        await new Promise((res) => setTimeout(res, 1_200));
        await soap(r, "Seek", { Unit: "REL_TIME", Target: formatUpnpTime(opts.startSec) }).catch(() => undefined);
    }
}

export async function pause(udn: string): Promise<void> { await soap(await findRenderer(udn), "Pause"); }
export async function resume(udn: string): Promise<void> { await soap(await findRenderer(udn), "Play", { Speed: "1" }); }
export async function stop(udn: string): Promise<void> { await soap(await findRenderer(udn), "Stop"); }
export async function seek(udn: string, sec: number): Promise<void> {
    await soap(await findRenderer(udn), "Seek", { Unit: "REL_TIME", Target: formatUpnpTime(sec) });
}

export interface DlnaStatus {
    state: string;
    positionSec: number | null;
    durationSec: number | null;
    uri: string | null;
}

export async function status(udn: string): Promise<DlnaStatus> {
    const r = await findRenderer(udn);
    const [pos, tr] = await Promise.all([
        soap(r, "GetPositionInfo"),
        soap(r, "GetTransportInfo").catch(() => ({} as Record<string, string>)),
    ]);
    return {
        state: (tr.CurrentTransportState ?? "UNKNOWN").toLowerCase(),
        positionSec: parseUpnpTime(pos.RelTime),
        durationSec: parseUpnpTime(pos.TrackDuration),
        uri: pos.TrackURI || null,
    };
}
