/**
 * Artist screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Artist({ ctx, params }: ScreenProps<"artist">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Artist(_props: ScreenProps<"artist">) {
    return <StubScreen title={t("screen.artist")} icon="music" testId="screen-artist" />;
}
