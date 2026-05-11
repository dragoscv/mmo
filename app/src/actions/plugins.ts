"use server";

/**
 * Server actions for the plugin host (VST3 / AU / LV2 via pedalboard).
 *
 * All work is delegated to the companion via the `companionPlugins`
 * SDK — the web app itself never touches plugin paths or audio files.
 * Returns null whenever there's no companion linked, letting callers
 * render an empty/upsell state.
 */

import { z } from "zod";
import { auth } from "@/auth";
import { getCompanionLink } from "@/lib/companion-library";
import {
    companionPlugins,
    type PluginScanResult,
    type PluginDescriptor,
    type PluginChainStep,
    type PluginRenderJobSnapshot,
    type PluginHostStatus,
} from "@/lib/companion-plugins";

// Plugin paths are fed straight to the companion's pedalboard host where
// they get dlopen'd as native code. The companion already enforces an
// allowlist (only paths from a previous /scan inventory are loadable),
// but we add cheap shape gates here so a multi-MB string can't even
// reach the companion HTTP layer.
const pluginPathSchema = z.string().min(1).max(4096).refine(
    (p) => !/[\x00-\x1f]/.test(p),
    { message: "path must not contain control characters" },
);
const extraPathsSchema = z.array(pluginPathSchema).max(64);
const chainStepSchema = z.object({
    path: pluginPathSchema,
    bypass: z.boolean().optional(),
    params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
}).strict();
const chainSchema = z.array(chainStepSchema).max(32);

export async function getPluginInventory(): Promise<{
    cached: PluginScanResult | null;
    companionLinked: boolean;
}> {
    const link = await getCompanionLink();
    if (!link) return { cached: null, companionLinked: false };
    try {
        const data = await companionPlugins.list(link);
        return { cached: data.cached, companionLinked: true };
    } catch {
        return { cached: null, companionLinked: true };
    }
}

export async function scanPlugins(extraPaths: string[] = []): Promise<{
    ok: boolean;
    result?: PluginScanResult;
    error?: string;
}> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "Not authenticated" };
    const pathsCheck = extraPathsSchema.safeParse(extraPaths);
    if (!pathsCheck.success) {
        return { ok: false, error: pathsCheck.error.issues[0]?.message ?? "Invalid extraPaths" };
    }
    const link = await getCompanionLink();
    if (!link) return { ok: false, error: "No companion linked" };
    try {
        const result = await companionPlugins.scan(link, pathsCheck.data);
        return { ok: true, result };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export async function describePlugin(path: string): Promise<{
    ok: boolean;
    plugin?: PluginDescriptor;
    error?: string;
}> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "Not authenticated" };
    const pathCheck = pluginPathSchema.safeParse(path);
    if (!pathCheck.success) {
        return { ok: false, error: pathCheck.error.issues[0]?.message ?? "Invalid path" };
    }
    const link = await getCompanionLink();
    if (!link) return { ok: false, error: "No companion linked" };
    try {
        const plugin = await companionPlugins.describe(link, pathCheck.data);
        return { ok: true, plugin };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export async function renderWithPlugins(
    inputPath: string,
    chain: PluginChainStep[],
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "Not authenticated" };
    const inputCheck = pluginPathSchema.safeParse(inputPath);
    if (!inputCheck.success) {
        return { ok: false, error: inputCheck.error.issues[0]?.message ?? "Invalid inputPath" };
    }
    const chainCheck = chainSchema.safeParse(chain);
    if (!chainCheck.success) {
        return { ok: false, error: chainCheck.error.issues[0]?.message ?? "Invalid chain" };
    }
    const link = await getCompanionLink();
    if (!link) return { ok: false, error: "No companion linked" };
    try {
        const job = await companionPlugins.render(link, inputCheck.data, chainCheck.data);
        return { ok: true, jobId: job.id };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export async function getPluginRenderStatus(
    jobId: string,
): Promise<PluginRenderJobSnapshot | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    try {
        return await companionPlugins.getRender(link, jobId);
    } catch {
        return null;
    }
}

export async function getPluginHostStatus(): Promise<PluginHostStatus | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    try {
        return await companionPlugins.status(link);
    } catch {
        return null;
    }
}

/** Build a URL for a render job's audio. Returns null when there's
 *  no linked companion. The web client must fetch this URL with the
 *  device token in headers (loopback-only). */
export async function getPluginRenderAudioUrl(jobId: string): Promise<string | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return companionPlugins.renderAudioUrl(link, jobId);
}
