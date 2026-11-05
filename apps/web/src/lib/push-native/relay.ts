import { z } from "zod";
import type { PushTokenRow } from "@/db/schema";
import type { NativePushMessage, PushSender, SendOutcome } from "./senders";

/** Body the MMO Server posts to /api/push/relay (server/README.md § Push relay, src/media/push-relay.ts). */
export const RELAY_EVENTS = ["recording.done", "recording.failed", "download.ready", "episode.new"] as const;

const scalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const relayBodySchema = z.object({
    event: z.enum(RELAY_EVENTS),
    eventId: z.uuid(),
    serverId: z.string().min(1).max(128),
    at: z.number().int().nonnegative(),
    profileId: z.string().min(1).max(128).optional(),
    title: z.string().min(1).max(200),
    body: z.string().max(1000).default(""),
    deepLink: z.string().max(500).regex(/^mixai:\/\//, "deepLink must use the mixai:// scheme").optional(),
    data: z.record(z.string().max(64), scalar).refine((d) => Object.keys(d).length <= 20, "max 20 data keys").optional(),
});

export type RelayBody = z.infer<typeof relayBodySchema>;

export const registerBodySchema = z.object({
    platform: z.enum(["android", "ios"]),
    // FCM tokens are ~160-180 chars, APNs 64 hex chars; cap generously.
    token: z.string().min(32).max(4096).regex(/^[A-Za-z0-9:_\-.]+$/),
    deviceName: z.string().trim().min(1).max(120).optional(),
    profileId: z.string().min(1).max(128).optional(),
    liveActivityToken: z.string().min(32).max(4096).regex(/^[A-Za-z0-9:_\-.]+$/).optional(),
    environment: z.enum(["production", "sandbox"]).optional(),
});

export const unregisterBodySchema = z.object({ token: z.string().min(32).max(4096) });

export function toMessage(b: RelayBody): NativePushMessage {
    return {
        title: b.title,
        body: b.body,
        deepLink: b.deepLink ?? null,
        data: { ...(b.data ?? {}), event: b.event, eventId: b.eventId, serverId: b.serverId },
        collapseId: `${b.event}:${b.deepLink ?? b.eventId}`,
    };
}

export interface FanOutResult {
    sent: number;
    dead: string[];
    retry: number;
    failed: number;
    skipped: number;
    delivered: string[];
}

/** Sends to every token with the matching platform sender; collects dead ids for deletion. */
export async function fanOut(
    tokens: PushTokenRow[],
    msg: NativePushMessage,
    senders: { android: PushSender | null; ios: PushSender | null },
): Promise<FanOutResult> {
    const res: FanOutResult = { sent: 0, dead: [], retry: 0, failed: 0, skipped: 0, delivered: [] };
    const outcomes = await Promise.all(tokens.map(async (t): Promise<[PushTokenRow, SendOutcome]> => {
        const sender = t.platform === "ios" ? senders.ios : t.platform === "android" ? senders.android : null;
        if (!sender) return [t, "unconfigured"];
        return [t, await sender.send(t.token, msg, { sandbox: t.environment === "sandbox" })];
    }));
    for (const [t, o] of outcomes) {
        if (o === "ok") { res.sent++; res.delivered.push(t.id); }
        else if (o === "dead") res.dead.push(t.id);
        else if (o === "retry") res.retry++;
        else if (o === "unconfigured") res.skipped++;
        else res.failed++;
    }
    return res;
}
