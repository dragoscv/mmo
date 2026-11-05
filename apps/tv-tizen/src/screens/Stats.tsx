/**
 * Stats screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Stats({ ctx, params }: ScreenProps<"stats">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Stats(_props: ScreenProps<"stats">) {
    return <StubScreen title={t("screen.stats")} icon="star" testId="screen-stats" />;
}
