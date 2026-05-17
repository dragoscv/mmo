import { auth } from "@/auth";
import { redirect } from "next/navigation";
import RemotePage from "./remote-page";

export const dynamic = "force-dynamic";

export default async function RemoteRoute() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/remote");
    return <RemotePage />;
}
