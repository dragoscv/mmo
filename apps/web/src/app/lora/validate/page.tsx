import { LoraValidateClient } from "./lora-validate-client";

export const metadata = {
    title: "Validate LoRA Corpus — MuzicAI",
};

export default function LoraValidatePage() {
    return (
        <main className="container mx-auto max-w-3xl p-6">
            <header className="mb-6">
                <h1 className="text-2xl font-semibold">LoRA training corpus validator</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    Check whether your audio clips are ready to fine-tune an ACE-Step LoRA. Drop a folder of
                    {" "}<code>.wav</code> / <code>.flac</code> / <code>.mp3</code> files (plus optional{" "}
                    <code>.txt</code> lyric sidecars with the same basename) and we&apos;ll run the same
                    checks the local training script enforces: sample-rate ≥ 16 kHz, 1–2 channels, 10–300 s
                    per clip, and a non-empty lyrics file for vocal training.
                </p>
            </header>
            <LoraValidateClient />
        </main>
    );
}
