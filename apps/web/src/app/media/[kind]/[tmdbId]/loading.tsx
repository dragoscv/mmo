import "@/components/mmo/browse/browse.css";
import { getTranslations } from "next-intl/server";
import { TitleSkeleton } from "@/components/mmo/browse/title-screen";

export default async function Loading() {
    const t = await getTranslations("mx.browse.title");
    return <TitleSkeleton label={t("loading")} />;
}
