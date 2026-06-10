import { auth } from "@/auth";
import { getCompanionLink } from "@/lib/companion-library";
import { notSignedInFor, noCompanionFor } from "@/components/empty-state-server";
import { getPluginInventory } from "@/actions/plugins";
import { PluginsClient } from "./plugins-client";

export const dynamic = "force-dynamic";

/**
 * Plugins workspace.
 *
 * Discovery + management surface for the companion's audio plugin
 * host (VST3 / AU / LV2 via pedalboard). Lets the user:
 *   • Trigger / re-trigger a filesystem scan for installed plugins
 *   • Browse the discovered inventory (search, filter by format,
 *     instrument vs effect)
 *   • Inspect each plugin's parameter list
 *
 * The actual plugin chain editor lives inside the DAW track inspector,
 * Sound Editor offline-FX tab, and Live page master-FX widget. This
 * page is the catalog.
 */
export default async function PluginsPage() {
    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("plugins");
    const link = await getCompanionLink();
    if (!link) return noCompanionFor("plugins");

    const initial = await getPluginInventory();
    return <PluginsClient initialCached={initial.cached} />;
}
