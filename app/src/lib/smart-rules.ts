/**
 * Smart-playlist rule engine — Batch 40.
 *
 * Four authoring modes, one execution path:
 *
 *   builder → AND/OR tree of leaf conditions
 *   sql     → mini WHERE expression (`bpm BETWEEN 120 AND 130 AND genre IN ('techno','tech-house')`)
 *   graph   → linear node pipeline (filter → sort → limit)
 *   ai      → natural-language prompt; carries pre-compiled rules
 *
 * Each mode compiles down to a single `EvaluatedRules` object that the
 * runtime applies in-memory against the user's library. The compilers
 * are intentionally pure + dependency-free (no DB, no I/O) so they're
 * easy to unit-test and safe to call from server actions, the
 * companion, or a future Web Worker preview.
 *
 * Why in-memory instead of generating SQL? The library lives in two
 * places (Postgres in the cloud, SQLite in the companion) and the
 * search surface is small (a few hundred to ~50k tracks). Filtering in
 * JS keeps the engine portable and the security surface tiny — no
 * SQL-injection class of bug from user-authored "queries".
 */

import { z } from "zod";

// ─── Domain: track shape we filter against ──────────────────────────
//
// We accept a structurally-typed Track here so this module doesn't
// need to import the heavy Drizzle inferred types (which would pull in
// pg-core at compile time on the client). Anywhere we need a real
// Track row, the caller adapts via a single `pick`.

export interface FilterableTrack {
    id: number;
    bpm?: number | null;
    energy?: number | null;
    rating?: number | null;
    isFavorite?: boolean | null;
    genre?: string | null;
    subgenre?: string | null;
    mood?: string | null;
    keyCamelot?: string | null;
    keyMusical?: string | null;
    artist?: string | null;
    title?: string | null;
    album?: string | null;
    label?: string | null;
    duration?: number | null; // seconds
    year?: number | null;
    addedAt?: string | Date | null;
    loudnessLufs?: number | null;
}

// ─── Leaf condition: one field × one operator × one value ───────────

const FIELDS = [
    "id",
    "bpm", "energy", "rating", "isFavorite",
    "genre", "subgenre", "mood",
    "keyCamelot", "keyMusical",
    "artist", "title", "album", "label",
    "duration", "year", "addedAt", "loudnessLufs",
] as const;

export type Field = (typeof FIELDS)[number];

const OPERATORS = [
    "eq", "neq",
    "lt", "lte", "gt", "gte",
    "between",
    "in", "notIn",
    "contains", "startsWith", "endsWith",
    "isSet", "isNotSet",
    "withinDays",
] as const;

export type Operator = (typeof OPERATORS)[number];

// ─── Zod schemas ────────────────────────────────────────────────────

// Cap each leaf's value size so a malicious or buggy editor can't
// commit a 100MB rules blob to the DB.
const MAX_VALUE_LEN = 200;
const MAX_VALUE_COUNT = 50;
const MAX_GROUP_DEPTH = 6;
const MAX_GROUP_BREADTH = 32;

const leafValueSchema = z.union([
    z.string().max(MAX_VALUE_LEN),
    z.number().finite(),
    z.boolean(),
    z.array(z.union([z.string().max(MAX_VALUE_LEN), z.number().finite()])).max(MAX_VALUE_COUNT),
    z.tuple([z.number().finite(), z.number().finite()]),
]);

export const conditionSchema = z.object({
    type: z.literal("condition"),
    field: z.enum(FIELDS),
    operator: z.enum(OPERATORS),
    value: leafValueSchema.optional(),
});

export type Condition = z.infer<typeof conditionSchema>;

// Recursive group schema — we type this manually then assert into the
// inferred recursive type to keep zod's inference happy.
export interface Group {
    type: "group";
    combinator: "and" | "or";
    children: Array<Condition | Group>;
}

export const groupSchema: z.ZodType<Group> = z.lazy(() =>
    z.object({
        type: z.literal("group"),
        combinator: z.enum(["and", "or"]),
        children: z.array(z.union([conditionSchema, groupSchema])).min(1).max(MAX_GROUP_BREADTH),
    }),
);

const sortSchema = z.object({
    field: z.enum(FIELDS),
    direction: z.enum(["asc", "desc"]).default("asc"),
}).strict();

const limitSchema = z.number().int().min(1).max(10_000);

// Builder mode — a group tree + optional sort/limit.
export const builderRulesSchema = z.object({
    kind: z.literal("builder"),
    root: groupSchema,
    sort: sortSchema.optional(),
    limit: limitSchema.optional(),
}).strict();

// SQL mode — a single mini WHERE expression. The parser lives below.
export const sqlRulesSchema = z.object({
    kind: z.literal("sql"),
    query: z.string().min(1).max(4_000),
    sort: sortSchema.optional(),
    limit: limitSchema.optional(),
}).strict();

