"use client";

/**
 * Client-side Web Push subscription manager.
 *
 * Handles the full lifecycle:
 *   1. Reads VAPID public key from `NEXT_PUBLIC_VAPID_PUBLIC_KEY`.
 *   2. Requests notification permission on subscribe().
 *   3. Calls `serviceWorker.pushManager.subscribe(...)`.
 *   4. POSTs the subscription to `/api/push/subscribe`.
 *   5. On unsubscribe, DELETEs the row server-side AND calls
 *      `subscription.unsubscribe()` on the browser side.
 *   6. Listens for the SW's `pushsubscriptionchange` message and
 *      re-subscribes automatically when the browser rotates keys.
 */

import { useCallback, useEffect, useRef, useState } from "react";

function urlBase64ToUint8Array(b64: string): Uint8Array {
    const padding = "=".repeat((4 - (b64.length % 4)) % 4);
    const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

type PushState =
    | { status: "loading" }
    | { status: "unsupported" }
    | { status: "no-vapid" }
    | { status: "denied" }
    | { status: "subscribed"; endpoint: string }
    | { status: "unsubscribed" };

export function usePushSubscription() {
    const [state, setState] = useState<PushState>({ status: "loading" });
    const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
    // Stable ref lets the message-listener effect call the latest subscribe()
    // without re-binding (and without producing the "accessed before declared"
    // warning the react-hooks plugin flags on a forward reference).
    const subscribeRef = useRef<() => Promise<boolean>>(async () => false);

    const subscribe = useCallback(async (): Promise<boolean> => {
        if (!vapidPublicKey) return false;
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
            setState({ status: "denied" });
            return false;
        }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            // Cast: Uint8Array is a BufferSource at runtime; lib.dom typing
            // on TS 5.7+ narrows BufferSource in a way that rejects this.
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
        });
        const json = sub.toJSON();
        const res = await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(json),
        });
        if (!res.ok) {
            // Roll back the browser subscription if the server refused it,
            // so we don't end up with a phantom subscription the server
            // doesn't know about.
            await sub.unsubscribe().catch(() => { });
            return false;
        }
        setState({ status: "subscribed", endpoint: sub.endpoint });
        return true;
    }, [vapidPublicKey]);

    useEffect(() => {
        subscribeRef.current = subscribe;
    }, [subscribe]);

    const unsubscribe = useCallback(async (): Promise<boolean> => {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) {
            setState({ status: "unsubscribed" });
            return true;
        }
        await fetch("/api/push/subscribe", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe().catch(() => { });
        setState({ status: "unsubscribed" });
        return true;
    }, []);

    const refresh = useCallback(async () => {
        if (typeof window === "undefined") return;
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
            setState({ status: "unsupported" });
            return;
        }
        if (!vapidPublicKey) {
            setState({ status: "no-vapid" });
            return;
        }
        if (Notification.permission === "denied") {
            setState({ status: "denied" });
            return;
        }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            setState({ status: "subscribed", endpoint: sub.endpoint });
        } else {
            setState({ status: "unsubscribed" });
        }
    }, [vapidPublicKey]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh dispatches setState asynchronously after awaiting navigator.serviceWorker.ready; not the synchronous render-cascade the rule guards against.
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
        const onMessage = (event: MessageEvent) => {
            if (event.data?.type === "pushsubscriptionchange") {
                void subscribeRef.current();
            }
        };
        navigator.serviceWorker.addEventListener("message", onMessage);
        return () => navigator.serviceWorker.removeEventListener("message", onMessage);
    }, []);

    return { state, subscribe, unsubscribe, refresh };
}
