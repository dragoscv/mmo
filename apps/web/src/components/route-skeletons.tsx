// Route-level loading skeletons (used by every `loading.tsx` under app/).
// Each shape matches the final layout of its route family so streaming never
// shifts content (no CLS). Pure server components — no client JS.
import { Skeleton, SkeletonCard, SkeletonGrid, SkeletonTable, SkeletonText } from "@mmo/ui";

function Header({ actions = 1 }: { actions?: number }) {
    return (
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-col gap-2">
                <Skeleton className="h-7 w-48" />
                <Skeleton className="h-4 w-72 max-w-full" />
            </div>
            <div className="flex gap-2">
                {Array.from({ length: actions }, (_, i) => (
                    <Skeleton key={i} className="h-control w-28" />
                ))}
            </div>
        </div>
    );
}

/** Dashboard: stat tiles + two content columns. */
export function DashboardSkeleton() {
    return (
        <div className="content-lg px-4 py-6 sm:px-6 lg:px-8" aria-busy>
            <Header actions={0} />
            <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
                {Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="surface rounded-xl p-4">
                        <Skeleton className="mb-3 h-3 w-20" />
                        <Skeleton className="h-8 w-16" />
                    </div>
                ))}
            </div>
            <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
                <SkeletonCard />
                <SkeletonCard />
            </div>
        </div>
    );
}

/** Library / playlists / recordings / hidden: toolbar + table. */
export function TableSkeleton({ cols = 6 }: { cols?: number }) {
    return (
        <div className="content-xl px-4 py-6 sm:px-6 lg:px-8" aria-busy>
            <Header actions={2} />
            <div className="mb-4 flex flex-wrap gap-2">
                <Skeleton className="h-control w-64 max-w-full" />
                <Skeleton className="h-control w-32" />
                <Skeleton className="h-control w-32" />
            </div>
            <div className="surface rounded-xl">
                <SkeletonTable rows={10} cols={cols} />
            </div>
        </div>
    );
}

/** Watch home / movies / shows / collections: poster grids. */
export function MediaGridSkeleton({ rows = 2 }: { rows?: number }) {
    return (
        <div className="px-4 py-6 sm:px-6 lg:px-8" aria-busy>
            <Skeleton className="mb-6 h-[38vh] w-full rounded-2xl" />
            {Array.from({ length: rows }, (_, i) => (
                <section key={i} className="mb-8">
                    <Skeleton className="mb-3 h-5 w-40" />
                    <SkeletonGrid count={8} aspect="aspect-[2/3]" className="grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]" />
                </section>
            ))}
        </div>
    );
}

/** Movie / show / discover detail: hero + facts + episodes. */
export function MediaDetailSkeleton() {
    return (
        <div aria-busy>
            <Skeleton className="h-[52vh] w-full rounded-none" />
            <div className="content-lg -mt-24 px-4 sm:px-6 lg:px-8">
                <div className="flex gap-6">
                    <Skeleton className="hidden aspect-[2/3] w-44 shrink-0 rounded-xl sm:block" />
                    <div className="flex flex-1 flex-col gap-3 pt-2">
                        <Skeleton className="h-9 w-2/3" />
                        <Skeleton className="h-4 w-1/3" />
                        <SkeletonText lines={4} className="mt-2" />
                        <div className="mt-2 flex gap-2">
                            <Skeleton className="h-control-lg w-36" />
                            <Skeleton className="h-control-lg w-12" />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Settings pages: title + stacked cards. */
export function SettingsSkeleton({ cards = 3 }: { cards?: number }) {
    return (
        <div className="space-y-6" aria-busy>
            <div className="flex flex-col gap-2">
                <Skeleton className="h-7 w-56" />
                <Skeleton className="h-4 w-80 max-w-full" />
            </div>
            {Array.from({ length: cards }, (_, i) => (
                <SkeletonCard key={i} />
            ))}
        </div>
    );
}

/** Tool pages (mixer/daw/editor/live/analysis/generate…): toolbar + big canvas. */
export function WorkspaceSkeleton() {
    return (
        <div className="flex h-full flex-col gap-3 p-3" aria-busy>
            <div className="flex items-center gap-2">
                <Skeleton className="h-control w-40" />
                <Skeleton className="h-control w-control" />
                <Skeleton className="h-control w-control" />
                <div className="flex-1" />
                <Skeleton className="h-control w-28" />
            </div>
            <Skeleton className="min-h-0 flex-1 rounded-xl" />
            <div className="grid grid-cols-4 gap-2">
                {Array.from({ length: 4 }, (_, i) => (
                    <Skeleton key={i} className="h-24 rounded-lg" />
                ))}
            </div>
        </div>
    );
}

/** Generic: header + card list (devices, plugins, training, downloads…). */
export function ListSkeleton({ items = 5 }: { items?: number }) {
    return (
        <div className="content-lg px-4 py-6 sm:px-6 lg:px-8" aria-busy>
            <Header />
            <div className="flex flex-col gap-3">
                {Array.from({ length: items }, (_, i) => (
                    <div key={i} className="surface flex items-center gap-4 rounded-xl p-4">
                        <Skeleton className="size-12 shrink-0 rounded-lg" />
                        <div className="flex flex-1 flex-col gap-2">
                            <Skeleton className="h-4 w-1/3" />
                            <Skeleton className="h-3 w-1/2" />
                        </div>
                        <Skeleton className="h-control-sm w-20" />
                    </div>
                ))}
            </div>
        </div>
    );
}

/** Reading pages (learn, profile, status): prose column. */
export function ProseSkeleton() {
    return (
        <div className="content-md px-4 py-8 sm:px-6" aria-busy>
            <Skeleton className="mb-3 h-4 w-24" />
            <Skeleton className="mb-6 h-9 w-3/4" />
            <SkeletonText lines={6} />
            <Skeleton className="my-6 h-48 w-full rounded-xl" />
            <SkeletonText lines={5} />
        </div>
    );
}

/** Player page: video area + controls. */
export function PlayerSkeleton() {
    return (
        <div className="flex h-full flex-col bg-black" aria-busy>
            <Skeleton className="min-h-0 flex-1 rounded-none bg-neutral-900" />
            <div className="flex items-center gap-3 p-4">
                <Skeleton className="size-10 rounded-full" />
                <Skeleton className="h-2 flex-1" />
                <Skeleton className="h-4 w-16" />
            </div>
        </div>
    );
}
