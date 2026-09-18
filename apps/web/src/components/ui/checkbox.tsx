"use client";

/**
 * Compat wrapper over @mmo/ui Checkbox (Base UI button[role=checkbox]).
 * Legacy call sites used a native <input type=checkbox> with `onChange(e)`;
 * we synthesise `e.target.checked` so they keep working.
 */
import type * as React from "react";
import { Checkbox as UiCheckbox, type CheckboxProps as UiCheckboxProps } from "@mmo/ui";

type LegacyChangeEvent = { target: { checked: boolean }; currentTarget: { checked: boolean } };

export interface CheckboxProps extends Omit<UiCheckboxProps, "onChange"> {
    /** Legacy native-style handler. Prefer `onCheckedChange`. */
    onChange?: (event: LegacyChangeEvent) => void;
}

export function Checkbox({ onChange, onCheckedChange, ...props }: CheckboxProps) {
    const handle: UiCheckboxProps["onCheckedChange"] = (checked, details) => {
        onCheckedChange?.(checked, details);
        if (onChange) {
            const ev = { target: { checked }, currentTarget: { checked } };
            onChange(ev);
        }
    };
    return <UiCheckbox onCheckedChange={handle} {...(props as React.ComponentProps<typeof UiCheckbox>)} />;
}