import { Music, Inbox, CheckCircle, Activity } from "lucide-react";
import { getTrackStats } from "@/actions/tracks";
import { getRecentScans } from "@/actions/scan";
import { StatsCard } from "@/components/stats-card";
import { DashboardActions } from "@/components/dashboard-actions";
import { GenreChart } from "@/components/genre-chart";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const stats = await getTrackStats();
  const recentScans = await getRecentScans(10);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-[var(--muted-foreground)]">
          Music Organizer — Overview
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatsCard
          title="Total Tracks"
          value={stats.total}
          icon={<Music className="h-5 w-5" />}
        />
        <StatsCard
          title="Processed"
          value={stats.processed}
          description={`${stats.unprocessed} neprocesat${stats.unprocessed !== 1 ? "e" : ""}`}
          icon={<CheckCircle className="h-5 w-5" />}
        />
        <StatsCard
          title="Inbox"
          value={stats.unprocessed}
          description="Track-uri de procesat"
          icon={<Inbox className="h-5 w-5" />}
        />
        <StatsCard
          title="Avg BPM"
          value={stats.avgBpm || "—"}
          icon={<Activity className="h-5 w-5" />}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Genre Distribution */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-6">
          <h2 className="mb-4 text-lg font-semibold">Genre Distribution</h2>
          {stats.genreStats.length > 0 ? (
            <GenreChart data={stats.genreStats} />
          ) : (
            <p className="text-sm text-[var(--muted-foreground)]">
              Niciun track în bibliotecă. Scanează un folder pentru a începe.
            </p>
          )}
        </div>

        {/* Quick Actions */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-6">
          <h2 className="mb-4 text-lg font-semibold">Quick Actions</h2>
          <DashboardActions />
        </div>
      </div>

      {/* Recent Activity */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-6">
        <h2 className="mb-4 text-lg font-semibold">Recent Activity</h2>
        {recentScans.length > 0 ? (
          <div className="space-y-2">
            {recentScans.map((log) => (
              <div
                key={log.id}
                className="flex items-center justify-between rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      log.action === "added"
                        ? "bg-green-500"
                        : log.action === "moved"
                          ? "bg-blue-500"
                          : "bg-yellow-500"
                    }`}
                  />
                  <span className="text-[var(--muted-foreground)]">
                    {log.details || log.filepath}
                  </span>
                </div>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {log.scannedAt}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--muted-foreground)]">
            Nicio activitate recentă.
          </p>
        )}
      </div>
    </div>
  );
}
