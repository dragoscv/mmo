import { auth } from "@/auth";
import { redirect } from "next/navigation";
import RemotePage from "./remote-page";

// No `force-dynamic`: `auth()` reads the session cookie, which is already
// enough to make this route dynamic. Everything else is client-side.

export default async function RemoteRoute() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/remote");
    return <RemotePage />;
}
