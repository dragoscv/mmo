import { listRecordings } from "@/actions/recordings";
import { getRecordingsFolder } from "@/actions/recordings";
import { RecordingsClient } from "./recordings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RecordingsPage() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/recordings");
    const [recordings, folder] = await Promise.all([
        listRecordings(),
        getRecordingsFolder().catch(() => ""),
    ]);

    return <RecordingsClient initialRecordings={recordings} folder={folder} />;
}
