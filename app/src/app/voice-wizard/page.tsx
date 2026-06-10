import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getVoiceWizardSnapshot } from "@/actions/voice-clone";
import { VoiceWizardClient } from "./voice-wizard-client";

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Voice Wizard — MMO",
    description: "Train a personal voice clone on your own machine, then use it across Maestro, the DAW, and any vocal generation.",
};

export default async function VoiceWizardPage() {
    const session = await auth();
    if (!session?.user?.id) {
        redirect("/api/auth/signin?callbackUrl=/voice-wizard");
    }
    const snapshot = await getVoiceWizardSnapshot();
    return <VoiceWizardClient snapshot={snapshot} />;
}
