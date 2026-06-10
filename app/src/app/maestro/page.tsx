import type { Metadata } from "next";
import MaestroPageClient from "./maestro-client";

export const metadata: Metadata = {
    title: "Maestro · MMO",
    description: "Conversational control plane for your music workflow.",
};

export default function MaestroPage() {
    return <MaestroPageClient />;
}
