/**
 * The latency budget, on the performance screen (key `L`).
 *
 * A peek, not a mode: it pauses nothing and the show keeps running behind it. What it shows is the
 * two figures that must never be confused — what the engine declares per stage (a sum of what it
 * controls) and what the probe measured through the loopback — with the difference named: driver, OS
 * and routing. Reading it during a soundcheck is the point of having it here rather than one dialog
 * deep.
 */
import { X } from "lucide-react";
import { Button } from "@mmo/ui";
import { useT } from "../i18n";
import { latencyBudget } from "../lib/latency-budget";
import { useMeterSample } from "../lib/meter-bus";
import { useStore } from "../store";

export function LatencyOverlay() {
    const t = useT();
    const info = useStore((s) => s.start?.info ?? null);
    const measured = useStore((s) => s.measuredRoundTripMs);
    const close = useStore((s) => s.toggleLatencyOverlay);
    const meters = useMeterSample(4);
    const budget = latencyBudget(info, meters, measured);

    return (
        <section
            role="group"
            aria-label={t("latencyOverlay.title")}
            className="surface pointer-events-auto fixed end-3 top-16 z-30 w-72 rounded-2xl p-3 text-sm shadow-lg backdrop-blur"
        >
            <header className="mb-2 flex items-center gap-2">
                <h2 className="font-heading text-sm font-semibold">{t("latencyOverlay.title")}</h2>
                <Button
                    variant="ghost"
                    size="icon"
                    className="ms-auto size-6"
                    onClick={() => close(false)}
                    aria-label={t("latencyOverlay.close")}
                >
                    <X />
                </Button>
            </header>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
                {budget.rows.map((r) => (
                    <div key={r.id} className="col-span-2 grid grid-cols-subgrid">
                        <dt className="text-muted-foreground">{t(`setup.budget${r.id}`)}</dt>
                        <dd className="text-end">{r.ms.toFixed(2)} ms</dd>
                    </div>
                ))}
                <div className="col-span-2 mt-1 grid grid-cols-subgrid border-t pt-1">
                    <dt className="font-medium">{t("setup.budgetDeclared")}</dt>
                    <dd className="text-end font-medium">{budget.declaredMs.toFixed(2)} ms</dd>
                </div>
                {budget.declaredEarsMs !== budget.declaredMs ? (
                    <div className="col-span-2 grid grid-cols-subgrid">
                        <dt className="text-muted-foreground">{t("setup.budgetDeclaredEars")}</dt>
                        <dd className="text-end">{budget.declaredEarsMs.toFixed(2)} ms</dd>
                    </div>
                ) : null}
                {budget.measuredMs != null ? (
                    <>
                        <div className="col-span-2 grid grid-cols-subgrid border-t pt-1">
                            <dt>{t("setup.budgetMeasured")}</dt>
                            <dd className="text-end">{budget.measuredMs.toFixed(2)} ms</dd>
                        </div>
                        <div className="col-span-2 grid grid-cols-subgrid">
                            <dt className="text-muted-foreground">{t("setup.budgetRest")}</dt>
                            <dd className="text-end">{(budget.restMs ?? 0).toFixed(2)} ms</dd>
                        </div>
                    </>
                ) : (
                    <p className="col-span-2 mt-1 text-xs text-muted-foreground">{t("latencyOverlay.noMeasurement")}</p>
                )}
            </dl>
            <p className="mt-2 text-[11px] leading-tight text-muted-foreground">{t("latencyOverlay.hint")}</p>
        </section>
    );
}
