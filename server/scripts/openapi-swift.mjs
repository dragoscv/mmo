#!/usr/bin/env node
// Emit Swift Codable models for the same curated subset of server/openapi.yaml
// component schemas that openapi-kotlin.mjs emits for the TV apps, so iOS/macOS
// (apps/ios/MixaiCore) and Android share one contract with matching type names.
//
// Output: apps/ios/MixaiCore/Sources/MixaiCore/Generated/Models.swift (committed).
// Re-run with `pnpm openapi:gen` (or `pnpm openapi:swift`) after editing the spec.
//
// Mapping (mirrors openapi-kotlin.mjs; differences are Swift-specific):
// - object schema            -> public struct X: Codable, Sendable, Hashable
// - free-form object         -> [String: JSONValue]   (Kotlin JsonObject)
// - oneOf with >1 non-null   -> JSONValue?            (Kotlin JsonElement?)
// - string enum (named/inline) -> public enum with an `unknown` catch-all (Kotlin keeps String)
// - integer -> Int (Int64 when format: int64), number -> Double, dates stay String
// - `Error` is emitted as `APIError` so it never shadows Swift.Error in importing code.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const repoRoot = resolve(serverRoot, "..");
const specPath = join(serverRoot, "openapi.yaml");
const outDir = join(repoRoot, "apps/ios/MixaiCore/Sources/MixaiCore/Generated");
const outFile = join(outDir, "Models.swift");

/** Roots to emit; keep identical to ROOTS in openapi-kotlin.mjs. */
const ROOTS = [
    "Health",
    "PairInfo",
    "PairRequest",
    "PairRequestResponse",
    "PairPollResponse",
    "PairApproveRequest",
    "PairApproveResponse",
    "PairPending",
    "VideoScanResult",
    "VideoFile",
    "VideoInfo",
    "SubtitleTrack",
    "SubtitleResult",
    "Track",
    "Playlist",
    "PreRemuxJob",
    "MediaStatus",
    "MediaEtag",
    "MediaHome",
    "HomeRow",
    "TitleCard",
    "TitleDetails",
    "MediaTitleResponse",
    "MediaSearchPage",
    "Availability",
    "Offer",
    "LaunchData",
    "LibraryIndex",
    "LibraryIndexRow",
    "ProgressInput",
    "ProgressEntry",
    "ProgressList",
    "TrackPlayInput",
    "TrackPlay",
    "ProviderCatalog",
    "MediaSeasonResponse",
    "Profile",
    "ProfileInput",
    "WatchlistEntry",
    "HubDevice",
    "HubAck",
    "HubRoom",
    "MusicHome",
    "ArtistPage",
    "ArtistDetail",
    "AlbumDetail",
    "MusicSearch",
    "MusicQueue",
    "MusicQueueInput",
    "Lyrics",
    "BeatGrid",
    "MediaStats",
    "LiveTvChannel",
    "LiveTvProgramme",
    "LiveTvRecording",
    "LiveTvSource",
    "Error",
];

/** Schema names that would collide with Swift standard library types. */
const RENAMES = { Error: "APIError" };

const spec = parse(readFileSync(specPath, "utf8"));
const schemas = spec.components?.schemas ?? {};

const refName = (ref) => ref.replace("#/components/schemas/", "");
const typeName = (schemaName) => RENAMES[schemaName] ?? schemaName;

/** Merge `allOf` members into one flat object schema (refs resolved one level). */
function flatten(schema) {
    if (!schema.allOf) return schema;
    const out = { type: "object", properties: {}, required: [], description: schema.description };
    for (const part of schema.allOf) {
        const resolved = part.$ref ? flatten(schemas[refName(part.$ref)]) : flatten(part);
        Object.assign(out.properties, resolved.properties ?? {});
        out.required.push(...(resolved.required ?? []));
    }
    return out;
}

/** JSON Schema `type` may be a string or an array (nullable unions). */
function baseType(schema) {
    const t = schema.type;
    if (Array.isArray(t)) {
        const nonNull = t.filter((x) => x !== "null");
        return { type: nonNull.length === 1 ? nonNull[0] : "any", nullable: t.includes("null") };
    }
    return { type: t, nullable: false };
}

