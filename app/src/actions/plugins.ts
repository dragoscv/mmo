"use server";

/**
 * Server actions for the plugin host (VST3 / AU / LV2 via pedalboard).
 *
 * All work is delegated to the companion via the `companionPlugins`
 * SDK — the web app itself never touches plugin paths or audio files.
 * Returns null whenever there's no companion linked, letting callers
 * render an empty/upsell state.
 */

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
    const link = await getCompanionLink();
    if (!link) return { ok: false, error: "No companion linked" };
    try {
        const result = await companionPlugins.scan(link, extraPaths);
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
    const link = await getCompanionLink();
    if (!link) return { ok: false, error: "No companion linked" };
    try {
        const plugin = await companionPlugins.describe(link, path);
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
    const link = await getCompanionLink();
    if (!link) return { ok: false, error: "No companion linked" };
    try {
        const job = await companionPlugins.render(link, inputPath, chain);
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
