import { Fragment, forwardRef, type ChangeEvent, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "onChange" | "value"> & {
    size?: "sm" | "default";
    /** Radix-style controlled value */
    value?: string;
    /** Radix-style change handler */
    onValueChange?: (value: string) => void;
    /** Native change handler (for callers that need the event object) */
    onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
};

const Select = forwardRef<HTMLSelectElement, SelectProps>(
    ({ className, children, size = "default", value, onValueChange, onChange, ...props }, ref) => {
        return (
            <select
                data-slot="select"
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
                    size === "sm" ? "h-8 py-1 text-xs" : "h-9 py-1.5 text-sm",
                    className
                )}
                {...props}
            >
                {children}
            </select>
        );
    }
);
Select.displayName = "Select";

/**
 * Radix-compatible passthrough shims so callers can write
 *   <Select><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>...<SelectItem/></SelectContent></Select>
 * while we render a native <select>. SelectTrigger/Value/Content are no-op
 * wrappers; SelectItem renders an <option>.
 */
function SelectTrigger({ children }: { className?: string; children?: ReactNode }) {
    return <Fragment>{children}</Fragment>;
}
function SelectValue(_: { placeholder?: string }) { return null; }
function SelectContent({ children }: { children?: ReactNode }) {
    return <Fragment>{children}</Fragment>;
}
function SelectItem({ value, children, disabled }: { value: string; children?: ReactNode; disabled?: boolean }) {
    return <option value={value} disabled={disabled}>{children}</option>;
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
