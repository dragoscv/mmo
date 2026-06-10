import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
    listConnections,
    listModelChoices,
} from "@/actions/copilot";
import { CopilotSettingsClient } from "./copilot-client";

export const metadata: Metadata = {
    title: "AI Copilot",
};

export default async function CopilotSettingsPage() {
    const session = await auth();
    if (!session?.user?.id) redirect("/auth/signin?callbackUrl=/settings/copilot");

    const [connections, choices] = await Promise.all([
        listConnections(),
        listModelChoices(),
    ]);

    return (
        <div className="space-y-6">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight">AI Copilot</h1>
                <p className="text-sm text-muted-foreground">
                    Connect AI providers, list available models, and pick which
                    model powers each role. Meet <span className="font-medium text-foreground">Maestro</span>,
                    your in-app agent.
                </p>
            </header>
            <Suspense fallback={null}>
                <CopilotSettingsClient
                    initialConnections={connections}
                    initialChoices={choices}
                />
            </Suspense>
        </div>
    );
}
