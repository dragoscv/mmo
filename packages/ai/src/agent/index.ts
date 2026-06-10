/**
 * Maestro — MMO's music agent.
 *
 * Skeleton in P0. Full implementation (planner, tool runtime, traces,
 * sub-agents) lands in P4. We declare the public surface here so other
 * packages and the app can import stable types now.
 */

import type { ModelChoices } from "../models";
import type { ToolContext, ToolRegistry } from "../tools";

export type AgentAutonomy = "ask" | "propose" | "auto";

export interface AgentTrace {
    sessionId: string;
    steps: AgentStep[];
}

export interface AgentStep {
    index: number;
    kind: "thought" | "tool" | "message" | "error";
    name?: string;
    input?: unknown;
    output?: unknown;
    startedAt: Date;
    finishedAt?: Date;
    error?: string;
}

export interface MaestroConfig {
    tools: ToolRegistry;
    choices: ModelChoices;
    autonomy: AgentAutonomy;
    /** Cap total tool calls per run. */
    maxSteps: number;
    /** Per-run budget in tokens; runtime aborts when exceeded. */
    tokenBudget?: number;
}

export interface MaestroRunInput {
    sessionId: string;
    userId: string;
    projectId?: string;
    prompt: string;
    /** Pre-built context (smart context strategy default). */
    context?: string;
}

export interface MaestroRunResult {
    sessionId: string;
    trace: AgentTrace;
    finalMessage?: string;
}

export class Maestro {
    constructor(readonly config: MaestroConfig) {}

    async run(_input: MaestroRunInput): Promise<MaestroRunResult> {
        throw new Error("Maestro.run() — implemented in P4");
    }
}

export type { ToolContext };
