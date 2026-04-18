import { listRecordings } from "@/actions/recordings";
import { getRecordingsFolder } from "@/actions/recordings";
import { RecordingsClient } from "./recordings-client";

export const dynamic = "force-dynamic";

export default async function RecordingsPage() {
    const [recordings, folder] = await Promise.all([
        listRecordings(),
        getRecordingsFolder().catch(() => ""),
    ]);

    return <RecordingsClient initialRecordings={recordings} folder={folder} />;
}
