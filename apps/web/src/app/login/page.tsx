import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { LoginPageClient } from "./login-client";

type SearchParams = Record<string, string | string[] | undefined>;

/** Only same-origin paths ("/x", never "//host" or absolute URLs). */
function safeCallbackUrl(raw: string | string[] | undefined): string {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (!v || !v.startsWith("/") || v.startsWith("//")) return "/";
    return v;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
    const sp = await searchParams;
    const callbackUrl = safeCallbackUrl(sp.callbackUrl ?? sp.from);
    const session = await auth();
    if (session?.user) {
        redirect(callbackUrl);
    }

    return <LoginPageClient callbackUrl={callbackUrl} />;
}