// Same walk (and therefore same order) as openapi-kotlin.mjs.
const wanted = new Set();
const order = [];
function visit(name) {
    if (wanted.has(name)) return;
    if (!schemas[name]) throw new Error(`schema ${name} not found in openapi.yaml`);
    wanted.add(name);
    const raw = schemas[name];
    if (raw.type && raw.type !== "object" && !raw.properties && !raw.allOf) return;
    const flat = flatten(raw);
    for (const prop of Object.values(flat.properties ?? {})) visitProp(prop);
    order.push(name);
}
function visitProp(prop) {
    if (prop.$ref) return visit(refName(prop.$ref));
    if (prop.oneOf) return prop.oneOf.forEach(visitProp);
    if (prop.items) return visitProp(prop.items);
}
ROOTS.forEach(visit);

const SWIFT_KEYWORDS = new Set([
    "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import", "init",
    "inout", "internal", "let", "open", "operator", "private", "precedencegroup", "protocol", "public",
    "rethrows", "static", "struct", "subscript", "typealias", "var", "break", "case", "catch", "continue",
    "default", "defer", "do", "else", "fallthrough", "for", "guard", "if", "in", "repeat", "return",
    "throw", "switch", "where", "while", "as", "false", "is", "nil", "self", "Self", "super", "throws",
    "true", "try", "Any", "Type", "Protocol",
]);
const escapeKw = (name) => (SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name);
const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** camelCase Swift identifier for an arbitrary JSON key. */
function swiftIdent(key) {
    const parts = String(key)
        .replace(/\+/g, " plus ")
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
    if (parts.length === 0) return "value";
    const words = parts.map((p, i) => {
        // ALLCAPS tokens (DV, HDR10) read better lowercased than as dV / hDR10.
        const w = /^[A-Z0-9]+$/.test(p) && /[A-Z]/.test(p) ? p.toLowerCase() : p;
        return i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : upperFirst(w);
    });
    let id = words.join("");
    if (/^[0-9]/.test(id)) id = `_${id}`;
    return id;
}

// ---- enums ---------------------------------------------------------------

/** name -> { values, description } for every enum type the structs reference. */
const enums = new Map();
const schemaTypeNames = new Set(Object.keys(schemas).map(typeName));

function registerEnum(name, values, description) {
    const vals = values.filter((v) => v !== null).map(String);
    const existing = enums.get(name);
    if (existing) {
        if (JSON.stringify(existing.values) !== JSON.stringify(vals)) throw new Error(`enum ${name} registered twice with different values`);
        return name;
    }
    enums.set(name, { values: vals, description });
    return name;
}

function inlineEnumName(context) {
    let name = context;
    if (schemaTypeNames.has(name)) name = `${name}Enum`;
    return name;
}

// ---- types ---------------------------------------------------------------

const JSON_OBJECT = "[String: JSONValue]";

/** Swift type for a property schema; returns { type, nullable }. `context` names inline enums. */
function swiftType(prop, context) {
    if (prop.$ref) {
        const n = refName(prop.$ref);
        const target = schemas[n];
        if (target && target.type === "string" && !target.properties) {
            if (Array.isArray(target.enum)) return { type: registerEnum(typeName(n), target.enum, target.description), nullable: false };
            return { type: "String", nullable: false };
        }
        if (target && target.type === "object" && !target.properties && !target.allOf) return { type: JSON_OBJECT, nullable: false };
        if (target && target.type && target.type !== "object" && !target.properties && !target.allOf) return swiftType(target, typeName(n));
        return { type: typeName(n), nullable: false };
    }
    if (prop.oneOf) {
        const nonNull = prop.oneOf.filter((o) => o.type !== "null");
        const nullable = nonNull.length !== prop.oneOf.length;
        if (nonNull.length === 1) {
            const inner = swiftType(nonNull[0], context);
            return { ...inner, nullable: inner.nullable || nullable };
        }
        return { type: "JSONValue", nullable: true };
    }
    const { type, nullable } = baseType(prop);
    switch (type) {
        case "string":
            if (Array.isArray(prop.enum) && prop.enum.some((v) => v !== null)) {
                return { type: registerEnum(inlineEnumName(context), prop.enum, prop.description), nullable: nullable || prop.enum.includes(null) };
            }
            return { type: "String", nullable };
        case "boolean":
            return { type: "Bool", nullable };
        case "integer":
            return { type: prop.format === "int64" ? "Int64" : "Int", nullable };
        case "number":
            return { type: "Double", nullable };
        case "array": {
            const inner = prop.items ? swiftType(prop.items, `${context}Item`) : { type: "JSONValue" };
            const innerT = inner.nullable ? `${inner.type}?` : inner.type;
            return { type: `[${innerT}]`, nullable };
        }
        case "object":
            if (prop.additionalProperties && !prop.properties) {
                const v = typeof prop.additionalProperties === "object" ? swiftType(prop.additionalProperties, `${context}Value`) : { type: "JSONValue" };
                const vT = v.nullable && v.type !== "JSONValue" ? `${v.type}?` : v.type;
                return { type: `[String: ${vT}]`, nullable };
            }
            return { type: JSON_OBJECT, nullable };
        default:
            return { type: "JSONValue", nullable: true };
    }
}

