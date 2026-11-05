/**
 * Settings screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Settings({ ctx, params }: ScreenProps<"settings">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Settings(_props: ScreenProps<"settings">) {
    return <StubScreen title={t("screen.settings")} icon="settings" testId="screen-settings" />;
}
