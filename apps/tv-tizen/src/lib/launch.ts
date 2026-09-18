/**
 * Deep links into streaming apps on Tizen (WP12-02).
 *
 * Chain: provider app via `launchAppControl(view, url, appId)` when installed
 * (`getAppInfo` throws NotFoundError otherwise) → same control without appId
 * (system browser / whoever handles `view`) → `qr` so the user opens the URL on
 * the phone. Needs `application.launch` + `application.info` privileges.
 */
import type { Offer } from "./media-types";

export const VIEW_OP = "http://tizen.org/appcontrol/operation/view";

export type InstallState = "installed" | "missing" | "unknown";
export type LaunchOutcome = { via: "app"; appId: string } | { via: "browser" } | { via: "qr"; url: string };

function app(): TizenApplicationManager | undefined {
    return typeof tizen !== "undefined" ? tizen?.application : undefined;
}

/** Concrete URL for an offer: exact link → provider web deep link → provider search. */
export function offerUrl(offer: Offer): string {
    return offer.link ?? offer.launch.web ?? offer.launch.search;
}

export function appInstalled(appId: string | undefined): InstallState {
    if (!appId) return "missing";
    const a = app();
    if (!a || typeof a.getAppInfo !== "function") return "unknown";
    try {
        a.getAppInfo(appId);
        return "installed";
    } catch (e) {
        return (e as TizenWebAPIError | null)?.name === "NotFoundError" ? "missing" : "unknown";
    }
}

function control(url: string, payload?: string): TizenApplicationControl | null {
    if (typeof tizen === "undefined" || !tizen?.ApplicationControl) return null;
    const data = payload && tizen.ApplicationControlData ? [new tizen.ApplicationControlData("PAYLOAD", [payload])] : null;
    return new tizen.ApplicationControl(VIEW_OP, url, null, null, data);
}

function launchWith(ctl: TizenApplicationControl, appId: string | null): Promise<void> {
    return new Promise((resolve, reject) => {
        const a = app();
        if (!a) { reject(new Error("no tizen.application")); return; }
        try {
            a.launchAppControl(ctl, appId, () => resolve(), (e) => reject(new Error(e?.name ?? "launch failed")));
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
        }
    });
}

export async function launchOffer(offer: Offer): Promise<LaunchOutcome> {
    const url = offerUrl(offer);
    const tz = offer.launch.tizen;
    const ctl = control(url, tz?.payload);
    if (ctl) {
        if (tz?.appId && appInstalled(tz.appId) !== "missing") {
            try {
                await launchWith(ctl, tz.appId);
                return { via: "app", appId: tz.appId };
            } catch { /* fall through */ }
        }
        try {
            await launchWith(ctl, null);
            return { via: "browser" };
        } catch { /* fall through */ }
    }
    return { via: "qr", url };
}
