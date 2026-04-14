"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { scanFolderAction } from "@/actions/scan";
import {
    ScanSearch,
    FolderOpen,
    CheckCircle,
    AlertCircle,
    Loader2,
} from "lucide-react";
import { toast } from "sonner";

interface ScanResult {
    totalFiles: number;
    audioFiles: number;
    inserted: number;
    skipped: number;
    errors: string[];
}

interface ScannerClientProps {
    watchFolders: string[];
    musicRoot: string;
}

export function ScannerClient({
    watchFolders,
    musicRoot,
}: ScannerClientProps) {
    const [customPath, setCustomPath] = useState("");
    const [scanResult, setScanResult] = useState<ScanResult | null>(null);
    const [isPending, startTransition] = useTransition();

    function handleScan(folderPath: string) {
        setScanResult(null);
        startTransition(async () => {
            try {
                const result = await scanFolderAction(folderPath);
                setScanResult(result);
                if (result.inserted > 0) {
                    toast.success(
                        `${result.inserted} track-uri noi adăugate!`,
                        {
                            description: `${result.skipped} deja existente, ${result.errors.length} erori`,
                        }
                    );
                } else if (result.skipped > 0) {
                    toast.info("Niciun track nou — toate sunt deja în bibliotecă.");
                } else {
                    toast.warning("Niciun fișier audio găsit în folder.");
                }
            } catch {
                toast.error("Eroare la scanare");
            }
        });
    }

    return (
        <div className="space-y-6">
            {/* Quick Scan Buttons */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <FolderOpen className="h-5 w-5" />
                        Watch Folders
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    {watchFolders.length > 0 ? (
                        watchFolders.map((folder: string) => (
                            <div
                                key={folder}
                                className="flex items-center justify-between rounded-lg border border-[var(--border)] px-4 py-3"
                            >
                                <span className="text-sm font-mono">{folder}</span>
                                <Button
                                    size="sm"
                                    onClick={() => handleScan(folder)}
                                    disabled={isPending}
                                >
                                    {isPending ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <ScanSearch className="mr-2 h-4 w-4" />
                                    )}
                                    Scan
                                </Button>
                            </div>
                        ))
                    ) : (
                        <p className="text-sm text-[var(--muted-foreground)]">
                            Niciun watch folder configurat. Adaugă din Settings.
                        </p>
                    )}

                    {/* Scan music root */}
                    <div className="flex items-center justify-between rounded-lg border border-dashed border-[var(--border)] px-4 py-3">
                        <span className="text-sm font-mono">
                            {musicRoot} (root complet)
                        </span>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleScan(musicRoot)}
                            disabled={isPending}
                        >
                            {isPending ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <ScanSearch className="mr-2 h-4 w-4" />
                            )}
                            Scan All
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* Custom Path Scan */}
            <Card>
                <CardHeader>
                    <CardTitle>Custom Folder</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex gap-3">
                        <Input
                            placeholder="C:\Users\vladu\Downloads\music"
                            value={customPath}
                            onChange={(e) => setCustomPath(e.target.value)}
                            className="flex-1"
                        />
                        <Button
                            onClick={() => {
                                if (customPath.trim()) handleScan(customPath.trim());
                            }}
                            disabled={isPending || !customPath.trim()}
                        >
                            {isPending ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <ScanSearch className="mr-2 h-4 w-4" />
                            )}
                            Scan
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* Scan Results */}
            {scanResult && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <CheckCircle className="h-5 w-5 text-green-500" />
                            Scan Results
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                            <div className="rounded-lg bg-[var(--secondary)] p-3 text-center">
                                <p className="text-2xl font-bold">{scanResult.audioFiles}</p>
                                <p className="text-xs text-[var(--muted-foreground)]">
                                    Audio Files Found
                                </p>
                            </div>
                            <div className="rounded-lg bg-green-500/10 p-3 text-center">
                                <p className="text-2xl font-bold text-green-500">
                                    {scanResult.inserted}
                                </p>
                                <p className="text-xs text-[var(--muted-foreground)]">
                                    New Added
                                </p>
                            </div>
                            <div className="rounded-lg bg-blue-500/10 p-3 text-center">
                                <p className="text-2xl font-bold text-blue-500">
                                    {scanResult.skipped}
                                </p>
                                <p className="text-xs text-[var(--muted-foreground)]">
                                    Already in DB
                                </p>
                            </div>
                            <div className="rounded-lg bg-red-500/10 p-3 text-center">
                                <p className="text-2xl font-bold text-red-500">
                                    {scanResult.errors.length}
                                </p>
                                <p className="text-xs text-[var(--muted-foreground)]">Errors</p>
                            </div>
                        </div>

                        {scanResult.errors.length > 0 && (
                            <div className="mt-4 space-y-1">
                                <p className="flex items-center gap-1 text-sm font-medium text-red-500">
                                    <AlertCircle className="h-4 w-4" />
                                    Errors:
                                </p>
                                {scanResult.errors.slice(0, 10).map((err, i) => (
                                    <p
                                        key={i}
                                        className="truncate text-xs text-[var(--muted-foreground)]"
                                    >
                                        {err}
                                    </p>
                                ))}
                                {scanResult.errors.length > 10 && (
                                    <p className="text-xs text-[var(--muted-foreground)]">
                                        ... and {scanResult.errors.length - 10} more
                                    </p>
                                )}
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
