/**
 * Library screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Library({ ctx, params }: ScreenProps<"library">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Library({ params }: ScreenProps<"library">) {
    return <StubScreen title={params.kind === "movie" ? t("screen.library.movie") : t("screen.library.tv")} icon="movie" testId="screen-library" />;
}
