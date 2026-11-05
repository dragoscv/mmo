import { OfflinePlayer } from "./offline-player";

/** `/media/downloads/play/<enc key>` — plays one download from `/__offline/<key>` (offline: static shell). */
export default async function OfflinePlayPage({ params }: { params: Promise<{ key: string }> }) {
    const { key } = await params;
    return <OfflinePlayer rawKey={key} />;
}
