/**
 * Typed tool definitions for the Maestro agent. Each tool has:
 *   - name (dot.path namespaced)
 *   - description (passed to the LLM)
 *   - input schema (Zod) — validated before execute()
 *   - output schema (Zod, optional) — validated after execute()
 *   - destructive flag — gates auto-apply when autonomy="ask"
 *   - execute(ctx, input) — server-side handler
 *
 * The same tool definitions are exposed:
 *   - Locally to in-process Maestro runs (app/, server/)
 *   - Over MCP (packages/ai-mcp)
 *   - Over REST/SSE (app/api/agent/*)
 */

import type { z } from "zod";

export interface ToolContext {
    userId: string;
    projectId?: string;
    sessionId?: string;
    /** Provider-agnostic logger; populated by the agent runtime. */
    log: (event: string, data?: Record<string, unknown>) => void;
    /** Abort signal forwarded from the agent run. */
    signal?: AbortSignal;
}

export interface ToolDefinition<I = unknown, O = unknown> {
    name: string;
    description: string;
    inputSchema: z.ZodType<I>;
    outputSchema?: z.ZodType<O>;
    destructive?: boolean;
    /** Read-only tools are always safe to auto-call. */
    readonly?: boolean;
    execute: (ctx: ToolContext, input: I) => Promise<O>;
}

export function defineTool<I, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
    return def;
}

export class ToolRegistry {
    private tools = new Map<string, ToolDefinition>();

    register<I, O>(tool: ToolDefinition<I, O>): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`Duplicate tool name: ${tool.name}`);
        }
        this.tools.set(tool.name, tool as ToolDefinition);
    }

    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name);
    }

    list(): ToolDefinition[] {
        return Array.from(this.tools.values());
    }

    /** Returns tools matching a dot-prefix, e.g. "track." or "generate.". */
    filter(prefix: string): ToolDefinition[] {
        return this.list().filter((t) => t.name.startsWith(prefix));
    }
}
