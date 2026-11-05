/**
 * LiveTv screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function LiveTv({ ctx, params }: ScreenProps<"livetv">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function LiveTv(_props: ScreenProps<"livetv">) {
    return <StubScreen title={t("screen.livetv")} icon="livetv" testId="screen-livetv" />;
}
