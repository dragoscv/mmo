/**
 * Guide screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Guide({ ctx, params }: ScreenProps<"guide">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Guide(_props: ScreenProps<"guide">) {
    return <StubScreen title={t("screen.guide")} icon="guide" testId="screen-guide" />;
}
