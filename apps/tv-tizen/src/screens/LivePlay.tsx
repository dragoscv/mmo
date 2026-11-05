/**
 * LivePlay screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function LivePlay({ ctx, params }: ScreenProps<"livePlay">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function LivePlay(_props: ScreenProps<"livePlay">) {
    return <StubScreen title={t("screen.livePlay")} icon="livetv" testId="screen-livePlay" />;
}
