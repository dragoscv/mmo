import { VisualizationsClient } from "./visualizations-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const metadata = {
    title: "Visualizations | MuzicAI",
};

export default async function VisualizationsPage() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/visualizations");
    return <VisualizationsClient />;
}
