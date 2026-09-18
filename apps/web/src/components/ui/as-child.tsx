"use client";

/**
 * Radix → Base UI compat: Base UI has no `asChild`; it uses `render={<El/>}`.
 * `withAsChild` wraps a Base UI component so legacy call sites that pass
 * `asChild` + a single child element keep working (child becomes `render`).
 */

import * as React from "react";

export type AsChildProps<P> = Omit<P, "asChild"> & { asChild?: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withAsChild<P extends object>(Comp: React.ComponentType<any>, displayName: string) {
    function AsChildCompat(props: AsChildProps<P>) {
        const { asChild, children, ...rest } = props as AsChildProps<P> & { children?: React.ReactNode };
        if (asChild && React.isValidElement(children)) {
            const child = children as React.ReactElement<{ children?: React.ReactNode }>;
            return React.createElement(Comp, { ...rest, render: child }, child.props.children);
        }
        return React.createElement(Comp, rest, children);
    }
    AsChildCompat.displayName = displayName;
    return AsChildCompat as React.FC<AsChildProps<P>>;
}
