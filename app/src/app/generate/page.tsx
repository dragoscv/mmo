import { listGeneratedAssets } from "@/actions/generate";
import { GenerateClient } from "./generate-client";

export const dynamic = "force-dynamic";

export default async function GeneratePage() {
    const assets = await listGeneratedAssets();
    return <GenerateClient initialAssets={assets} />;
}
