"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@mmo/ui";

// Boundary component: the server page (/watch/stats) imports this thin
// wrapper so that `recharts` is code-split and only loads on the client.
// `dynamic({ ssr: false })` is not allowed directly inside a Server Component.
export const WatchDailyChart = dynamic(
    () => import("./stats-chart").then((m) => ({ default: m.WatchDailyChart })),
    {
        ssr: false,
        loading: () => <Skeleton className="h-[260px] w-full" aria-busy="true" />,
    },
);
