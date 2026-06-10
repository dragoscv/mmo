import { auth } from "@/auth";
import { redirect } from "next/navigation";
import MixerClient from "./mixer-client";

export const dynamic = "force-dynamic";

export default async function MixerPage() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/mixer");
    return <MixerClient />;
}
