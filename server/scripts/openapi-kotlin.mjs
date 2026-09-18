#!/usr/bin/env node
// Emit kotlinx.serialization data classes for a curated subset of
// server/openapi.yaml component schemas — the ones the TV apps consume.
//
// No Gradle plugin: the output is committed as plain Kotlin under
// apps/tv-android/app/src/main/java/ro/mixai/tv/data/generated/Models.kt so the
// Android build stays a pure `assembleDebug` with nothing extra to install.
// Re-run with `pnpm openapi:gen` after editing the spec.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const repoRoot = resolve(serverRoot, "..");
const specPath = join(serverRoot, "openapi.yaml");
const outDir = join(repoRoot, "apps/tv-android/app/src/main/java/ro/mixai/tv/data/generated");
const outFile = join(outDir, "Models.kt");
const PACKAGE = "ro.mixai.tv.data.generated";

/** Roots to emit; every `$ref` they reach is emitted too. */
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
    "Error",
];

const spec = parse(readFileSync(specPath, "utf8"));
const schemas = spec.components?.schemas ?? {};

const refName = (ref) => ref.replace("#/components/schemas/", "");

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

const wanted = new Set();
const order = [];
function visit(name) {
    if (wanted.has(name)) return;
    if (!schemas[name]) throw new Error(`schema ${name} not found in openapi.yaml`);
    wanted.add(name);
    const raw = schemas[name];
    // Primitive aliases (string enums etc.) are inlined as their Kotlin primitive.
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

const KEYWORDS = new Set(["object", "val", "var", "fun", "class", "in", "is", "as", "when", "typealias", "interface", "package"]);
const ident = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name) ? name : null);
const camel = (name) => name.replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase());

/** Kotlin type for a property schema; returns { type, nullable, default }. */
function kotlinType(prop) {
    if (prop.$ref) {
        const n = refName(prop.$ref);
        const target = schemas[n];
        if (target && target.type === "string" && !target.properties) return { type: "String", default: '""' }; // string enums as String
        if (target && target.type === "object" && !target.properties && !target.allOf) return { type: "JsonObject", default: "JsonObject(emptyMap())" };
        return { type: n, default: `${n}()` };
    }
    if (prop.oneOf) {
        const nonNull = prop.oneOf.filter((o) => o.type !== "null");
        const nullable = nonNull.length !== prop.oneOf.length;
        if (nonNull.length === 1) {
            const inner = kotlinType(nonNull[0]);
            return { ...inner, nullable: inner.nullable || nullable };
        }
        return { type: "JsonElement", nullable: true, default: "null" };
    }
    const { type, nullable } = baseType(prop);
    switch (type) {
        case "string":
            return { type: "String", nullable, default: '""' };
        case "boolean":
            return { type: "Boolean", nullable, default: "false" };
        case "integer":
            // epoch-ms and byte counts overflow Int; Long is always safe for JSON integers here.
            return { type: "Long", nullable, default: "0L" };
        case "number":
            return { type: "Double", nullable, default: "0.0" };
        case "array": {
            const inner = prop.items ? kotlinType(prop.items) : { type: "JsonElement" };
            const innerT = inner.nullable ? `${inner.type}?` : inner.type;
            return { type: `List<${innerT}>`, nullable, default: "emptyList()" };
        }
        case "object":
            if (prop.additionalProperties && !prop.properties) {
                const v = typeof prop.additionalProperties === "object" ? kotlinType(prop.additionalProperties) : { type: "JsonElement" };
                return { type: `Map<String, ${v.type}>`, nullable, default: "emptyMap()" };
            }
            return { type: "JsonObject", nullable, default: "JsonObject(emptyMap())" };
        default:
            return { type: "JsonElement", nullable: true, default: "null" };
    }
}

function emitClass(name) {
    const flat = flatten(schemas[name]);
    const props = flat.properties ?? {};
    const required = new Set(flat.required ?? []);
    const lines = [];
    if (flat.description) lines.push(`/** ${String(flat.description).replace(/\s+/g, " ").replace(/\*\//g, "* /").trim()} */`);
    lines.push("@Serializable");
    const entries = Object.entries(props);
    if (entries.length === 0) {
        lines.push(`class ${name}`);
        return lines.join("\n");
    }
    lines.push(`data class ${name}(`);
    for (const [jsonName, prop] of entries) {
        const kt = kotlinType(prop);
        const field = ident(jsonName) ?? (camel(jsonName.replace(/^[^A-Za-z_]+/, "")) || "value");
        const ann = field !== jsonName ? `@SerialName("${jsonName}") ` : "";
        // Optional or nullable → nullable with null default (server may omit it).
        const optional = !required.has(jsonName) || kt.nullable;
        const type = optional ? `${kt.type}?` : kt.type;
        const def = optional ? " = null" : kt.default ? ` = ${kt.default}` : "";
        lines.push(`    ${ann}val ${field}: ${type}${def},`);
    }
    lines.push(")");
    return lines.join("\n");
}

const body = order.map(emitClass).join("\n\n");
const header = `// GENERATED FILE — do not edit by hand.
// Source: server/openapi.yaml (info.version ${spec.info?.version}); generator: server/scripts/openapi-kotlin.mjs
// Regenerate with: pnpm --dir server openapi:gen
@file:Suppress("unused")

package ${PACKAGE}

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, header + body + "\n", "utf8");
console.log(`wrote ${outFile} (${order.length} classes: ${order.join(", ")})`);
