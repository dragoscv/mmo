import * as React from "react";
import { cn } from "../lib/cn";
import {
  BRAND_GLYPHS,
  BRAND_LETTERING,
  BRAND_MARKS,
  BRAND_NAMES,
  BRAND_RUNS,
  type BrandGeometry,
  type BrandId,
} from "./generated/marks";

/**
 * MixAI marks as inline SVG. Geometry, lettering and motion come from `brand/src` through the generated
 * files in `./generated` (run `node brand/scripts/build.mjs`); colours come from the design tokens
 * (`--product-*`, `--mark-*`). Nothing here is drawn by hand.
 *
 * Animations (`animation` prop) are CSS, shipped in `@mmo/ui/styles.css`. Each one starts and ends on the
 * static mark and is switched off by `prefers-reduced-motion` and by `data-motion="reduced"`. To replay an
 * animation, change the element's `key`.
 */
export type BrandAnimation = "intro" | "loading" | "success" | "error" | "morph";

const TILE_RADIUS = 0.225;

function paints(product: BrandId, mono: boolean) {
  if (mono) return { a: "currentColor", b: "currentColor", dot: "currentColor" };
  const own = `var(--product-${product})`;
  return product === "mark" ? { a: "var(--mark-a)", b: "var(--mark-b)", dot: "var(--mark-signal)" } : { a: own, b: own, dot: "var(--mark-signal)" };
}

/** Optical size: a drawing of its own at 16 px and below, a heavier stroke up to 40 px. */
function optical(product: BrandId, px: number): { geo: BrandGeometry; w: number; r: number } {
  const set = BRAND_MARKS[product];
  if (px <= 16) return { geo: set.micro, w: set.micro.w, r: set.micro.dot[2] };
  const small = px <= 40;
  return { geo: set.master, w: set.master.w * (small ? 1.12 : 1), r: set.master.dot[2] * (small ? 1.06 : 1) };
}

function Symbol({ product, px, mono, animated }: { product: BrandId; px: number; mono: boolean; animated: boolean }) {
  const { geo, w, r } = animated ? { geo: BRAND_MARKS[product].master, w: BRAND_MARKS[product].master.w, r: BRAND_MARKS[product].master.dot[2] } : optical(product, px);
  const c = paints(product, mono);
  const last = geo.lines.length - 1;
  return (
    <g className="mixai-logo-body">
      {geo.lines.map((line, i) => (
        <path
          key={i}
          className="mixai-logo-line"
          style={{ "--i": last > 0 ? i / last : 0 } as React.CSSProperties}
          pathLength={1}
          d={line.d}
          fill="none"
          stroke={line.b ? c.b : c.a}
          strokeWidth={w}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      <g transform={`translate(${geo.dot[0]} ${geo.dot[1]})`}>
        <circle className="mixai-logo-dot" r={r} fill={c.dot} />
      </g>
    </g>
  );
}

export interface BrandMarkProps extends Omit<React.SVGAttributes<SVGSVGElement>, "children"> {
  /** `mark` = the MixAI family mark; otherwise a product glyph. */
  product?: BrandId;
  /** Rendered size in px (also picks the optical size). */
  size?: number;
  /** App-icon plate: the mark on the dark tile, in every theme. */
  tile?: boolean;
  /** One colour (`currentColor`) for lines and dot. */
  mono?: boolean;
  animation?: BrandAnimation;
  /** Hide from assistive technology (use when the name is written next to it). */
  decorative?: boolean;
  /** Accessible name; defaults to the product name. */
  label?: string;
}

export function BrandMark({ product = "mark", size = 32, tile = false, mono = false, animation, decorative = false, label, className, ...rest }: BrandMarkProps) {
  const grid = animation || size > 16 ? BRAND_MARKS[product].master.grid : BRAND_MARKS[product].micro.grid;
  const scale = tile ? (size <= 16 ? 1 : size <= 32 ? 0.875 : 0.8) : 1;
  const offset = (grid * (1 - scale)) / 2;
  const symbol = <Symbol product={product} px={size * scale} mono={mono} animated={Boolean(animation)} />;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${grid} ${grid}`}
      // the tile is a dark surface in every theme: `.dark` makes the dark token values apply inside it
      className={cn("mixai-logo shrink-0", tile && "dark", className)}
      data-anim={animation}
      data-product={product}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label ?? BRAND_NAMES[product] })}
      {...rest}
    >
      {tile ? <rect width={grid} height={grid} rx={grid * TILE_RADIUS} fill="var(--mark-tile)" /> : null}
      {scale === 1 ? symbol : <g transform={`translate(${offset} ${offset}) scale(${scale})`}>{symbol}</g>}
    </svg>
  );
}

export interface BrandLockupProps extends Omit<React.SVGAttributes<SVGSVGElement>, "children"> {
  /** `mark` = "MixAI"; a product = "MixAI <Product>". */
  product?: BrandId;
  /** Height in px; the width follows. */
  height?: number;
  /** Lettering only, without the symbol. */
  wordmarkOnly?: boolean;
  mono?: boolean;
  animation?: BrandAnimation;
  label?: string;
}

/** Symbol + outlined lettering on one line. The dot of the "i" is the signal. */
export function BrandLockup({ product = "mark", height = 32, wordmarkOnly = false, mono = false, animation, label, className, ...rest }: BrandLockupProps) {
  const L = BRAND_LETTERING;
  const s = L.lockup.capHeight / L.capHeight;
  const fg = mono ? "currentColor" : "var(--mark-signal)";
  const accent = mono ? "currentColor" : product === "mark" ? "var(--mark-b)" : `var(--product-${product})`;
  const brand = BRAND_RUNS.brand;
  const descriptor = product === "mark" ? null : BRAND_RUNS[product];
  const descriptorX = brand.advance + L.descriptorGap;
  const letters = brand.advance + (descriptor ? L.descriptorGap + descriptor.advance : 0);
  const x0 = wordmarkOnly ? 0 : 48 + L.lockup.gap;
  const width = x0 + letters * s;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={(height * width) / 48}
      height={height}
      viewBox={`0 0 ${Number(width.toFixed(2))} 48`}
      className={cn("mixai-logo shrink-0", className)}
      data-anim={animation}
      data-product={product}
      role="img"
      aria-label={label ?? BRAND_NAMES[product]}
      {...rest}
    >
      {wordmarkOnly ? null : <Symbol product={product} px={height} mono={mono} animated={Boolean(animation)} />}
      <g className="mixai-logo-letters" transform={`translate(${x0} ${L.lockup.baseline}) scale(${s})`}>
        {brand.glyphs.map(([glyph, x], i) => (
          <path key={`b${i}`} d={BRAND_GLYPHS[glyph]} transform={`translate(${x} 0)`} fill={i >= L.accentFrom ? accent : fg} />
        ))}
        <circle cx={L.iDot.x} cy={-L.iDot.y} r={L.iDot.r} fill={fg} />
        {descriptor?.glyphs.map(([glyph, x], i) => (
          <path key={`d${i}`} d={BRAND_GLYPHS[glyph]} transform={`translate(${descriptorX + x} 0)`} fill={fg} />
        ))}
      </g>
    </svg>
  );
}

export { BRAND_IDS, BRAND_MOTION_MS, BRAND_NAMES, type BrandId } from "./generated/marks";
