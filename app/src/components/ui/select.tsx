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
                "bg-[length:16px_16px] bg-[right_0.5rem_center] bg-no-repeat",
                "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')]",
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