// Graph mode — linear pipeline of filter/sort/limit nodes. Visual
// editor lands later; for now the IR is the contract.
const graphNodeSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("filter"),
        id: z.string().min(1).max(64),
        condition: z.union([conditionSchema, groupSchema]),
    }),
    z.object({
        kind: z.literal("sort"),
        id: z.string().min(1).max(64),
        sort: sortSchema,
    }),
    z.object({
        kind: z.literal("limit"),
        id: z.string().min(1).max(64),
        limit: limitSchema,
    }),
]);

export const graphRulesSchema = z.object({
    kind: z.literal("graph"),
    nodes: z.array(graphNodeSchema).min(1).max(64),
}).strict();

// AI mode — stores the user's prompt + the compiled rules the LLM
// produced (so we can re-evaluate without paying for another inference).
// The compiled portion reuses the builder shape.
export const aiRulesSchema = z.object({
    kind: z.literal("ai"),
    prompt: z.string().min(1).max(2_000),
    compiled: builderRulesSchema.optional(),
}).strict();

export const smartRulesSchema = z.discriminatedUnion("kind", [
    builderRulesSchema,
    sqlRulesSchema,
    graphRulesSchema,
    aiRulesSchema,
]);

export type SmartRules = z.infer<typeof smartRulesSchema>;
export type BuilderRules = z.infer<typeof builderRulesSchema>;

// ─── Depth check (zod can't express "max recursion depth" cheaply) ──

function checkGroupDepth(node: Condition | Group, depth = 0): void {
    if (depth > MAX_GROUP_DEPTH) {
        throw new Error(`Smart rules: group nesting exceeds max depth ${MAX_GROUP_DEPTH}`);
    }
    if (node.type === "group") {
        for (const child of node.children) checkGroupDepth(child, depth + 1);
    }
}

// ─── Evaluation ─────────────────────────────────────────────────────

function getFieldValue(track: FilterableTrack, field: Field): unknown {
    return (track as unknown as Record<string, unknown>)[field];
}

function asString(v: unknown): string {
    return v == null ? "" : String(v).toLowerCase();
}

