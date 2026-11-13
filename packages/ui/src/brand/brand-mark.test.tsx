import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BRAND_IDS, BRAND_NAMES, BrandLockup, BrandMark } from "./brand-mark";
import { BRAND_GLYPHS, BRAND_MARKS, BRAND_RUNS } from "./generated/marks";

afterEach(cleanup);

describe("BrandMark", () => {
  it("names every mark for assistive technology and draws lines plus exactly one signal dot", () => {
    for (const id of BRAND_IDS) {
      const { container, unmount } = render(<BrandMark product={id} size={64} />);
      const svg = screen.getByRole("img", { name: BRAND_NAMES[id] });
      expect(svg).toHaveAttribute("viewBox", "0 0 48 48");
      expect(container.querySelectorAll(".mixai-logo-line")).toHaveLength(BRAND_MARKS[id].master.lines.length);
      expect(container.querySelectorAll(".mixai-logo-dot")).toHaveLength(1);
      unmount();
    }
  });

  it("uses the product colour token for a glyph and the two stream colours for the family mark", () => {
    const { container, rerender } = render(<BrandMark product="decks" size={48} />);
    const strokes = () => [...container.querySelectorAll(".mixai-logo-line")].map((p) => p.getAttribute("stroke"));
    expect(new Set(strokes())).toEqual(new Set(["var(--product-decks)"]));
    expect(container.querySelector(".mixai-logo-dot")).toHaveAttribute("fill", "var(--mark-signal)");
    rerender(<BrandMark product="mark" size={48} />);
    expect(strokes()).toEqual(["var(--mark-a)", "var(--mark-b)"]);
  });

  it("switches to the 16-unit drawing at 16 px and to a heavier stroke up to 40 px", () => {
    const { container, rerender } = render(<BrandMark size={16} />);
    expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 16 16");
    expect(container.querySelector(".mixai-logo-line")).toHaveAttribute("d", BRAND_MARKS.mark.micro.lines[0]!.d);
    rerender(<BrandMark size={24} />);
    expect(Number(container.querySelector(".mixai-logo-line")!.getAttribute("stroke-width"))).toBeCloseTo(BRAND_MARKS.mark.master.w * 1.12);
    rerender(<BrandMark size={96} />);
    expect(Number(container.querySelector(".mixai-logo-line")!.getAttribute("stroke-width"))).toBe(BRAND_MARKS.mark.master.w);
  });

  it("tile draws the plate and forces the dark token values; mono paints with currentColor", () => {
    const { container, rerender } = render(<BrandMark product="tv" size={64} tile />);
    expect(container.querySelector("rect")).toHaveAttribute("fill", "var(--mark-tile)");
    expect(container.querySelector("svg")).toHaveClass("dark");
    rerender(<BrandMark product="tv" size={64} mono />);
    expect(container.querySelector("rect")).toBeNull();
    expect(container.querySelector(".mixai-logo-line")).toHaveAttribute("stroke", "currentColor");
    expect(container.querySelector(".mixai-logo-dot")).toHaveAttribute("fill", "currentColor");
  });

  it("decorative marks are hidden; an animation sets data-anim and spreads the lines from 0 to 1", () => {
    const { container, rerender } = render(<BrandMark decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    rerender(<BrandMark product="live" size={16} animation="loading" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("data-anim", "loading");
    expect(svg).toHaveAttribute("viewBox", "0 0 48 48"); // animated marks always use the master drawing
    const positions = [...container.querySelectorAll<SVGPathElement>(".mixai-logo-line")].map((p) => p.style.getPropertyValue("--i"));
    expect(positions[0]).toBe("0");
    expect(positions.at(-1)).toBe("1");
  });
});

describe("BrandLockup", () => {
  it("is one image named after the product, with the name outlined (no <text>)", () => {
    const { container } = render(<BrandLockup product="keybpm" height={40} />);
    expect(screen.getByRole("img", { name: "MixAI Key & BPM" })).toBeInTheDocument();
    expect(container.querySelector("text")).toBeNull();
    expect(container.querySelector(".mixai-logo-letters")!.getAttribute("transform")).toMatch(/^translate\(60 36\) scale\(/);
    const letters = container.querySelectorAll(".mixai-logo-letters path");
    expect(letters).toHaveLength(BRAND_RUNS.brand.glyphs.length + BRAND_RUNS.keybpm.glyphs.length);
  });

  it("colours AI with the accent and replaces the dot of the i with the signal", () => {
    const { container } = render(<BrandLockup product="music" />);
    const fills = [...container.querySelectorAll(".mixai-logo-letters path")].slice(0, 5).map((p) => p.getAttribute("fill"));
    expect(fills).toEqual(["var(--mark-signal)", "var(--mark-signal)", "var(--mark-signal)", "var(--product-music)", "var(--product-music)"]);
    expect(container.querySelectorAll(".mixai-logo-letters circle")).toHaveLength(1);
    // the generated "i" has no dot of its own: one closed contour only
    expect(BRAND_GLYPHS["700i"]!.match(/Z/g)).toHaveLength(1);
  });

  it("wordmarkOnly drops the symbol and starts the letters at 0", () => {
    const { container } = render(<BrandLockup wordmarkOnly />);
    expect(container.querySelector(".mixai-logo-body")).toBeNull();
    expect(container.querySelector(".mixai-logo-letters")!.getAttribute("transform")).toMatch(/^translate\(0 36\)/);
  });
});
