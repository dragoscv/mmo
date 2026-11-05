/**
 * Recordings screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Recordings({ ctx, params }: ScreenProps<"recordings">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Recordings(_props: ScreenProps<"recordings">) {
    return <StubScreen title={t("screen.recordings")} icon="record" testId="screen-recordings" />;
}
