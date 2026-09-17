"use client";

import { AnimatePresence, motion as m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { base, rise } from "./index";

export interface PageTransitionProps {
  /** Change this (e.g. pathname) to animate between pages. */
  id: string;
  children: ReactNode;
  className?: string;
}

/**
 * Motion-based page cross-fade for surfaces without React 19.3 <ViewTransition>
 * routing (mixai, companion). apps/web uses Next's viewTransition instead.
 */
export function PageTransition({ id, children, className }: PageTransitionProps) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.div
        key={id}
        className={className}
        variants={reduced ? undefined : rise}
        initial="initial"
        animate="animate"
        exit="exit"
        transition={base()}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}
