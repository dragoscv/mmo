/**
 * Season screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Season({ ctx, params }: ScreenProps<"season">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Season({ params }: ScreenProps<"season">) {
    return <StubScreen title={t("screen.season", { n: params.season })} icon="tv" testId="screen-season" />;
}