function asNumber(v: unknown): number | null {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function asDate(v: unknown): Date | null {
    if (v instanceof Date) return v;
    if (typeof v === "string" || typeof v === "number") {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
}

export function evaluateCondition(track: FilterableTrack, cond: Condition): boolean {
    const raw = getFieldValue(track, cond.field);
    const op = cond.operator;
    const v = cond.value;

    switch (op) {
        case "isSet": return raw != null && raw !== "";
        case "isNotSet": return raw == null || raw === "";
        case "eq": return raw === v;
        case "neq": return raw !== v;
        case "lt": case "lte": case "gt": case "gte": {
            const a = asNumber(raw); const b = asNumber(v);
            if (a == null || b == null) return false;
            if (op === "lt") return a < b;
            if (op === "lte") return a <= b;
            if (op === "gt") return a > b;
            return a >= b; // gte
        }
        case "between": {
            const a = asNumber(raw);
            if (a == null || !Array.isArray(v) || v.length !== 2) return false;
            const [lo, hi] = v as [number, number];
            return a >= lo && a <= hi;
        }
        case "in": case "notIn": {
            if (!Array.isArray(v)) return false;
            const hit = v.some((item) => item === raw || asString(item) === asString(raw));
            return op === "in" ? hit : !hit;
        }
        case "contains": return asString(raw).includes(asString(v));
        case "startsWith": return asString(raw).startsWith(asString(v));
        case "endsWith": return asString(raw).endsWith(asString(v));
        case "withinDays": {
            const d = asDate(raw); const days = asNumber(v);
            if (!d || days == null) return false;
            const ageMs = Date.now() - d.getTime();
            return ageMs <= days * 86_400_000 && ageMs >= 0;
        }
    }
}

export function evaluateGroup(track: FilterableTrack, group: Group): boolean {
    if (group.combinator === "and") {
        return group.children.every((c) =>
            c.type === "condition" ? evaluateCondition(track, c) : evaluateGroup(track, c),
        );
    }
    return group.children.some((c) =>
        c.type === "condition" ? evaluateCondition(track, c) : evaluateGroup(track, c),
    );
}

// ─── Compilers: each mode → BuilderRules (single source of truth) ───

/** Builder mode is the canonical IR — compile is identity. */
export function compileBuilder(rules: BuilderRules): BuilderRules {
    checkGroupDepth(rules.root);
    return rules;
}

/**
 * Tiny SQL-ish parser. Supports:
 *   field op value
 *   field BETWEEN n AND n
 *   field IN (v, v, ...)
 *   AND / OR with parentheses
 * Single-quoted strings and bare numbers. Case-insensitive keywords.
 *
 * Intentionally NOT real SQL — no joins, no subselects, no functions.
 * That's the whole point: the surface is too small to misuse.
 */
export function compileSql(query: string): BuilderRules {
    const tokens = tokenizeSql(query);
    let pos = 0;

    const peek = () => tokens[pos];
    const eat = (type: string, value?: string): SqlToken => {
        const t = tokens[pos];
        if (!t || t.type !== type || (value && t.value.toLowerCase() !== value.toLowerCase())) {
            throw new Error(`SQL parse: expected ${type}${value ? ` '${value}'` : ""} at position ${pos}, got ${t?.type ?? "EOF"} '${t?.value ?? ""}'`);
        }
        pos++;
        return t;
    };

    function parseGroup(): Group {
        let left: Condition | Group = parseAndTerm();
        // OR has lower precedence than AND.
        while (peek()?.type === "kw" && peek()!.value.toLowerCase() === "or") {
            pos++;
            const right = parseAndTerm();
            left = { type: "group", combinator: "or", children: [left, right] };
        }
        return left.type === "group" ? left : { type: "group", combinator: "and", children: [left] };
    }

    function parseAndTerm(): Condition | Group {
        let left: Condition | Group = parsePrimary();
        while (peek()?.type === "kw" && peek()!.value.toLowerCase() === "and") {
            pos++;
            const right = parsePrimary();
            left = { type: "group", combinator: "and", children: [left, right] };
        }
        return left;
    }

    function parsePrimary(): Condition | Group {
        const t = peek();
        if (!t) throw new Error("SQL parse: unexpected end of input");
        if (t.type === "lparen") {
            pos++;
            const g = parseGroup();
            eat("rparen");
            return g;
        }
        return parseCondition();
    }

    function parseCondition(): Condition {
        const fieldTok = eat("ident");
        const field = fieldTok.value as Field;
        if (!FIELDS.includes(field)) {
            throw new Error(`SQL parse: unknown field '${field}'`);
        }
        const opTok = peek();
        if (!opTok) throw new Error("SQL parse: missing operator");
        // BETWEEN n AND n
        if (opTok.type === "kw" && opTok.value.toLowerCase() === "between") {
            pos++;
            const lo = Number(eat("num").value);
            eat("kw", "and");
            const hi = Number(eat("num").value);
            return { type: "condition", field, operator: "between", value: [lo, hi] };
        }
        // IN (a, b, c)
        if (opTok.type === "kw" && opTok.value.toLowerCase() === "in") {
            pos++;
            eat("lparen");
            const values: Array<string | number> = [];
            for (; ;) {
                const tok = peek();
                if (!tok) throw new Error("SQL parse: unterminated IN list");
                if (tok.type === "str") values.push(tok.value);
                else if (tok.type === "num") values.push(Number(tok.value));
                else throw new Error(`SQL parse: invalid IN value '${tok.value}'`);
                pos++;
                if (peek()?.type === "comma") { pos++; continue; }
                break;
            }
            eat("rparen");
            return { type: "condition", field, operator: "in", value: values };
        }
        // Comparison operators
        if (opTok.type === "op") {
            pos++;
            const map: Record<string, Operator> = {
                "=": "eq", "!=": "neq", "<>": "neq",
                "<": "lt", "<=": "lte", ">": "gt", ">=": "gte",
            };
            const op = map[opTok.value];
            if (!op) throw new Error(`SQL parse: unknown operator '${opTok.value}'`);
            const valTok = eat(peek()?.type ?? "");
            const value: string | number | boolean =
                valTok.type === "num" ? Number(valTok.value)
                    : valTok.type === "str" ? valTok.value
                        : valTok.type === "kw" && /^(true|false)$/i.test(valTok.value) ? valTok.value.toLowerCase() === "true"
                            : valTok.value;
            return { type: "condition", field, operator: op, value };
        }
        throw new Error(`SQL parse: unexpected token '${opTok.value}' after field '${field}'`);
    }

    const root = parseGroup();
    if (pos < tokens.length) {
        throw new Error(`SQL parse: trailing tokens after position ${pos} ('${tokens[pos].value}')`);
    }
    checkGroupDepth(root);
    return { kind: "builder", root };
}

interface SqlToken { type: "ident" | "kw" | "num" | "str" | "op" | "lparen" | "rparen" | "comma"; value: string; }

function tokenizeSql(input: string): SqlToken[] {
    const tokens: SqlToken[] = [];
    const KEYWORDS = new Set(["and", "or", "between", "in", "not", "true", "false"]);
    let i = 0;
    while (i < input.length) {
        const c = input[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === "(") { tokens.push({ type: "lparen", value: "(" }); i++; continue; }
        if (c === ")") { tokens.push({ type: "rparen", value: ")" }); i++; continue; }
        if (c === ",") { tokens.push({ type: "comma", value: "," }); i++; continue; }
        if (c === "'") {
            let j = i + 1;
            let s = "";
            while (j < input.length && input[j] !== "'") {
                if (input[j] === "\\" && j + 1 < input.length) { s += input[j + 1]; j += 2; continue; }
                s += input[j]; j++;
            }
            if (input[j] !== "'") throw new Error("SQL parse: unterminated string literal");
            tokens.push({ type: "str", value: s });
            i = j + 1;
            continue;
        }
        if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(input[i + 1] ?? ""))) {
            let j = i + 1;
            while (j < input.length && /[0-9.]/.test(input[j])) j++;
            tokens.push({ type: "num", value: input.slice(i, j) });
            i = j;
            continue;
        }
        if (/[a-zA-Z_]/.test(c)) {
            let j = i + 1;
            while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) j++;
            const word = input.slice(i, j);
            tokens.push({ type: KEYWORDS.has(word.toLowerCase()) ? "kw" : "ident", value: word });
            i = j;
            continue;
        }
        // Multi-char operators first
        if (input.startsWith("<=", i) || input.startsWith(">=", i) || input.startsWith("!=", i) || input.startsWith("<>", i)) {
            tokens.push({ type: "op", value: input.slice(i, i + 2) });
            i += 2;
            continue;
        }
        if (c === "=" || c === "<" || c === ">") {
            tokens.push({ type: "op", value: c });
            i++;
            continue;
        }
        throw new Error(`SQL parse: unexpected character '${c}' at position ${i}`);
    }
    return tokens;
}