const docLine = (indent, text) =>
    text ? [`${indent}/// ${String(text).replace(/\s+/g, " ").trim()}`] : [];

function emitStruct(name) {
    const swiftName = typeName(name);
    const flat = flatten(schemas[name]);
    const props = flat.properties ?? {};
    const required = new Set(flat.required ?? []);
    const lines = [...docLine("", flat.description)];
    const entries = Object.entries(props);
    lines.push(`public struct ${swiftName}: Codable, Sendable, Hashable {`);
    if (entries.length === 0) {
        lines.push("    public init() {}", "}");
        return lines.join("\n");
    }
    const fields = [];
    const used = new Set();
    for (const [jsonName, prop] of entries) {
        const st = swiftType(prop, `${swiftName}${upperFirst(swiftIdent(jsonName))}`);
        let id = swiftIdent(jsonName);
        while (used.has(id)) id = `${id}_`;
        used.add(id);
        const optional = !required.has(jsonName) || st.nullable;
        fields.push({ jsonName, id, type: optional ? `${st.type}?` : st.type, optional, description: prop.description });
    }
    for (const f of fields) {
        lines.push(...docLine("    ", f.description));
        lines.push(`    public let ${escapeKw(f.id)}: ${f.type}`);
    }
    if (fields.some((f) => f.id !== f.jsonName)) {
        lines.push("", "    enum CodingKeys: String, CodingKey {");
        for (const f of fields) {
            lines.push(f.id === f.jsonName ? `        case ${escapeKw(f.id)}` : `        case ${escapeKw(f.id)} = ${JSON.stringify(f.jsonName)}`);
        }
        lines.push("    }");
    }
    lines.push("");
    lines.push("    public init(");
    fields.forEach((f, i) => {
        const def = f.optional ? " = nil" : "";
        lines.push(`        ${escapeKw(f.id)}: ${f.type}${def}${i === fields.length - 1 ? "" : ","}`);
    });
    lines.push("    ) {");
    for (const f of fields) lines.push(`        self.${f.id} = ${escapeKw(f.id)}`);
    lines.push("    }", "}");
    return lines.join("\n");
}

function emitEnum(name, { values, description }) {
    const lines = [...docLine("", description)];
    lines.push(`public enum ${name}: String, Codable, Sendable, CaseIterable {`);
    const used = new Set();
    let hasUnknown = false;
    for (const v of values) {
        let id = swiftIdent(v);
        while (used.has(id)) id = `${id}_`;
        used.add(id);
        if (id === "unknown") hasUnknown = true;
        lines.push(id === v ? `    case ${escapeKw(id)}` : `    case ${escapeKw(id)} = ${JSON.stringify(v)}`);
    }
    if (!hasUnknown) {
        lines.push("    /// Any value this client does not know yet (newer server).");
        lines.push(used.has("unknown") ? "    case unknown = \"__unknown__\"" : "    case unknown");
    }
    lines.push("");
    lines.push("    public init(from decoder: any Decoder) throws {");
    lines.push("        let raw = try decoder.singleValueContainer().decode(String.self)");
    lines.push("        self = Self(rawValue: raw) ?? .unknown");
    lines.push("    }");
    lines.push("}");
    return lines.join("\n");
}

const JSON_VALUE = `/// Any JSON value; used where the spec allows free-form data (Kotlin: JsonElement / JsonObject).
public enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}`;

// Structs first (Kotlin order), which also registers every enum they reference.
const structs = order.map(emitStruct);
const enumBlocks = [...enums.keys()].sort().map((n) => emitEnum(n, enums.get(n)));

const header = `// GENERATED FILE — do not edit by hand.
// Source: server/openapi.yaml (info.version ${spec.info?.version}); generator: server/scripts/openapi-swift.mjs
// Regenerate with: pnpm --dir server openapi:gen
// swiftlint:disable all

import Foundation
`;

const out = [header, JSON_VALUE, ...structs, ...enumBlocks].join("\n\n") + "\n";
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, out.replace(/\r\n/g, "\n"), "utf8");
console.log(`wrote ${outFile} (${order.length} structs, ${enums.size} enums)`);
