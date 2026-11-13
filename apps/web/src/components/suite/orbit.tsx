import { BrandMark } from "@mmo/ui";
import { SUITE_PRODUCTS } from "./products";

/**
 * Hero subject (WP17-12): the MixAI Server as a breathing core with TV / Music / Studio / Decks orbiting on two
 * tilted rings, each as its app icon (dark tile, mark in the product colour; brand/BRAND.md). The core carries the
 * Server mark on the Server colour. Pure CSS (transform + opacity only, GPU-cheap); reduced motion freezes it
 * (suite.css).
 */
export function SuiteOrbit({ label }: { label: string }) {
    const planets = SUITE_PRODUCTS.filter((p) => p.key !== "server");
    // Two rings, two planes (WP22-17): `rx` is how far each is inclined away from the screen, `tilt` the turn
    // inside its own plane. Different values make the ellipses cross; equal ones would only shift the icons.
    const rings = [
        { inset: "14%", rx: "62deg", tilt: "-16deg", dur: "46s", items: planets.slice(0, 2) },
        { inset: "2%", rx: "74deg", tilt: "24deg", dur: "64s", items: planets.slice(2) },
    ];
    return (
        <div className="sx-orbit" role="img" aria-label={label}>
            {rings.map((r, ri) => (
                <div key={ri} className="sx-ring" aria-hidden style={{ ["--inset" as string]: r.inset, ["--rx" as string]: r.rx, ["--tilt" as string]: r.tilt, ["--ri" as string]: ri }}>
                    <div className="sx-ring-spin" style={{ ["--dur" as string]: r.dur, animationDirection: ri ? "reverse" : "normal" }}>
                        {r.items.map((p, i) => {
                            // Start angles (the ring's own tilt adds to them): inner ring 102° / 282° = its left
                            // and right ends, outer ring 17° / 197° = upper right and lower left. In this frame
                            // the four icons are clear of the core and of each other; with reduced motion it is
                            // the permanent picture (measured: docs/design-critic/wp22-brand.md).
                            const a = `${(360 / r.items.length) * i + (ri ? 17 : 102)}deg`;
                            return (
                                <div key={p.key} className="sx-planet" style={{ ["--a" as string]: a }}>
                                    <div className="sx-planet-body" style={{ ["--dur" as string]: r.dur, ["--dir" as string]: ri ? "reverse" : "normal", ["--i" as string]: ri ? i : i + 2 }}>
                                        <BrandMark product={p.brand} size={56} tile decorative />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
            <div className="sx-core" aria-hidden>
                {/* One colour: the core is the Server colour, the mark takes the page background (suite.css).
                    The mark plays its `intro` once as the hero starts (brand/BRAND.md); the planets follow it. */}
                <BrandMark product="server" size={64} mono decorative animation="intro" className="size-[38%]" />
            </div>
        </div>
    );
}
