/**
 * Subsonic response envelope + XML/JSON serializers.
 *
 * JSON:  {"subsonic-response":{"status":"ok","version":"1.16.1", ...body}}
 * XML:   <subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1">…</subsonic-response>
 *
 * The XML serializer is intentionally tiny — Subsonic payloads are flat
 * trees where every scalar is an attribute, every object is a child
 * element and every array is a repeated child element. Text nodes are
 * only used for `value` keys (e.g. `<line start="0">text</line>`).
 */

import type express from "express";

export const SUBSONIC_API_VERSION = "1.16.1";
export const SUBSONIC_SERVER_TYPE = "MixAI MMO Server";

export type SubsonicFormat = "xml" | "json" | "jsonp";

export type Scalar = string | number | boolean | null | undefined;
export type Body = { [key: string]: Scalar | Body | Body[] | Scalar[] };

export class SubsonicError extends Error {
    constructor(public readonly code: number, message: string) {
        super(message);
        this.name = "SubsonicError";
    }
}

/** Standard Subsonic error codes. */
export const ERR = {
    GENERIC: 0,
    MISSING_PARAM: 10,
    CLIENT_TOO_OLD: 20,
    SERVER_TOO_OLD: 30,
    WRONG_CREDENTIALS: 40,
    TOKEN_AUTH_NOT_SUPPORTED: 41,
    AUTH_MECHANISM_NOT_SUPPORTED: 42,
    MULTIPLE_AUTH_MECHANISMS: 43,
    INVALID_API_KEY: 44,
    NOT_AUTHORIZED: 50,
    TRIAL_EXPIRED: 60,
    NOT_FOUND: 70,
} as const;

export interface EnvelopeMeta {
    serverVersion: string;
}

export function okEnvelope(body: Body, meta: EnvelopeMeta): Body {
    return {
        status: "ok",
        version: SUBSONIC_API_VERSION,
        type: SUBSONIC_SERVER_TYPE,
        serverVersion: meta.serverVersion,
        openSubsonic: true,
        ...body,
    };
}

export function failedEnvelope(code: number, message: string, meta: EnvelopeMeta): Body {
    return {
        status: "failed",
        version: SUBSONIC_API_VERSION,
        type: SUBSONIC_SERVER_TYPE,
        serverVersion: meta.serverVersion,
        openSubsonic: true,
        error: { code, message },
    };
}

export function parseFormat(f: unknown): SubsonicFormat {
    const v = typeof f === "string" ? f.toLowerCase() : "";
    if (v === "json") return "json";
    if (v === "jsonp") return "jsonp";
    return "xml";
}

// ─── JSON ────────────────────────────────────────────────────────────────────

function stripUndefined(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stripUndefined);
    if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (val === undefined || val === null) continue;
            out[k] = stripUndefined(val);
        }
        return out;
    }
    return v;
}

export function toJson(envelope: Body): string {
    return JSON.stringify({ "subsonic-response": stripUndefined(envelope) });
}

// ─── XML ─────────────────────────────────────────────────────────────────────

export function escapeXml(s: string): string {
    return s.replace(/[<>&"']/g, (ch) => (
        { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" } as Record<string, string>
    )[ch] as string)
        // Strip control chars XML 1.0 forbids (tags occasionally carry them).
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function isScalar(v: unknown): v is Scalar {
    return v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function xmlElement(name: string, value: Body | Scalar): string {
    if (isScalar(value)) {
        // Bare scalar in an array (e.g. genres list w/o attributes) → text node.
        if (value === null || value === undefined) return "";
        return `<${name}>${escapeXml(String(value))}</${name}>`;
    }
    const attrs: string[] = [];
    const children: string[] = [];
    let text: string | null = null;
    for (const [k, v] of Object.entries(value)) {
        if (v === undefined || v === null) continue;
        if (k === "value" && isScalar(v)) { text = String(v); continue; }
        if (isScalar(v)) {
            attrs.push(` ${k}="${escapeXml(String(v))}"`);
        } else if (Array.isArray(v)) {
            for (const item of v) children.push(xmlElement(k, item as Body | Scalar));
        } else {
            children.push(xmlElement(k, v));
        }
    }
    const inner = children.join("") + (text !== null ? escapeXml(text) : "");
    return inner.length > 0
        ? `<${name}${attrs.join("")}>${inner}</${name}>`
        : `<${name}${attrs.join("")}/>`;
}

export function toXml(envelope: Body): string {
    const withNs: Body = { xmlns: "http://subsonic.org/restapi", ...envelope };
    return `<?xml version="1.0" encoding="UTF-8"?>` + xmlElement("subsonic-response", withNs);
}

// ─── Express writer ──────────────────────────────────────────────────────────

export function sendEnvelope(res: express.Response, envelope: Body, format: SubsonicFormat, callback?: string): void {
    // Subsonic clients expect HTTP 200 for API-level errors — the status
    // lives in the envelope. Only transport failures use HTTP codes.
    if (format === "json") {
        res.status(200).type("application/json; charset=utf-8").send(toJson(envelope));
        return;
    }
    if (format === "jsonp") {
        const cb = callback && /^[A-Za-z_$][\w$.]*$/.test(callback) ? callback : "callback";
        res.status(200).type("application/javascript; charset=utf-8").send(`${cb}(${toJson(envelope)});`);
        return;
    }
    res.status(200).type("application/xml; charset=utf-8").send(toXml(envelope));
}
