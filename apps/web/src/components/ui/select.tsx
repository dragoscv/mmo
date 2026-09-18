"use client";

/**
 * Select: the real Base UI Select from @mmo/ui (Trigger/Value/Content/Item tree).
 * `NativeSelect` keeps the previous native <select> shim for call sites that
 * render <option> children and need the change event.
 */
import { forwardRef, type ChangeEvent, type ComponentProps, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { Select as UiSelect } from "@mmo/ui";

export { SelectGroup, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectLabel, SelectSeparator } from "@mmo/ui";

type UiSelectProps = ComponentProps<typeof UiSelect<string, false>>;
export interface SelectProps extends Omit<UiSelectProps, "onValueChange" | "value" | "multiple"> {
    value?: string;
    /** Radix-compatible: always a string (Base UI's `null` → ""). */
    onValueChange?: (value: string) => void;
}

/** Single-value Base UI Select with a Radix-shaped `onValueChange(value: string)`. */
export function Select({ onValueChange, ...props }: SelectProps) {
    return <UiSelect<string, false> onValueChange={onValueChange ? (v) => onValueChange(v ?? "") : undefined} {...props} />;
}

export type NativeSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "onChange" | "value"> & {
    size?: "sm" | "default";
    value?: string;
    onValueChange?: (value: string) => void;
    onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
};

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(
    ({ className, children, size = "default", value, onValueChange, onChange, ...props }, ref) => (
        <select
            data-slot="native-select"
            ref={ref}
            value={value}
            onChange={(e) => {
                onValueChange?.(e.currentTarget.value);
                onChange?.(e);
            }}
            className={cn(
                "flex w-full appearance-none rounded-md border border-input bg-card px-3 text-foreground shadow-xs transition-[color,box-shadow] outline-none",
                "bg-[length:16px_16px] bg-[right_0.5rem_center] bg-no-repeat select-chevron",
                "pr-8 cursor-pointer",
                "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
                "dark:bg-input/30 dark:hover:bg-input/50",
                "[&>option]:bg-card [&>option]:text-foreground [&>optgroup]:bg-card",
                size === "sm" ? "h-control-sm py-1 text-xs" : "h-control py-1.5 text-sm",
                className
            )}
            {...props}
        >
            {children}
        </select>
    )
);
NativeSelect.displayName = "NativeSelect";