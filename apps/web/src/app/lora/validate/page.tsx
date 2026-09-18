import { getTranslations } from "next-intl/server";
import { Page, PageHeader } from "@mmo/ui";
import { LoraValidateClient } from "./lora-validate-client";

export const metadata = {
    title: "Validate LoRA Corpus",
};

export default async function LoraValidatePage() {
    const t = await getTranslations("tables.loraValidate");
    return (
        <Page width="lg">
            <PageHeader title={t("title")} description={t("description")} />
            <LoraValidateClient />
        </Page>
    );
}
