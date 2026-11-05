/**
 * Home screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function Home({ ctx, params }: ScreenProps<"home">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function Home({ ctx }: ScreenProps<"home">) {
    return (
        <StubScreen title={t("screen.home")} icon="home" testId="screen-home"
            action={{ label: t("nav.search"), icon: "search", onClick: () => ctx.nav.resetTo({ name: "search" }) }} />
    );
}
