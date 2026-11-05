/**
 * Title screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Title({ ctx, params }: ScreenProps<"title">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Title({ params }: ScreenProps<"title">) {
    return <StubScreen title={params.seed?.title ?? t("screen.title")} icon="movie" testId="screen-title" />;
}
