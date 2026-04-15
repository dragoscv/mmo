import { getHiddenTracks } from "@/actions/tracks";
import { HiddenClient } from "./hidden-client";

export const dynamic = "force-dynamic";

export default async function HiddenPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    const params = await searchParams;

    const page = parseInt(params.page || "1");
    const pageSize = parseInt(params.pageSize || "50");
    const sort = params.sort || "addedAt";
    const order = (params.order || "desc") as "asc" | "desc";

    const result = await getHiddenTracks({
        page,
        pageSize,
        sort,
        order,
        search: params.search || undefined,
    });

    return (
        <HiddenClient
            tracks={result.tracks}
            total={result.total}
            page={result.page}
            pageSize={result.pageSize}
            totalPages={result.totalPages}
            search={params.search || ""}
        />
    );
}
