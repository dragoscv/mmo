import { NextRequest } from "next/server";
import { z } from "zod";

import { verifyPat } from "@/actions/agent-pats";
import { buildTools } from "@/lib/maestro/tools";
import { toolAllowedBy } from "@/lib/maestro/tool-scopes";
import { MCP_PROMPTS, MCP_RESOURCES, renderPrompt } from "@/lib/maestro/mcp-catalog";
import { audit, rateLimit } from "@/lib/maestro/mcp-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MCP server façade (P11).
 *
 * Exposes the Maestro tool catalog to external Model Context Protocol
 * clients (Claude Desktop, Cursor, etc.) over a single JSON-RPC 2.0
 * HTTP endpoint. Auth is a `Authorization: Bearer <PAT JWT>` header
 * issued via /settings/copilot.
 *
 * Implemented methods:
 *   - initialize
 *   - tools/list, tools/call
 *   - resources/list, resources/read
 *   - prompts/list, prompts/get
 *
 * Per-PAT rate limit + structured audit log are applied to every
 * request (see lib/maestro/mcp-limits.ts).
 *
 * Sessions are implicit (one PAT == one session). No SSE / streaming
 * yet \u2014 tools return synchronously.
 */

interface RpcRequest {
    jsonrpc: "2.0";
    id?: number | string | null;
    method: string;
    params?: unknown;
}

const RpcRequestSchema = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string(), z.null()]).optional(),
    method: z.string(),
    params: z.unknown().optional(),
});

interface ToolLike {
    description?: string;
    inputSchema?: unknown;
}

function ok(id: RpcRequest["id"], result: unknown) {
    return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function err(id: RpcRequest["id"], code: number, message: string, data?: unknown) {
    return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });
}

function extractBearer(req: NextRequest): string | null {
    const h = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1]!.trim() : null;
}

function toJsonSchema(schema: unknown): Record<string, unknown> {
    if (!schema) return { type: "object", properties: {} };
    // Zod v4 ships `z.toJSONSchema`. Fallback to an empty object if a tool
    // ever ships with a non-Zod schema.
    try {
        const s = schema as z.ZodTypeAny;
        const json = (z as unknown as { toJSONSchema?: (s: unknown) => Record<string, unknown> })
            .toJSONSchema?.(s);
        return json ?? { type: "object", properties: {} };
    } catch {
        return { type: "object", properties: {} };
    }
}

