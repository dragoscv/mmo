"use client";

/**
 * Per-server filter chips (WP11-03). Selection lives in the URL
 * (`?servers=a,b`, nuqs, shallow) and filtering happens client-side on the
 * merged rows through `useSelectedServers()`. Offline servers stay visible
 * but greyed, with a tooltip telling when they were last seen.
 */
import { parseAsArrayOf, parseAsString, useQueryStates } from "nuqs";
import { useLocale, useTranslations } from "next-intl";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mmo/ui";
import { relativeSince, type ServerChip } from "@/lib/media/home";

/** `?servers=a,b` — empty means "all servers" (key mirrors `SERVERS_PARAM` in lib/media/home). */
const homeSearchParams = { servers: parseAsArrayOf(parseAsString).withDefault([]) };

export function useSelectedServers() {
    const [{ servers }, setState] = useQueryStates(homeSearchParams, { shallow: true, clearOnDefault: true });
    return [servers, (next: string[]) => setState({ servers: next })] as const;
}

export interface ServerChipsProps {
    chips: ServerChip[];
    /** Epoch ms captured on the server (no `Date.now()` in render — lint `react-hooks/purity`). */
    now: number;
}

export function ServerChips({ chips, now }: ServerChipsProps) {
    const t = useTranslations("home.servers");
    const locale = useLocale();
    const [selected, setSelected] = useSelectedServers();
    if (chips.length < 2) return null;
    const toggle = (id: string) => {
        const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
        setSelected(next.length === chips.length ? [] : next);
    };
    return (
        <div className="media-chips" role="group" aria-label={t("label")} data-slot="server-chips">
            <button
                type="button"
                className="media-chip"
                aria-pressed={selected.length === 0}
                onClick={() => setSelected([])}
            >
                {t("all")}
            </button>
            {chips.map((c) => {
                const chip = (
                    <button
                        key={c.id}
                        type="button"
                        className="media-chip"
                        aria-pressed={selected.includes(c.id)}
                        data-offline={c.online ? undefined : ""}
                        data-server-id={c.id}
                        onClick={() => toggle(c.id)}
                    >
                        <span className="media-chip-dot" aria-hidden />
                        <span>{c.name}</span>
                        <span className="media-chip-count">{c.count}</span>
                        {!c.online ? <span className="sr-only">{t("offline")}</span> : null}
                    </button>
                );
                if (c.online) return chip;
                return (
                    <Tooltip key={c.id}>
                        <TooltipTrigger render={chip} />
                        <TooltipContent>{t("unreachableSince", { when: relativeSince(c.lastSeenAt, now, locale) })}</TooltipContent>
                    </Tooltip>
                );
            })}
        </div>
    );
}
