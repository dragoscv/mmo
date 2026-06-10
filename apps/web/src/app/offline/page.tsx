export const dynamic = "force-static";

export default function OfflinePage() {
    return (
        <div className="flex min-h-[calc(100dvh-3rem)] flex-col items-center justify-center p-6 text-center">
            <div className="max-w-sm space-y-4">
                <h1 className="text-2xl font-bold">You&apos;re offline</h1>
                <p className="text-muted-foreground">
                    MMO works locally — the companion handles your library on this machine — but the
                    web shell needs network for sync, billing and remote.
                </p>
                <p className="text-sm text-muted-foreground">
                    This page is served from the service worker cache. Reconnect, then refresh.
                </p>
                {/* Plain <a> on purpose: this is the offline fallback page,
                    served by the service worker. next/link's prefetch + RSC
                    machinery is unavailable when the network is down. */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                    href="/"
                    className="inline-block rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                    Try again
                </a>
            </div>
        </div>
    );
}
