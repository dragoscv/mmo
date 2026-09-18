"use server";

/**
 * Casting server actions — the "Play on…" picker calls these.
 *
 *   listCastDevices()        merged DLNA + Home Assistant devices from the companion
 *   getRendererMediaUrls()   LAN URLs for the browser-side Google Cast sender
 *   castToDevice()           build LAN URLs + POST /cast/play on the companion
 *   castCommand()            pause/play/stop/seek/volume on a remote device
 *
 * All inputs are Zod-validated and every action requires a session.
 */

import { z } from "zod";
import { auth } from "@/auth";
import { companionCast, type CastDevice, type CastCommandAction } from "@/lib/cast/companion-cast";
import { buildRendererMediaUrls, type RendererMediaUrls, type RendererKind } from "@/lib/cast/renderer-url";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const MediaRefSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("video"), fileId: z.number().int().positive() }),
    z.object({ type: z.literal("track"), trackId: z.number().int().positive() }),
]);

const DeviceIdSchema = z.string().min(4).max(300).regex(/^(dlna:|ha:media_player\.)/);

const CastToDeviceSchema = z.object({
    deviceId: DeviceIdSchema,
    media: MediaRefSchema,
    startSec: z.number().min(0).max(24 * 3600).optional(),
    subtitleIndex: z.number().int().min(0).optional(),
});

const CastCommandSchema = z.object({
    deviceId: DeviceIdSchema,
    action: z.enum(["play", "pause", "stop", "seek", "volume_set", "volume_mute", "next", "previous"]),
    value: z.union([z.number(), z.boolean()]).optional(),
});

const RendererUrlsSchema = z.object({
    media: MediaRefSchema,
    kind: z.enum(["google-cast", "dlna", "home-assistant"]),
});

async function requireSession(): Promise<string | null> {
    const s = await auth();
    return s?.user?.id ?? null;
}

function fail(e: unknown): { ok: false; error: string } {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

export async function listCastDevices(refresh = false): Promise<Result<{ devices: CastDevice[]; haConfigured: boolean }>> {
    if (!(await requireSession())) return { ok: false, error: "Not signed in" };
    try {
        const r = await companionCast.devices(refresh === true);
        return { ok: true, data: { devices: r.devices, haConfigured: r.haConfigured } };
    } catch (e) {
        return fail(e);
    }
}

export async function getRendererMediaUrls(input: z.input<typeof RendererUrlsSchema>): Promise<Result<RendererMediaUrls>> {
    if (!(await requireSession())) return { ok: false, error: "Not signed in" };
    const parsed = RendererUrlsSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid input" };
    try {
        const urls = await buildRendererMediaUrls(parsed.data.media, parsed.data.kind as RendererKind);
        if (!urls) return { ok: false, error: "Media not available on a LAN companion" };
        return { ok: true, data: urls };
    } catch (e) {
        return fail(e);
    }
}

export async function castToDevice(input: z.input<typeof CastToDeviceSchema>): Promise<Result<{ title: string }>> {
    if (!(await requireSession())) return { ok: false, error: "Not signed in" };
    const parsed = CastToDeviceSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid input" };
    const { deviceId, media, startSec, subtitleIndex } = parsed.data;
    const kind: RendererKind = deviceId.startsWith("dlna:") ? "dlna" : "home-assistant";
    try {
        const urls = await buildRendererMediaUrls(media, kind);
        if (!urls) return { ok: false, error: "Media not available on a LAN companion" };
        const sub = subtitleIndex != null ? urls.subtitles[subtitleIndex] : urls.subtitles[0];
        await companionCast.play({
            deviceId,
            url: urls.url,
            mime: urls.mime,
            title: urls.subtitle ? `${urls.title} — ${urls.subtitle}` : urls.title,
            thumb: urls.poster ?? undefined,
            subtitleUrl: sub?.src,
            startSec,
        });
        return { ok: true, data: { title: urls.title } };
    } catch (e) {
        return fail(e);
    }
}

export async function castCommand(input: z.input<typeof CastCommandSchema>): Promise<Result<null>> {
    if (!(await requireSession())) return { ok: false, error: "Not signed in" };
    const parsed = CastCommandSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid input" };
    try {
        await companionCast.command(parsed.data.deviceId, parsed.data.action as CastCommandAction, parsed.data.value);
        return { ok: true, data: null };
    } catch (e) {
        return fail(e);
    }
}
