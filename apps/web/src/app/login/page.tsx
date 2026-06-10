import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { LoginPageClient } from "./login-client";

export default async function LoginPage() {
    const session = await auth();
    if (session?.user) {
        redirect("/");
    }

    return <LoginPageClient />;
}
