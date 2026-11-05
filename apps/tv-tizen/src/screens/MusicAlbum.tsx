/**
 * MusicAlbum screen — STUB (WP16-30 foundation). A screen agent replaces the body; keep the signature:
 *   export function MusicAlbum({ ctx, params }: ScreenProps<"album">)
 */
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { StubScreen } from "../ui";

export function MusicAlbum({ params }: ScreenProps<"album">) {
    return <StubScreen title={params.seed?.name ?? t("screen.album")} icon="music" testId="screen-album" />;
}
