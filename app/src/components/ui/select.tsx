import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const Select = forwardRef<
    HTMLSelectElement,
    Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: "sm" | "default" }
>(({ className, children, size = "default", ...props }, ref) => {
    return (
        <select
            data-slot="select"
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
            ref={ref}
            {...props}
        >
            {children}
        </select>
    );
});
Select.displayName = "Select";

export { Select };
