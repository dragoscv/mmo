import { getDashboardStats } from "@/actions/tracks";
import { getRecentScans, getLibraryGrowth } from "@/actions/scan";
import { getRecommendedPlaylists } from "@/actions/playlists";
import { DashboardClient } from "@/components/dashboard-client";

export const revalidate = 300; // 5 minutes

import { auth } from "@/auth";
import { getAllCompanionLinks } from "@/lib/companion-library";
import { notSignedInFor, noCompanionFor } from "@/components/empty-state-server";
export default async function DashboardPage() {
    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("dashboard");
    // Multi-companion: any paired device unlocks the dashboard (stats are
    // aggregated from cloud across all companions, not a single auto-picked one).
    const links = await getAllCompanionLinks();
    if (links.length === 0) return noCompanionFor("dashboard");

    const [stats, recommendedCategories, recentScans, growth] = await Promise.all([
        getDashboardStats(),
        getRecommendedPlaylists(),
        getRecentScans(10),
        getLibraryGrowth(30),
    ]);

    return (
        <DashboardClient
            stats={stats}
            recommendedCategories={recommendedCategories}
            recentScans={recentScans}
            growth={growth}
        />
    );
}
