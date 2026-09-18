// Placeholder body for `/` until WP11-03 ships the real HeroBillboard +
// MediaRow components. Mirrors the shape of `MediaHomeSkeleton` so the
// swap is layout-neutral. Pure server component.
import { Skeleton } from "@mmo/ui";

export function MediaHomePlaceholder({ rows = 3 }: { rows?: number }) {
    return (
        <div data-slot="media-home-placeholder" aria-busy>
            <Skeleton className="mb-8 h-[38vh] w-full rounded-2xl" />
            {Array.from({ length: rows }, (_, i) => (
                <section key={i} className="mb-8">
                    <Skeleton className="mb-3 h-5 w-40" />
                    <div className="flex gap-3 overflow-hidden">
                        {Array.from({ length: 8 }, (_, j) => (
                            <Skeleton key={j} className="aspect-[2/3] w-36 shrink-0 rounded-xl" />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
