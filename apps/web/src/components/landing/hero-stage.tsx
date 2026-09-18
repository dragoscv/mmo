"use client";

/**
 * Animated hero for the unauthenticated landing at `/`.
 *
 *  - Living background: two blurred accent blobs drifting slowly. Rendered as
 *    `motion.div` only when the OS does not ask for reduced motion AND the
 *    user's motion pref is "full"; otherwise a static blob (no animation).
 *  - Choreographed entrance: title → subtitle → CTA row → feature cards with
 *    the shared `rise` preset (0 / 0.08 / 0.16 / 0.28 s, cards +0.06 s each).
 *
 * Only the hero is a client component; the server parent resolves copy.
 */
import type { ReactNode } from "react";
import { motion, useReducedMotion, type Transition } from "motion/react";
import { useThemePrefs } from "@mmo/ui/theme";
import { rise, easeOut } from "@mmo/ui/motion";
import { cn } from "@mmo/ui";

export interface HeroFeature {
    icon: ReactNode;
    title: string;
    description: string;
}

interface HeroStageProps {
    eyebrow: string;
    title: string;
    subtitle: string;
    /** Primary CTA (already interactive, e.g. <SignInButton />). */
    primary: ReactNode;
    /** Secondary CTA (e.g. a Link-rendered Button). */
    secondary?: ReactNode;
    features: HeroFeature[];
}

const RISE_DURATION = 0.5;
const DELAYS = { title: 0, subtitle: 0.08, cta: 0.16, cards: 0.28, cardStep: 0.06 } as const;

function riseAt(delay: number): Transition {
    return { duration: RISE_DURATION, ease: easeOut, delay };
}

function Blobs({ animated }: { animated: boolean }) {
    // Blobs are sized with viewport-relative clamps and pinned by percentage
    // offsets inside an `overflow-hidden` wrapper, so they can never widen the
    // document at 390 or 3440 px. Opacity: ≤0.25 light, ≤0.4 dark.
    const base =
        "pointer-events-none absolute rounded-full bg-gradient-accent blur-3xl opacity-25 dark:opacity-40";
    const a = cn(base, "-top-[20%] -left-[10%] size-[clamp(18rem,45vw,40rem)]");
    const b = cn(base, "-right-[10%] -bottom-[25%] size-[clamp(16rem,40vw,36rem)] rotate-45");
    if (!animated) {
        return (
            <div aria-hidden className="absolute inset-0 overflow-hidden">
                <div className={a} />
                <div className={b} />
            </div>
        );
    }
    return (
        <div aria-hidden className="absolute inset-0 overflow-hidden">
            <motion.div
                className={a}
                animate={{ x: [0, 40, 0], y: [0, -30, 0] }}
                transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
                className={b}
                animate={{ x: [0, -35, 0], y: [0, 25, 0] }}
                transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
            />
        </div>
    );
}

export function HeroStage({ eyebrow, title, subtitle, primary, secondary, features }: HeroStageProps) {
    const reduced = useReducedMotion();
    const { prefs } = useThemePrefs();
    const animated = !reduced && prefs.motion === "full";

    // Under reduced motion every element is rendered in its final state.
    const initial = animated ? "initial" : false;

    return (
        <section className="relative isolate w-full overflow-hidden">
            <Blobs animated={animated} />

            <div className="relative mx-auto flex w-full max-w-(--content-lg) flex-col items-center gap-10 px-4 py-16 text-center sm:px-6 sm:py-24 lg:px-8">
                <div className="flex max-w-3xl flex-col items-center gap-5">
                    <motion.p
                        variants={rise}
                        initial={initial}
                        animate="animate"
                        transition={riseAt(DELAYS.title)}
                        className="font-mono text-xs tracking-[0.2em] uppercase text-muted-foreground"
                    >
                        {eyebrow}
                    </motion.p>
                    <motion.h1
                        variants={rise}
                        initial={initial}
                        animate="animate"
                        transition={riseAt(DELAYS.title)}
                        className="font-heading text-gradient-brand text-4xl font-semibold tracking-tight text-balance sm:text-6xl"
                    >
                        {title}
                    </motion.h1>
                    <motion.p
                        variants={rise}
                        initial={initial}
                        animate="animate"
                        transition={riseAt(DELAYS.subtitle)}
                        className="max-w-2xl text-base text-muted-foreground text-pretty sm:text-lg"
                    >
                        {subtitle}
                    </motion.p>
                    <motion.div
                        variants={rise}
                        initial={initial}
                        animate="animate"
                        transition={riseAt(DELAYS.cta)}
                        className="flex flex-wrap items-center justify-center gap-3 pt-2"
                    >
                        {primary}
                        {secondary}
                    </motion.div>
                </div>

                <ul className="grid w-full grid-cols-1 gap-4 sm:grid-cols-3">
                    {features.map((f, i) => (
                        <motion.li
                            key={f.title}
                            variants={rise}
                            initial={initial}
                            animate="animate"
                            transition={riseAt(DELAYS.cards + i * DELAYS.cardStep)}
                            className="surface flex flex-col items-start gap-3 rounded-2xl p-5 text-left"
                        >
                            <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground [&_svg]:size-5">
                                {f.icon}
                            </span>
                            <h2 className="font-heading text-base font-semibold">{f.title}</h2>
                            <p className="text-sm text-muted-foreground text-pretty">{f.description}</p>
                        </motion.li>
                    ))}
                </ul>
            </div>
        </section>
    );
}
