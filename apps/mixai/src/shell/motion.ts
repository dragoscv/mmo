/**
 * One motion gate for the whole app: animations run only when the OS does not
 * ask for reduced motion, the user's theme pref is not "reduced", and the
 * governor has not cut animations to protect the frame budget.
 */
import { useSyncExternalStore } from "react";
import { useReducedMotion } from "motion/react";

const ATTRS = ["data-motion", "data-motion-governor"];

function subscribe(cb: () => void): () => void {
    if (typeof document === "undefined") return () => {};
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ATTRS });
    return () => mo.disconnect();
}

export function appMotionAllowed(): boolean {
    if (typeof document === "undefined") return true;
    const d = document.documentElement.dataset;
    return d.motion !== "reduced" && d.motionGovernor !== "reduced";
}

export function useMotionOK(): boolean {
    const osReduced = useReducedMotion();
    const app = useSyncExternalStore(subscribe, appMotionAllowed, () => true);
    return !osReduced && app;
}
