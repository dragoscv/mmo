import { redirect } from "next/navigation";

/** Settings › Video merged into Settings › Media (WP11-06). */
export default function VideoSettingsPage() {
    redirect("/settings/media");
}