export async function POST(req: NextRequest) {
    const t0 = Date.now();
    const token = extractBearer(req);
    if (!token) return err(null, -32001, "Missing bearer token");
    const pat = await verifyPat(token);
    if (!pat) return err(null, -32001, "Invalid or revoked token");

    const rl = rateLimit(pat.jti);
    if (!rl.ok) {
        audit({ ts: Date.now(), userId: pat.userId, jti: pat.jti, method: "<rate-limited>", ok: false, durationMs: Date.now() - t0, errorCode: -32005 });
        return err(null, -32005, `Rate limit exceeded; retry in ${Math.ceil(rl.resetMs / 1000)}s`);
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        audit({ ts: Date.now(), userId: pat.userId, jti: pat.jti, method: "<parse-error>", ok: false, durationMs: Date.now() - t0, errorCode: -32700 });
        return err(null, -32700, "Parse error");
    }

    const parsed = RpcRequestSchema.safeParse(body);
    if (!parsed.success) {
        audit({ ts: Date.now(), userId: pat.userId, jti: pat.jti, method: "<invalid>", ok: false, durationMs: Date.now() - t0, errorCode: -32600 });
        return err(null, -32600, "Invalid request");
    }
    const rpc = parsed.data;

    // Build the tools bound to this PAT's user. No active chat session, so
    // we synthesize a per-request sessionId.
    const tools = buildTools({
        userId: pat.userId,
        sessionId: `mcp:${pat.jti}`,
        allowDestructive: pat.scopes.includes("library:write") || pat.scopes.includes("daw:write"),
    });

    const finish = (response: Response, status: { ok: boolean; tool?: string; code?: number }) => {
        audit({
            ts: Date.now(),
            userId: pat.userId,
            jti: pat.jti,
            method: rpc.method,
            tool: status.tool,
            ok: status.ok,
            durationMs: Date.now() - t0,
            errorCode: status.code,
        });
        return response;
    };

    switch (rpc.method) {
        case "initialize": {
            return finish(ok(rpc.id, {
                protocolVersion: "2024-11-05",
                serverInfo: { name: "mmo-maestro", version: "0.1.0" },
                capabilities: {
                    tools: { listChanged: false },
                    resources: { listChanged: false, subscribe: false },
                    prompts: { listChanged: false },
                },
            }), { ok: true });
        }
        case "tools/list": {
            const list = Object.entries(tools)
                .filter(([name]) => toolAllowedBy(name, pat.scopes))
                .map(([name, def]) => {
                    const t = def as ToolLike;
                    return {
                        name,
                        description: t.description ?? "",
                        inputSchema: toJsonSchema(t.inputSchema),
                    };
                });
            return finish(ok(rpc.id, { tools: list }), { ok: true });
        }
        case "tools/call": {
            const callSchema = z.object({
                name: z.string(),
                arguments: z.record(z.string(), z.unknown()).optional(),
            });
            const cp = callSchema.safeParse(rpc.params);
            if (!cp.success) return finish(err(rpc.id, -32602, "Invalid params"), { ok: false, code: -32602 });
            const { name, arguments: args } = cp.data;
            if (!toolAllowedBy(name, pat.scopes)) {
                return finish(err(rpc.id, -32004, `Tool '${name}' requires additional scopes`), { ok: false, tool: name, code: -32004 });
            }
            const def = tools[name] as unknown as
                | { execute?: (input: unknown, ctx?: unknown) => Promise<unknown> }
                | undefined;
            if (!def?.execute) return finish(err(rpc.id, -32601, `Unknown tool: ${name}`), { ok: false, tool: name, code: -32601 });
            try {
                const result = await def.execute(args ?? {}, { toolCallId: `mcp:${Date.now()}`, messages: [] });
                return finish(ok(rpc.id, {
                    content: [{ type: "text", text: JSON.stringify(result) }],
                    isError: false,
                }), { ok: true, tool: name });
            } catch (e) {
                return finish(ok(rpc.id, {
                    content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
                    isError: true,
                }), { ok: false, tool: name });
            }
        }
        case "resources/list": {
            // Filter resources whose backing tool the PAT can't access.
            const list = MCP_RESOURCES
                .filter(r => toolAllowedBy(r.tool, pat.scopes))
                .map(r => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType }));
            return finish(ok(rpc.id, { resources: list }), { ok: true });
        }
        case "resources/read": {
            const rs = z.object({ uri: z.string() }).safeParse(rpc.params);
            if (!rs.success) return finish(err(rpc.id, -32602, "Invalid params"), { ok: false, code: -32602 });
            const resource = MCP_RESOURCES.find(r => r.uri === rs.data.uri);
            if (!resource) return finish(err(rpc.id, -32601, `Unknown resource: ${rs.data.uri}`), { ok: false, code: -32601 });
            if (!toolAllowedBy(resource.tool, pat.scopes)) {
                return finish(err(rpc.id, -32004, `Resource '${rs.data.uri}' requires additional scopes`), { ok: false, code: -32004 });
            }
            const def = tools[resource.tool] as unknown as
                | { execute?: (input: unknown, ctx?: unknown) => Promise<unknown> }
                | undefined;
            if (!def?.execute) return finish(err(rpc.id, -32601, `Resource backend missing: ${resource.tool}`), { ok: false, code: -32601 });
            try {
                const result = await def.execute(resource.input ?? {}, { toolCallId: `mcp:${Date.now()}`, messages: [] });
                return finish(ok(rpc.id, {
                    contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: JSON.stringify(result) }],
                }), { ok: true, tool: resource.tool });
            } catch (e) {
                return finish(err(rpc.id, -32603, e instanceof Error ? e.message : String(e)), { ok: false, code: -32603 });
            }
        }
        case "prompts/list": {
            return finish(ok(rpc.id, { prompts: MCP_PROMPTS }), { ok: true });
        }
        case "prompts/get": {
            const ps = z.object({
                name: z.string(),
                arguments: z.record(z.string(), z.unknown()).optional(),
            }).safeParse(rpc.params);
            if (!ps.success) return finish(err(rpc.id, -32602, "Invalid params"), { ok: false, code: -32602 });
            const meta = MCP_PROMPTS.find(p => p.name === ps.data.name);
            if (!meta) return finish(err(rpc.id, -32601, `Unknown prompt: ${ps.data.name}`), { ok: false, code: -32601 });
            const text = renderPrompt(ps.data.name, ps.data.arguments);
            return finish(ok(rpc.id, {
                description: meta.description,
                messages: [{ role: "user", content: { type: "text", text } }],
            }), { ok: true });
        }
        default:
            return finish(err(rpc.id, -32601, `Method not found: ${rpc.method}`), { ok: false, code: -32601 });
    }
}

export async function GET() {
    return new Response("MCP endpoint — POST JSON-RPC 2.0 with Authorization: Bearer <PAT>", {
        status: 405,
        headers: { Allow: "POST" },
    });
}
