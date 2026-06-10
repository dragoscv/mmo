import { Suspense } from "react";
import {
    findExactDuplicates,
    findFuzzyDuplicates,
    findAudioDuplicates,
} from "@/actions/duplicates";
import { DuplicatesClient } from "./duplicates-client";

export const metadata = {
    title: "Duplicates · MMO",
};

export const dynamic = "force-dynamic";

export default async function DuplicatesPage() {
    const [exact, fuzzy, audio] = await Promise.all([
        findExactDuplicates(),
        findFuzzyDuplicates(),
        findAudioDuplicates(),
    ]);
    return (
        <Suspense fallback={null}>
            <DuplicatesClient exact={exact} fuzzy={fuzzy} audio={audio} />
        </Suspense>
    );
}
