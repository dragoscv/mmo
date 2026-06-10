"use server";

/**
 * MCP audit log reader for the Copilot settings page.
 * Lists the most recent MCP JSON-RPC calls made by PATs owned by the
 * signed-in user.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { mcpAuditLog } from "@/db/schema-ai";
import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";

export interface McpAuditEntry {
    id: string;
    ts: string;
    jti: string;
    method: string;
    tool: string | null;
    ok: boolean;
    durationMs: number;
    errorCode: number | null;
}

export interface McpAuditSummary {
    last24h: {
        total: number;
        rateLimited: number;
        failed: number;
        avgDurationMs: number;
    };
    entries: McpAuditEntry[];
    nextOffset: number | null;
}

export type McpAuditStatus = "all" | "ok" | "failed" | "ratelimited";

export interface McpAuditQuery {
    limit?: number;
    offset?: number;
    status?: McpAuditStatus;
    tool?: string;
    sinceHours?: number;
}

function buildStatusFilter(status: McpAuditStatus | undefined): SQL | undefined {
    switch (status) {
        case "ok": return eq(mcpAuditLog.ok, true);
        case "failed": return eq(mcpAuditLog.ok, false);
        case "ratelimited": return eq(mcpAuditLog.errorCode, -32005);
        default: return undefined;
    }
}

export async function listMcpAuditEntries(query: McpAuditQuery = {}): Promise<McpAuditSummary> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return { last24h: { total: 0, rateLimited: 0, failed: 0, avgDurationMs: 0 }, entries: [], nextOffset: null };
    }

    const cap = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const sinceHours = Math.min(Math.max(Number(query.sinceHours) || 24, 1), 24 * 30);
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const filters: SQL[] = [eq(mcpAuditLog.userId, userId)];
    const statusF = buildStatusFilter(query.status);
    if (statusF) filters.push(statusF);
    if (query.tool && query.tool.trim()) filters.push(eq(mcpAuditLog.tool, query.tool.trim()));

    const whereExpr = filters.length === 1 ? filters[0] : and(...filters);

    const [rows, summaryRow] = await Promise.all([
        db.select().from(mcpAuditLog)
            .where(whereExpr)
            .orderBy(desc(mcpAuditLog.ts))
            .limit(cap + 1)
            .offset(offset),
        db.select({
            total: sql<number>`count(*)::int`,
            rateLimited: sql<number>`sum(case when ${mcpAuditLog.errorCode} = -32005 then 1 else 0 end)::int`,
            failed: sql<number>`sum(case when not ${mcpAuditLog.ok} then 1 else 0 end)::int`,
            avgDurationMs: sql<number>`coalesce(avg(${mcpAuditLog.durationMs}), 0)::int`,
        }).from(mcpAuditLog)
            .where(and(eq(mcpAuditLog.userId, userId), gte(mcpAuditLog.ts, since))),
    ]);

    const hasMore = rows.length > cap;
    const page = hasMore ? rows.slice(0, cap) : rows;

    return {
        last24h: {
            total: summaryRow[0]?.total ?? 0,
            rateLimited: summaryRow[0]?.rateLimited ?? 0,
            failed: summaryRow[0]?.failed ?? 0,
            avgDurationMs: summaryRow[0]?.avgDurationMs ?? 0,
        },
        entries: page.map((r) => ({
            id: r.id,
            ts: r.ts.toISOString(),
            jti: r.jti,
            method: r.method,
            tool: r.tool,
            ok: r.ok,
            durationMs: r.durationMs,
            errorCode: r.errorCode,
        })),
        nextOffset: hasMore ? offset + cap : null,
    };
}

export async function exportMcpAuditCsv(query: McpAuditQuery = {}): Promise<string> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return "ts,method,tool,ok,durationMs,errorCode\n";

    const sinceHours = Math.min(Math.max(Number(query.sinceHours) || 24, 1), 24 * 30);
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const filters: SQL[] = [eq(mcpAuditLog.userId, userId), gte(mcpAuditLog.ts, since)];
    const statusF = buildStatusFilter(query.status);
    if (statusF) filters.push(statusF);
    if (query.tool && query.tool.trim()) filters.push(eq(mcpAuditLog.tool, query.tool.trim()));

    const rows = await db.select().from(mcpAuditLog)
        .where(and(...filters))
        .orderBy(desc(mcpAuditLog.ts))
        .limit(5000);

    const escape = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ["ts,jti,method,tool,ok,durationMs,errorCode"];
    for (const r of rows) {
        lines.push([
            r.ts.toISOString(),
            escape(r.jti),
            escape(r.method),
            escape(r.tool ?? ""),
            r.ok ? "true" : "false",
            String(r.durationMs),
            r.errorCode == null ? "" : String(r.errorCode),
        ].join(","));
    }
    return lines.join("\n") + "\n";
}
