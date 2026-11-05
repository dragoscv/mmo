/**
 * Music screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Music({ ctx, params }: ScreenProps<"music">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Music(_props: ScreenProps<"music">) {
    return <StubScreen title={t("screen.music")} icon="music" testId="screen-music" />;
}
