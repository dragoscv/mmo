import * as React from "react";
import { cn } from "@/lib/utils";

function Checkbox({
    className,
    ...props
}: React.ComponentProps<"input">) {
    return (
        <input
            type="checkbox"
            data-slot="checkbox"
            className={cn(
                "h-4 w-4 shrink-0 cursor-pointer rounded border border-input bg-card accent-purple-500 transition-colors",
                "checked:bg-purple-500 checked:border-purple-500",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
                "dark:bg-input/30 dark:border-input",
                className
            )}
            {...props}
        />
    );
}

export { Checkbox };
