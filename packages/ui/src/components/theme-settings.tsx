"use client";

import { useId, useState, type ReactNode } from "react";
import { Check, Laptop, Moon, Sun, Sparkles, Pipette } from "lucide-react";
import {
  ACCENTS,
  DENSITIES,
  LOCALES,
  MODES,
  MOTIONS,
  RADII,
  SURFACES,
  parseAccent,
  type Accent,
  type AccentPreset,
  type ThemePrefs,
} from "@mmo/design-tokens";
import { cn } from "../lib/cn";
import { useUiT } from "../i18n/index";
import { useThemePrefs } from "../theme/theme-provider";
import { Switch } from "./switch";
import { Label } from "./label";
import { Button } from "./button";
import { Badge } from "./badge";
import { Slider } from "./slider";
import { Input } from "./input";

// ─── Building blocks ────────────────────────────────────────────────────────

function Section({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("surface rounded-xl p-5 sm:p-6", className)}>
      <div className="mb-4">
        <h2 className="font-heading text-base font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

interface ChoiceProps<T extends string> {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; description?: ReactNode; icon?: ReactNode; preview?: ReactNode }>;
  onChange: (v: T) => void;
  columns?: 2 | 3 | 4;
  name: string;
}

/** Radio-like card group (visual, keyboard accessible). */
function ChoiceCards<T extends string>({ value, options, onChange, columns = 3, name }: ChoiceProps<T>) {
  return (
    <div role="radiogroup" aria-label={name} className={cn("grid gap-2", columns === 2 && "grid-cols-2", columns === 3 && "grid-cols-2 sm:grid-cols-3", columns === 4 && "grid-cols-2 sm:grid-cols-4")}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "group relative flex min-h-control-lg flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-[border-color,background-color,box-shadow] duration-(--dur-fast) ease-(--ease-out)",
              "hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
              active ? "border-primary bg-primary/8 shadow-[inset_0_0_0_1px_var(--primary)]" : "border-border",
            )}
          >
            {o.preview ? <div className="mb-1 w-full">{o.preview}</div> : null}
            <span className="flex w-full items-center gap-2 text-sm font-medium">
              {o.icon ? <span className="text-muted-foreground [&_svg]:size-4">{o.icon}</span> : null}
              {o.label}
              {active ? <Check className="ml-auto size-4 text-primary" aria-hidden /> : null}
            </span>
            {o.description ? <span className="text-xs text-muted-foreground">{o.description}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function SurfacePreview({ kind }: { kind: "glass" | "solid" | "flat" }) {
  return (
    <div className="relative h-14 w-full overflow-hidden rounded-md bg-gradient-accent/40" style={{ background: "linear-gradient(135deg, oklch(var(--primary-l) var(--primary-c) var(--accent-h) / 0.35), oklch(var(--primary-l) var(--primary-c) calc(var(--accent-h) + 45) / 0.35))" }}>
      <div
        className={cn(
          "absolute inset-x-3 top-3 h-12 rounded-md border",
          kind === "glass" && "border-white/15 bg-card/60 shadow-lg backdrop-blur-md",
          kind === "solid" && "border-border bg-card shadow-md",
          kind === "flat" && "border-foreground/20 bg-card",
        )}
      />
    </div>
  );
}

function AccentSwatch({ hue, active, label, onClick }: { hue: number; active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "relative size-9 rounded-full transition-transform duration-(--dur-fast) ease-(--ease-spring) hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
        active && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
      )}
      style={{ background: `oklch(var(--primary-l) var(--primary-c) ${hue})` }}
    >
      {active ? <Check className="absolute inset-0 m-auto size-4 text-primary-foreground" aria-hidden /> : null}
    </button>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export interface ThemeSettingsProps {
  /** Hide sections the host app manages elsewhere. */
  hide?: Array<"mode" | "accent" | "surface" | "density" | "radius" | "motion" | "feedback" | "locale">;
  /** Allow the "artwork" accent option (web NowPlaying/Watch). */
  allowArtworkAccent?: boolean;
  /** Extra sections appended at the end (app-specific). */
  children?: ReactNode;
  className?: string;
}

/**
 * Complete appearance panel: mode, accent (presets + custom hue + artwork),
 * surface, density, radius, motion, feedback, locale — with live preview.
 * Used by web Settings › Appearance, MixAI DJ settings and the Companion.
 */
export function ThemeSettings({ hide = [], allowArtworkAccent = false, children, className }: ThemeSettingsProps) {
  const t = useUiT();
  const { prefs, setPrefs, reset } = useThemePrefs();
  const show = (k: NonNullable<ThemeSettingsProps["hide"]>[number]) => !hide.includes(k);
  const parsed = parseAccent(prefs.accent);
  const [customHue, setCustomHue] = useState<number>(parsed.attr === "custom" && parsed.hue != null ? parsed.hue : 285);
  const hueId = useId();

  const modeIcons = { light: <Sun />, dark: <Moon />, system: <Laptop /> } as const;

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      {show("mode") && (
        <Section title={t("theme.mode")}>
          <ChoiceCards
            name={t("theme.mode")}
            value={prefs.mode}
            onChange={(mode) => setPrefs({ mode })}
            options={MODES.map((m) => ({ value: m, label: t(`theme.mode.${m}` as const), icon: modeIcons[m] }))}
          />
        </Section>
      )}

      {show("accent") && (
        <Section title={t("theme.accent")}>
          <div role="radiogroup" aria-label={t("theme.accent")} className="flex flex-wrap items-center gap-3">
            {(Object.keys(ACCENTS) as AccentPreset[]).map((k) => (
              <AccentSwatch key={k} hue={ACCENTS[k].hue} active={prefs.accent === k} label={ACCENTS[k].label[prefs.locale] ?? k} onClick={() => setPrefs({ accent: k })} />
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={parsed.attr === "custom"}
              aria-label={t("theme.accent.custom")}
              title={t("theme.accent.custom")}
              onClick={() => setPrefs({ accent: `custom:${customHue}` as Accent })}
              className={cn(
                "relative size-9 rounded-full transition-transform duration-(--dur-fast) hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
                parsed.attr === "custom" && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
              )}
              style={{ background: "conic-gradient(in oklch longer hue, oklch(0.7 0.19 0), oklch(0.7 0.19 360))" }}
            >
              <Pipette className="absolute inset-0 m-auto size-4 text-white drop-shadow" aria-hidden />
            </button>
            {allowArtworkAccent && (
              <button
                type="button"
                role="radio"
                aria-checked={prefs.accent === "artwork"}
                onClick={() => setPrefs({ accent: "artwork" })}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
                  prefs.accent === "artwork" ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground",
                )}
              >
                <Sparkles className="size-4" aria-hidden />
                {t("theme.accent.artwork")}
              </button>
            )}
          </div>
          {parsed.attr === "custom" && (
            <div className="mt-4 flex items-center gap-3">
              <Label htmlFor={hueId} className="w-16 shrink-0 text-sm">
                {t("theme.accent.hue")}
              </Label>
              <div className="relative flex-1">
                <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full" style={{ background: "linear-gradient(in oklch longer hue to right, oklch(0.7 0.19 0), oklch(0.7 0.19 360))" }} />
                <Slider
                  id={hueId}
                  min={0}
                  max={359}
                  step={1}
                  value={customHue}
                  onValueChange={(v) => {
                    const hue = Array.isArray(v) ? v[0] ?? 0 : v;
                    setCustomHue(hue);
                    setPrefs({ accent: `custom:${hue}` as Accent });
                  }}
                  className="[&_[data-slot=slider-indicator]]:bg-transparent [&_[data-slot=slider-track]]:bg-transparent"
                />
              </div>
              <Badge variant="outline" className="w-14 justify-center tabular-nums">
                {customHue}°
              </Badge>
            </div>
          )}
        </Section>
      )}

      {show("surface") && (
        <Section title={t("theme.surface")}>
          <ChoiceCards
            name={t("theme.surface")}
            value={prefs.surface}
            onChange={(surface) => setPrefs({ surface })}
            options={SURFACES.map((s) => ({
              value: s,
              label: t(`theme.surface.${s}` as const),
              description: t(`theme.surface.${s}Detail` as const),
              preview: <SurfacePreview kind={s} />,
            }))}
          />
        </Section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {show("density") && (
          <Section title={t("theme.density")}>
            <ChoiceCards columns={2} name={t("theme.density")} value={prefs.density} onChange={(density) => setPrefs({ density })} options={DENSITIES.map((d) => ({ value: d, label: t(`theme.density.${d}` as const) }))} />
          </Section>
        )}
        {show("radius") && (
          <Section title={t("theme.radius")}>
            <ChoiceCards
              columns={3}
              name={t("theme.radius")}
              value={prefs.radius}
              onChange={(radius) => setPrefs({ radius })}
              options={RADII.map((r) => ({
                value: r,
                label: t(`theme.radius.${r}` as const),
                preview: <div className={cn("h-8 w-full border-2 border-primary/60 bg-primary/10", r === "sm" && "rounded-[0.375rem]", r === "md" && "rounded-[0.625rem]", r === "lg" && "rounded-[1rem]")} />,
              }))}
            />
          </Section>
        )}
        {show("motion") && (
          <Section title={t("theme.motion")}>
            <ChoiceCards columns={2} name={t("theme.motion")} value={prefs.motion} onChange={(motion) => setPrefs({ motion })} options={MOTIONS.map((m) => ({ value: m, label: t(`theme.motion.${m}` as const) }))} />
          </Section>
        )}
        {show("locale") && (
          <Section title={t("theme.locale")}>
            <ChoiceCards columns={2} name={t("theme.locale")} value={prefs.locale} onChange={(locale) => setPrefs({ locale })} options={LOCALES.map((l) => ({ value: l, label: l === "ro" ? "Română" : "English" }))} />
          </Section>
        )}
      </div>

      {show("feedback") && (
        <Section title={t("theme.feedback")} description={t("theme.feedbackDetail")}>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="theme-feedback" className="text-sm">
              {t("theme.feedback")}
            </Label>
            <Switch id="theme-feedback" checked={prefs.feedback} onCheckedChange={(checked) => setPrefs({ feedback: checked })} />
          </div>
        </Section>
      )}

      {children}

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={reset}>
          {t("common.reset")}
        </Button>
      </div>
    </div>
  );
}

const PREVIEW_ROWS = [
  { title: "Neon Nocturne", artist: "Aurora Vale", bpm: "128", key: "8A" },
  { title: "Glass Corridor", artist: "Mirror Fields", bpm: "124", key: "3B" },
] as const;

/** Live preview card: shows how buttons, text, tables and surfaces look under the current prefs. */
export function ThemePreview({ className }: { className?: string }) {
  const t = useUiT();
  return (
    <div className={cn("surface flex flex-col gap-3 rounded-xl p-4", className)} aria-label={t("theme.preview")}>
      <div className="flex items-center justify-between">
        <span className="font-heading text-sm font-semibold">{t("theme.preview")}</span>
        <Badge variant="gradient">MixAI</Badge>
      </div>
      <div className="h-2 w-2/3 rounded-full bg-gradient-accent" />
      <p className="text-sm text-muted-foreground">Now playing · Neon Nocturne — 128 BPM · 8A</p>
      <div aria-hidden className="flex flex-col gap-3 select-none">
        <div data-slot="theme-preview-table" className="overflow-hidden rounded-lg border border-border">
          <div className="grid h-row grid-cols-[minmax(0,1fr)_3.5rem_3rem] items-center gap-2 bg-muted/50 px-3 text-xs font-medium text-muted-foreground">
            <span>Track</span>
            <span className="text-right">BPM</span>
            <span className="text-right">Key</span>
          </div>
          {PREVIEW_ROWS.map((r) => (
            <div key={r.title} className="grid h-row grid-cols-[minmax(0,1fr)_3.5rem_3rem] items-center gap-2 border-t border-border px-3 text-sm">
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate font-medium">{r.title}</span>
                <span className="truncate text-xs text-muted-foreground">{r.artist}</span>
              </span>
              <span className="text-right font-mono text-xs tabular-nums">{r.bpm}</span>
              <span className="flex justify-end">
                <Badge variant="secondary">{r.key}</Badge>
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" tabIndex={-1}>
            {t("common.save")}
          </Button>
          <Button size="sm" variant="secondary" tabIndex={-1}>
            {t("common.more")}
          </Button>
          <Button size="sm" variant="outline" tabIndex={-1}>
            {t("common.cancel")}
          </Button>
          <Input size="sm" tabIndex={-1} readOnly placeholder="Search tracks…" className="min-w-0 flex-1 basis-32" />
        </div>
      </div>
    </div>
  );
}

export type { ThemePrefs };
