/**
 * NowPlaying screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function NowPlaying({ ctx, params }: ScreenProps<"nowPlaying">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function NowPlaying(_props: ScreenProps<"nowPlaying">) {
    return <StubScreen title={t("screen.nowPlaying")} icon="queue" testId="screen-nowPlaying" />;
}
