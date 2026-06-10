"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveWatchPrefs } from "@/actions/watch-prefs";
import type { WatchPrefs } from "@/lib/watch-prefs";
import { ArrowDown, ArrowUp, X, Plus } from "lucide-react";

const REGION_OPTIONS = [
    "RO", "US", "GB", "DE", "FR", "ES", "IT", "NL", "PL", "HU", "BG", "MD",
];

const COMMON_SUBS = ["en-SDH", "en", "ro", "es", "fr", "de", "it", "pt", "pl", "hu"];

export function WatchPrefsPanel({ initial }: { initial: WatchPrefs }) {
    const [prefs, setPrefs] = useState<WatchPrefs>(initial);
    const [pending, startSave] = useTransition();

    function persist(next: Partial<WatchPrefs>) {
        const merged = { ...prefs, ...next, subtitleStyle: { ...prefs.subtitleStyle, ...(next.subtitleStyle ?? {}) } };
        setPrefs(merged);
        startSave(async () => {
            const r = await saveWatchPrefs(next);
            if (r.ok) toast.success("Preferințe salvate");
            else toast.error("Nu am putut salva");
        });
    }

    function toggleRegion(code: string) {
        const has = prefs.regions.includes(code);
        const nextRegions = has ? prefs.regions.filter((r) => r !== code) : [...prefs.regions, code];
        if (nextRegions.length === 0) return;
        const nextDefault = nextRegions.includes(prefs.defaultRegion) ? prefs.defaultRegion : nextRegions[0];
        persist({ regions: nextRegions, defaultRegion: nextDefault });
    }

    function setDefaultRegion(code: string) {
        if (!prefs.regions.includes(code)) return;
        persist({ defaultRegion: code });
    }

    function moveSub(idx: number, dir: -1 | 1) {
        const arr = [...prefs.subtitleLanguages];
        const j = idx + dir;
        if (j < 0 || j >= arr.length) return;
        [arr[idx], arr[j]] = [arr[j], arr[idx]];
        persist({ subtitleLanguages: arr });
    }
    function removeSub(idx: number) {
        const arr = prefs.subtitleLanguages.filter((_, i) => i !== idx);
        persist({ subtitleLanguages: arr });
    }
    function addSub(code: string) {
        if (!code || prefs.subtitleLanguages.includes(code)) return;
        persist({ subtitleLanguages: [...prefs.subtitleLanguages, code] });
    }

    return (
        <section className="prefs-panel" aria-busy={pending}>
            <h2 className="watch-row-title">Preferințe vizionare</h2>

            <fieldset className="prefs-group">
                <legend>Regiuni streaming</legend>
                <p className="prefs-hint">Selectează țările pentru care vrei să vezi furnizori (Netflix, HBO Max, Prime, …). Implicit: cea bifată ca default.</p>
                <div className="prefs-chips">
                    {REGION_OPTIONS.map((code) => {
                        const on = prefs.regions.includes(code);
                        const isDefault = prefs.defaultRegion === code;
                        return (
                            <button
                                key={code}
                                type="button"
                                disabled={pending}
                                onClick={() => toggleRegion(code)}
                                onDoubleClick={() => setDefaultRegion(code)}
                                className={`prefs-chip ${on ? "is-on" : ""} ${isDefault ? "is-default" : ""}`}
                                title={isDefault ? "Default — dublu-click pe alta pentru a o seta default" : "Click pentru toggle, dublu-click pentru default"}
                            >
                                {code}{isDefault ? " ★" : ""}
                            </button>
                        );
                    })}
                </div>
            </fieldset>

            <fieldset className="prefs-group">
                <legend>Subtitrare — limbi preferate</legend>
                <p className="prefs-hint">Ordinea contează: prima limbă găsită câștigă.</p>
                <ol className="prefs-sub-list">
                    {prefs.subtitleLanguages.map((lang, i) => (
                        <li key={lang}>
                            <span>{lang}</span>
                            <button type="button" onClick={() => moveSub(i, -1)} disabled={pending || i === 0} title="Sus"><ArrowUp size={14} /></button>
                            <button type="button" onClick={() => moveSub(i, +1)} disabled={pending || i === prefs.subtitleLanguages.length - 1} title="Jos"><ArrowDown size={14} /></button>
                            <button type="button" onClick={() => removeSub(i)} disabled={pending} title="Șterge"><X size={14} /></button>
                        </li>
                    ))}
                </ol>
                <div className="prefs-add-row">
                    {COMMON_SUBS.filter((c) => !prefs.subtitleLanguages.includes(c)).map((code) => (
                        <button key={code} type="button" onClick={() => addSub(code)} disabled={pending} className="prefs-chip">
                            <Plus size={12} /> {code}
                        </button>
                    ))}
                </div>
            </fieldset>

            <fieldset className="prefs-group">
                <legend>Comportament subtitrări</legend>
                <label className="prefs-row">
                    <input type="checkbox" checked={prefs.forceSdh} disabled={pending}
                        onChange={(e) => persist({ forceSdh: e.target.checked })} />
                    Preferă SDH/CC când există
                </label>
                <label className="prefs-row">
                    <input type="checkbox" checked={prefs.autoSearchSubtitles} disabled={pending}
                        onChange={(e) => persist({ autoSearchSubtitles: e.target.checked })} />
                    Caută automat pe OpenSubtitles dacă nu există potrivire
                </label>
                <label className="prefs-row">
                    <span>Offset implicit (s)</span>
                    <input type="number" step={0.1} value={prefs.subtitleOffsetSec} disabled={pending}
                        onChange={(e) => persist({ subtitleOffsetSec: parseFloat(e.target.value) || 0 })}
                        style={{ width: 90 }} />
                </label>
            </fieldset>

            <fieldset className="prefs-group">
                <legend>Stil subtitrare</legend>
                <label className="prefs-row">
                    <span>Dimensiune ({prefs.subtitleStyle.fontScale.toFixed(2)}x)</span>
                    <input type="range" min={0.5} max={2} step={0.05} value={prefs.subtitleStyle.fontScale}
                        disabled={pending}
                        onChange={(e) => persist({ subtitleStyle: { ...prefs.subtitleStyle, fontScale: parseFloat(e.target.value) } })} />
                </label>
                <label className="prefs-row">
                    <span>Contur</span>
                    <select value={prefs.subtitleStyle.outline} disabled={pending}
                        onChange={(e) => persist({ subtitleStyle: { ...prefs.subtitleStyle, outline: e.target.value as WatchPrefs["subtitleStyle"]["outline"] } })}>
                        <option value="none">fără</option>
                        <option value="thin">subțire</option>
                        <option value="thick">gros</option>
                    </select>
                </label>
                <label className="prefs-row">
                    <span>Fundal</span>
                    <select value={prefs.subtitleStyle.background} disabled={pending}
                        onChange={(e) => persist({ subtitleStyle: { ...prefs.subtitleStyle, background: e.target.value as WatchPrefs["subtitleStyle"]["background"] } })}>
                        <option value="none">fără</option>
                        <option value="soft">soft</option>
                        <option value="solid">solid</option>
                    </select>
                </label>
                <label className="prefs-row">
                    <span>Culoare</span>
                    <input type="color" value={prefs.subtitleStyle.color} disabled={pending}
                        onChange={(e) => persist({ subtitleStyle: { ...prefs.subtitleStyle, color: e.target.value } })} />
                </label>
            </fieldset>

            <style>{`
                .prefs-panel { padding: 1.5rem; display: grid; gap: 1.25rem; }
                .prefs-group { border: 1px solid var(--watch-border, #2a2a2a); border-radius: 12px; padding: 1rem; }
                .prefs-group legend { padding: 0 .5rem; color: var(--watch-fg-dim); font-size: .85rem; }
                .prefs-hint { color: var(--watch-fg-dim); font-size: .8rem; margin: .25rem 0 .75rem; }
                .prefs-chips { display: flex; flex-wrap: wrap; gap: .4rem; }
                .prefs-chip { padding: .35rem .6rem; border-radius: 999px; background: var(--watch-bg-2, #1a1a1a); color: var(--watch-fg-dim); border: 1px solid transparent; cursor: pointer; font-size: .8rem; display: inline-flex; gap: .25rem; align-items: center; }
                .prefs-chip:hover:not(:disabled) { border-color: var(--watch-accent, #6f6); }
                .prefs-chip.is-on { background: var(--watch-accent, #6f6); color: #0b1f0b; font-weight: 600; }
                .prefs-chip.is-default { outline: 2px solid #ffd700; }
                .prefs-sub-list { list-style: none; padding: 0; margin: .25rem 0; display: grid; gap: .35rem; }
                .prefs-sub-list li { display: flex; gap: .5rem; align-items: center; padding: .4rem .6rem; background: var(--watch-bg-2, #1a1a1a); border-radius: 8px; }
                .prefs-sub-list li span { flex: 1; font-family: monospace; }
                .prefs-sub-list li button { padding: .2rem .35rem; border-radius: 6px; background: transparent; color: var(--watch-fg-dim); border: 1px solid var(--watch-border, #2a2a2a); cursor: pointer; }
                .prefs-sub-list li button:hover:not(:disabled) { color: var(--watch-fg); }
                .prefs-add-row { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .5rem; }
                .prefs-row { display: flex; align-items: center; gap: .75rem; padding: .35rem 0; font-size: .9rem; }
                .prefs-row > span:first-child { min-width: 160px; color: var(--watch-fg-dim); }
            `}</style>
        </section>
    );
}
