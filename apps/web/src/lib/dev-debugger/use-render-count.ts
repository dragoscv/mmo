"use client";

import { useEffect, useRef } from "react";
import { bumpRenderCount } from "./store";

/**
 * Count renders of a component and the time delta between them.
 * Call at the top of the component body. Zero cost when overlay is closed
 * (writes to a Map; no React state, no re-renders).
 */
export function useRenderCount(name: string) {
    bumpRenderCount(name);
    const lastRef = useRef(0);
    useEffect(() => {
        lastRef.current = performance.now();
    });
}
