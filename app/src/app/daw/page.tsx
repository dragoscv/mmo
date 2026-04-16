import { DAWProvider } from "@/components/daw/daw-context";
import { DAWPage } from "@/components/daw/daw-page";

export const dynamic = "force-dynamic";

export default function DAWRoute() {
    return (
        <DAWProvider>
            <DAWPage />
        </DAWProvider>
    );
}
