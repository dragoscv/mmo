import { listTrainingJobs } from "@/actions/training";
import { listDatasets } from "@/actions/training-datasets";
import { listLoras } from "@/actions/loras";
import { summarizeFeedback } from "@/actions/generation-feedback";
import { TrainingClient } from "./training-client";

export const dynamic = "force-dynamic";

/**
 * /training — Maestro training control plane.
 *
 * Top tabs:
 *  • Jobs     — list of training_jobs with live SSE for the running one.
 *  • Datasets — curated bundles you can train on. Build flow on this page.
 *  • LoRAs    — finished adapters, with thumbs-up rate + preview audio.
 *  • Feedback — aggregate of the user's thumbs/notes so they know what
 *               Maestro will optimize for next time.
 *
 * The page is a server component that does the initial fetch; the client
 * component handles SSE, tab switching, and form submissions through
 * server actions.
 */
export default async function TrainingPage() {
    const [jobs, datasets, loras, feedback] = await Promise.all([
        listTrainingJobs({ limit: 50 }),
        listDatasets(),
        listLoras({ status: "active" }),
        summarizeFeedback({ sinceDays: 30 }),
    ]);
    return (
        <TrainingClient
            initialJobs={jobs}
            initialDatasets={datasets}
            initialLoras={loras}
            initialFeedback={feedback}
        />
    );
}