/** Graph mode: collapse the linear pipeline into builder + sort + limit. */
export function compileGraph(rules: z.infer<typeof graphRulesSchema>): BuilderRules {
    const filters: Array<Condition | Group> = [];
    let sort: BuilderRules["sort"];
    let limit: BuilderRules["limit"];
    for (const node of rules.nodes) {
        if (node.kind === "filter") filters.push(node.condition);
        else if (node.kind === "sort") sort = node.sort;
        else limit = node.limit;
    }
    const root: Group = filters.length === 1 && filters[0].type === "group"
        ? filters[0]
        : { type: "group", combinator: "and", children: filters.length ? filters : [] };
    if (root.children.length === 0) {
        // Degenerate: empty graph matches everything.
        root.children.push({ type: "group", combinator: "or", children: [{ type: "condition", field: "id", operator: "isSet" }] });
    }
    checkGroupDepth(root);
    return { kind: "builder", root, sort, limit };
}

/**
 * AI mode: returns the pre-compiled rules embedded by the LLM call
 * site. The actual prompt → rules inference lives in B43+ when AI
 * providers are wired up. For now this is just a passthrough so the
 * UI can store the prompt + a manually-authored fallback today.
 */
export function compileAi(rules: z.infer<typeof aiRulesSchema>): BuilderRules {
    if (!rules.compiled) {
        // Fallback: empty match-all rules. The runtime will return
        // the limit (or all tracks) when `compiled` isn't set yet.
        return {
            kind: "builder",
            root: { type: "group", combinator: "and", children: [{ type: "condition", field: "id", operator: "isSet" }] },
        };
    }
    return compileBuilder(rules.compiled);
}

/** Main entry point: any mode → executable BuilderRules. */
export function compileRules(rules: SmartRules): BuilderRules {
    switch (rules.kind) {
        case "builder": return compileBuilder(rules);
        case "sql": {
            const compiled = compileSql(rules.query);
            return { ...compiled, sort: rules.sort, limit: rules.limit };
        }
        case "graph": return compileGraph(rules);
        case "ai": return compileAi(rules);
    }
}

// ─── Runtime ────────────────────────────────────────────────────────

export function applySmartRules<T extends FilterableTrack>(
    tracks: T[],
    rules: SmartRules,
): T[] {
    const compiled = compileRules(rules);
    let out = tracks.filter((t) => evaluateGroup(t, compiled.root));
    if (compiled.sort) {
        const { field, direction } = compiled.sort;
        const dir = direction === "desc" ? -1 : 1;
        out = [...out].sort((a, b) => {
            const av = getFieldValue(a, field); const bv = getFieldValue(b, field);
            if (av == null && bv == null) return 0;
            if (av == null) return 1;   // nulls last
            if (bv == null) return -1;
            if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
            return String(av).localeCompare(String(bv)) * dir;
        });
    }
    if (compiled.limit) out = out.slice(0, compiled.limit);
    return out;
}
