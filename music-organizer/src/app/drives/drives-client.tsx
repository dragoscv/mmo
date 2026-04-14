"use client";

import { useState, useEffect, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { detectDrives } from "@/actions/drives";
import { formatBytes } from "@/lib/utils";
import { HardDrive, RefreshCw, Loader2 } from "lucide-react";

interface DriveInfo {
  path: string;
  label: string;
  format: string;
  totalSize: number;
  freeSpace: number;
  usedSpace: number;
}

export function DrivesClient() {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [isPending, startTransition] = useTransition();
  const [loaded, setLoaded] = useState(false);

  function loadDrives() {
    startTransition(async () => {
      const result = await detectDrives();
      setDrives(result);
      setLoaded(true);
    });
  }

  useEffect(() => {
    loadDrives();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--muted-foreground)]">
          {drives.length} drive{drives.length !== 1 ? "-uri" : ""} detectate
        </p>
        <Button variant="outline" size="sm" onClick={loadDrives} disabled={isPending}>
          {isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {!loaded && isPending ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--muted-foreground)]" />
        </div>
      ) : drives.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          Niciun drive detectat.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {drives.map((drive) => {
            const usagePercent =
              drive.totalSize > 0
                ? Math.round((drive.usedSpace / drive.totalSize) * 100)
                : 0;
            const isFat32 =
              drive.format?.toUpperCase() === "FAT32";
            const isNearFull = usagePercent > 90;

            return (
              <Card key={drive.path}>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <HardDrive className="h-5 w-5" />
                      {drive.label}
                    </div>
                    <Badge
                      variant={isFat32 ? "default" : "secondary"}
                      className="text-xs"
                    >
                      {drive.format || "Unknown"}
                    </Badge>
                  </CardTitle>
                  <p className="text-sm text-[var(--muted-foreground)]">
                    {drive.path}
                  </p>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Progress
                    value={usagePercent}
                    className={isNearFull ? "[&>div]:bg-red-500" : ""}
                  />
                  <div className="flex justify-between text-xs text-[var(--muted-foreground)]">
                    <span>{formatBytes(drive.usedSpace)} used</span>
                    <span>{formatBytes(drive.freeSpace)} free</span>
                  </div>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Total: {formatBytes(drive.totalSize)} · {usagePercent}%
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
