import { Suspense } from "react";
import { DownloadClient } from "./download-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DownloadPage() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/download");
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center h-full">
                <div className="animate-spin h-8 w-8 border-2 border-purple-500 border-t-transparent rounded-full" />
            </div>
        }>
            <DownloadClient />
        </Suspense>
    );
}
