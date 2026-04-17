import { getDashboardStats } from "@/actions/tracks";
import { getRecentScans } from "@/actions/scan";
import { getRecommendedPlaylists } from "@/actions/playlists";
import { DashboardClient } from "@/components/dashboard-client";

export const revalidate = 300; // 5 minutes

export default async function DashboardPage() {
    const [stats, recommendedCategories, recentScans] = await Promise.all([
        getDashboardStats(),
        getRecommendedPlaylists(),
        getRecentScans(10),
    ]);

    return (
        <DashboardClient
            stats={stats}
            recommendedCategories={recommendedCategories}
            recentScans={recentScans}
        />
    );
}
