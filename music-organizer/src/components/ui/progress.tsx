import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const Progress = forwardRef<
    HTMLDivElement,
    HTMLAttributes<HTMLDivElement> & { value?: number; max?: number }
>(({ className, value = 0, max = 100, ...props }, ref) => {
    const percentage = Math.min(100, Math.max(0, (value / max) * 100));
    return (
        <div
            ref={ref}
            className={cn(
                "relative h-2 w-full overflow-hidden rounded-full bg-[var(--secondary)]",
                className
            )}
            {...props}
        >
            <div
                className="h-full bg-[var(--primary)] transition-all"
                style={{ width: `${percentage}%` }}
            />
        </div>
    );
});
Progress.displayName = "Progress";

export { Progress };
