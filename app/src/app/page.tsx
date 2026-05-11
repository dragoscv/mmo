import { getDashboardStats } from "@/actions/tracks";
import { getRecentScans, getLibraryGrowth } from "@/actions/scan";
import { getRecommendedPlaylists } from "@/actions/playlists";
import { DashboardClient } from "@/components/dashboard-client";
import { auth } from "@/auth";
import { getCompanionLink } from "@/lib/companion-library";
import { notSignedInFor, noCompanionFor } from "@/components/empty-state-server";

export const revalidate = 300; // 5 minutes

export default async function DashboardPage() {
    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("dashboard");
    const link = await getCompanionLink();
    if (!link) return noCompanionFor("dashboard");

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
