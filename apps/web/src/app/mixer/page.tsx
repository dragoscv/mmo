import { auth } from "@/auth";
import { redirect } from "next/navigation";
import MixerClient from "./mixer-client";

// No `force-dynamic`: `auth()` reads the session cookie, which is already
// enough to make this route dynamic. Everything else is client-side.

export default async function MixerPage() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/mixer");
    return <MixerClient />;
}
