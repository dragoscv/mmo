/**
 * Motion presets for `motion` v13. Durations read the CSS tokens at call time so
 * `data-motion="reduced"` and `prefers-reduced-motion` zero them out consistently.
 */
import type { Transition, Variants } from "motion/react";

function cssMs(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(v);
  return Number.isFinite(n) ? n / 1000 : fallback / 1000;
}

export const easeOut = [0.16, 1, 0.3, 1] as const;
export const easeInOut = [0.4, 0, 0.2, 1] as const;

export const spring: Transition = { type: "spring", stiffness: 380, damping: 32, mass: 0.9 };
export const springSoft: Transition = { type: "spring", stiffness: 220, damping: 28 };

export function fast(): Transition {
  return { duration: cssMs("--dur-fast", 120), ease: easeOut };
}
export function base(): Transition {
  return { duration: cssMs("--dur-base", 220), ease: easeOut };
}
export function slow(): Transition {
  return { duration: cssMs("--dur-slow", 400), ease: easeOut };
}

export const fade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

export const rise: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};

export const scale: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 },
};

export const slideUp: Variants = {
  initial: { y: "100%" },
  animate: { y: 0 },
  exit: { y: "100%" },
};

export const stagger = (children = 0.04, delay = 0): Transition => ({
  staggerChildren: children,
  delayChildren: delay,
});

/** Parent variant for staggered lists — children use `rise`. */
export const list: Variants = {
  initial: {},
  animate: { transition: stagger() },
};

export * from "./page-transition.tsx";
