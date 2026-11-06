import { Server } from "lucide-react";
import { SUITE_PRODUCTS } from "./products";

/**
 * Hero subject (WP17-12): the MixAI Server as a breathing core with TV / Music / Studio / DJ orbiting on two
 * tilted rings. Pure CSS (transform + opacity only, GPU-cheap); reduced motion freezes it (suite.css).
 */
export function SuiteOrbit({ label }: { label: string }) {
    const planets = SUITE_PRODUCTS.filter((p) => p.key !== "server");
    const rings = [
        { inset: "14%", tilt: "-12deg", dur: "46s", items: planets.slice(0, 2) },
        { inset: "2%", tilt: "18deg", dur: "64s", items: planets.slice(2) },
    ];
    return (
        <div className="sx-orbit" role="img" aria-label={label}>
            <div className="sx-stars" aria-hidden />
            {rings.map((r, ri) => (
                <div key={ri} className="sx-ring" aria-hidden style={{ ["--inset" as string]: r.inset, ["--tilt" as string]: r.tilt }}>
                    <div className="sx-ring-spin" style={{ ["--dur" as string]: r.dur, animationDirection: ri ? "reverse" : "normal" }}>
                        {r.items.map((p, i) => {
                            const Icon = p.icon;
                            const a = `${(360 / r.items.length) * i + ri * 40}deg`;
                            return (
                                <div key={p.key} className="sx-planet" style={{ ["--a" as string]: a }}>
                                    <div className="sx-planet-body" style={{ ["--c" as string]: p.accent, ["--dur" as string]: r.dur, animationDirection: ri ? "reverse" : "normal" }}>
                                        <Icon aria-hidden />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
            <div className="sx-core" aria-hidden>
                <Server className="size-[38%]" />
            </div>
        </div>
    );
}
