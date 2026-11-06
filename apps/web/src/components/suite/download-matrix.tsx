"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import Link from "@/components/host/host-context";
import { detectPlatform, PLATFORM_STATUS, SUITE_PRODUCTS, type PlatformKey } from "./products";
import { platformHref } from "./platform-links";

const noop = () => () => {};

/** Per-product platform chips; the visitor's platform is highlighted after hydration (WP17-12, WP17-75). */
export function DownloadMatrix() {
    const t = useTranslations("mx.suite");
    // Server snapshot = null, client = UA guess: no hydration mismatch, no effect.
    const mine = useSyncExternalStore<PlatformKey | null>(noop, () => detectPlatform(navigator.userAgent), () => null);
    return (
        <div className="sx-matrix">
            {SUITE_PRODUCTS.map((p) => {
                const Icon = p.icon;
                return (
                    <div key={p.key} className="sx-row" style={{ ["--c" as string]: p.accent }}>
                        <div className="sx-row-name"><Icon aria-hidden />{t(`products.${p.key}.name`)}</div>
                        <ul className="sx-chips" aria-label={t(`products.${p.key}.name`)}>
                            {p.platforms.map((pl) => {
                                const status = PLATFORM_STATUS[p.key][pl] ?? "soon";
                                const href = status === "live" ? platformHref(p.key, pl) : null;
                                const label = t(`platforms.${pl}`);
                                const isMine = mine === pl;
                                const inner = (
                                    <>
                                        {label}
                                        {isMine ? <small>· {t("sections.yourDevice")}</small> : null}
                                        {!href ? <small>· {t("sections.soon")}</small> : null}
                                    </>
                                );
                                return (
                                    <li key={pl}>
                                        {href ? (
                                            <Link href={href} className="sx-chip" data-mine={isMine || undefined}>{inner}</Link>
                                        ) : (
                                            <span className="sx-chip" data-soon data-mine={isMine || undefined}>{inner}</span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                );
            })}
        </div>
    );
}
