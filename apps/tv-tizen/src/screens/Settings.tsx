/**
 * Settings (WP16-33): two panes — section list (left) and the section body (right). Focusing a section in
 * the list shows it (no OK needed); → enters the pane. `params.section` (hub `navigate settings/<id>`,
 * Profiles "Manage") preselects. Sections live in ./settings/*.
 */
import { useEffect, useRef, useState, type FocusEvent } from "react";
import { focusEl } from "../lib/focus";
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { useScreenActive } from "../nav/Nav";
import { Icon, ScreenHeader, useBackdrop, type IconName } from "../ui";
import { ProfilesSection } from "./settings/ProfilesSection";
import {
    AboutSection, AccountSection, CacheSection, LanguageSection, NavigationSection, PlaybackSection, ScreenSection,
    ServerSection, SoundSection, SubtitlesSection, TogetherSection,
} from "./settings/Sections";
import "./settings/settings.css";

export const SECTIONS = [
    "profiles", "playback", "subtitles", "language", "navigation", "screen", "sound", "together", "server", "account", "cache", "about",
] as const;
export type SectionId = (typeof SECTIONS)[number];

const ICONS: Record<SectionId, IconName> = {
    profiles: "user", playback: "play", subtitles: "subtitles", language: "chevronRight", navigation: "queue", screen: "aspect",
    sound: "audio", together: "group", server: "server", account: "lock", cache: "refresh", about: "info",
};

function asSection(s: string | undefined): SectionId {
    return (SECTIONS as readonly string[]).includes(s ?? "") ? (s as SectionId) : "profiles";
}

export function Settings({ ctx, params }: ScreenProps<"settings">) {
    const [section, setSection] = useState<SectionId>(() => asSection(params.section));
    useEffect(() => { if (params.section) setSection(asSection(params.section)); }, [params.section]);
    // Text-heavy screen: no artwork behind it (cleared again each time it becomes the visible entry).
    const backdrop = useBackdrop();
    const screenActive = useScreenActive();
    useEffect(() => { if (screenActive) backdrop.clear(); }, [screenActive, backdrop]);
    const navRef = useRef<HTMLElement>(null);
    const paneRef = useRef<HTMLDivElement>(null);

    /** Focus-follows-selection in the list, but ← from the pane lands on the ACTIVE section, never a neighbour. */
    const onItemFocus = (id: SectionId, e: FocusEvent<HTMLButtonElement>) => {
        const from = e.relatedTarget as Node | null;
        if (from && paneRef.current?.contains(from) && id !== section) {
            const cur = navRef.current?.querySelector<HTMLElement>(`[data-focus-key="set:sec:${section}"]`);
            if (cur) { focusEl(cur, false); return; }
        }
        setSection(id);
    };

    return (
        <div className="tv-screen" data-scroll="screen" data-testid="screen-settings">
            <ScreenHeader title={t("screen.settings")} sub={ctx.profiles.active ? t("set.forProfile", { name: ctx.profiles.active.name }) : undefined} />
            <div className="set-layout">
                <nav ref={navRef} className="set-nav" aria-label={t("screen.settings")}>
                    {SECTIONS.map((id) => (
                        <button key={id} type="button" className={`set-nav-item${id === section ? " is-active" : ""}`} data-focusable=""
                            data-focus-key={`set:sec:${id}`} data-testid={`set-sec-${id}`} aria-current={id === section ? "true" : undefined}
                            autoFocus={id === section}
                            onFocus={(e) => onItemFocus(id, e)} onClick={() => setSection(id)}>
                            <Icon name={ICONS[id]} />{t(`set.sec.${id}`)}
                        </button>
                    ))}
                </nav>
                <div ref={paneRef} className="set-pane" key={section}>
                    {section === "profiles" && <ProfilesSection ctx={ctx} />}
                    {section === "playback" && <PlaybackSection ctx={ctx} />}
                    {section === "subtitles" && <SubtitlesSection ctx={ctx} />}
                    {section === "language" && <LanguageSection />}
                    {section === "navigation" && <NavigationSection />}
                    {section === "screen" && <ScreenSection />}
                    {section === "sound" && <SoundSection />}
                    {section === "together" && <TogetherSection ctx={ctx} />}
                    {section === "server" && <ServerSection ctx={ctx} />}
                    {section === "account" && <AccountSection ctx={ctx} />}
                    {section === "cache" && <CacheSection ctx={ctx} />}
                    {section === "about" && <AboutSection ctx={ctx} />}
                </div>
            </div>
        </div>
    );
}
