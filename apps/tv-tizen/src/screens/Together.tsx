/**
 * Together screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Together({ ctx, params }: ScreenProps<"together">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Together(_props: ScreenProps<"together">) {
    return <StubScreen title={t("screen.together")} icon="group" testId="screen-together" />;
}
