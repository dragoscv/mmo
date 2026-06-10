"use client";

import { useCinemaSettings } from "@/hooks/use-cinema-settings";
import { EQ_PRESETS } from "@/lib/eq-engine";

/** UI for cinema (video) settings. Reads from the same localStorage-backed
 *  store used by `VideoPlayerHost`. */
export function CinemaSettingsPanel() {
    const s = useCinemaSettings();

    const langOptions = ["en", "ro", "fr", "de", "es", "it", "pt", "ja", "ko", "zh"];

    return (
        <div className="space-y-4">
            <Row
                label="Auto-play next episode"
                hint="Avansează automat la următorul episod când unul se termină."
            >
                <input
                    type="checkbox"
                    checked={s.autoplayNextEpisode}
                    onChange={(e) => s.update({ autoplayNextEpisode: e.target.checked })}
                />
            </Row>

            <Row
                label="Countdown auto-play (secunde)"
                hint="0 = treci instant. Altă valoare = afișează countdown cu „Play now” / „Cancel”."
            >
                <input
                    type="number"
                    min={0}
                    max={30}
                    value={s.autoplayCountdownSec}
                    onChange={(e) => s.update({ autoplayCountdownSec: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })}
                    className="w-20 rounded border border-border bg-background px-2 py-1 text-sm"
                />
            </Row>

            <Row
                label="Limbi subtitrare (prioritate)"
                hint="Prima care există e selectată automat. Lista e CSV."
            >
                <input
                    type="text"
                    value={s.subtitleLangPriority.join(", ")}
                    onChange={(e) => s.update({ subtitleLangPriority: e.target.value.split(",").map(x => x.trim().toLowerCase()).filter(Boolean) })}
                    className="w-48 rounded border border-border bg-background px-2 py-1 text-sm"
                    placeholder={langOptions.slice(0, 4).join(", ")}
                />
            </Row>

            <Row label="Preferă SDH (Closed Captions)" hint="Include indicii sonore pentru deficient de auz.">
                <input
                    type="checkbox"
                    checked={s.preferSdh}
                    onChange={(e) => s.update({ preferSdh: e.target.checked })}
                />
            </Row>

            <Row
                label="Auto-detach la navigare"
                hint="Când pleci de pe /watch/*, videoul trece automat în PiP."
            >
                <input
                    type="checkbox"
                    checked={s.autoDetachOnNavigate}
                    onChange={(e) => s.update({ autoDetachOnNavigate: e.target.checked })}
                />
            </Row>

            <Row
                label="Persistă peste reload"
                hint="Reia videoul + poziția după refresh."
            >
                <input
                    type="checkbox"
                    checked={s.persistAcrossReload}
                    onChange={(e) => s.update({ persistAcrossReload: e.target.checked })}
                />
            </Row>

            <Row label="Pauză când tab-ul nu e vizibil" hint="">
                <input
                    type="checkbox"
                    checked={s.pauseOnHidden}
                    onChange={(e) => s.update({ pauseOnHidden: e.target.checked })}
                />
            </Row>

            <Row
                label="Scurtături tastatură"
                hint="Space/K · J/L · ←/→ · ↑/↓ · F · P · Shift+N · M · C"
            >
                <input
                    type="checkbox"
                    checked={s.enableShortcuts}
                    onChange={(e) => s.update({ enableShortcuts: e.target.checked })}
                />
            </Row>

            <Row
                label="EQ preset pentru video"
                hint="Aplicat automat când începe un video; restaurat la închidere."
            >
                <select
                    value={s.cinemaEqPreset ?? ""}
                    onChange={(e) => s.update({ cinemaEqPreset: e.target.value || null })}
                    className="rounded border border-border bg-background px-2 py-1 text-sm"
                >
                    <option value="">— niciunul —</option>
                    {EQ_PRESETS.map((p) => (
                        <option key={p.name} value={p.name}>{p.icon} {p.name}</option>
                    ))}
                </select>
            </Row>

            <Row
                label="Detectare intro cu chromaprint"
                hint="Folosește fpcalc (dacă e instalat pe companion) pentru o detectare mai precisă a intro-ului. Cade pe silence-detect dacă lipsește."
            >
                <input
                    type="checkbox"
                    checked={s.useChromaprintIntro}
                    onChange={(e) => s.update({ useChromaprintIntro: e.target.checked })}
                />
            </Row>

            <Row
                label="Normalizare volum (EBU R128)"
                hint="Aliniază nivelul percepției la −23 LUFS pentru toate filmele. Necesită analiza pe companion (rulează automat la prima redare)."
            >
                <input
                    type="checkbox"
                    checked={s.loudnessNormalization}
                    onChange={(e) => s.update({ loudnessNormalization: e.target.checked })}
                />
            </Row>

            <Row
                label="Sleep timer (minute)"
                hint="Oprește redarea automat după N minute. 0 / gol = dezactivat."
            >
                <input
                    type="number"
                    min={0}
                    max={240}
                    value={s.sleepTimerMin ?? 0}
                    onChange={(e) => {
                        const n = Math.max(0, Math.min(240, Number(e.target.value) || 0));
                        s.update({ sleepTimerMin: n > 0 ? n : null });
                    }}
                    className="w-20 rounded border border-border bg-background px-2 py-1 text-sm"
                />
            </Row>

            <div className="pt-2">
                <button
                    type="button"
                    onClick={() => s.reset()}
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                >
                    Reset la valori implicite
                </button>
            </div>
        </div>
    );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div>
                <div className="text-sm font-medium">{label}</div>
                {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}
