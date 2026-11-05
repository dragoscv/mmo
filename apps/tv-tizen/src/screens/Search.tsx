/**
 * Search screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Search({ ctx, params }: ScreenProps<"search">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Search({ params }: ScreenProps<"search">) {
    return <StubScreen title={params.initial ? `${t("screen.search")}: ${params.initial}` : t("screen.search")} icon="search" testId="screen-search" />;
}
