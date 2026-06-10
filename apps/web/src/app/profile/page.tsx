import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { ProfileClient } from "./profile-client";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
    const session = await auth();
    if (!session?.user) {
        redirect("/login");
    }

    return (
        <div className="flex flex-col h-full">
            <div className="shrink-0 sticky top-0 z-20 bg-background/95 backdrop-blur-sm px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6 pb-3 border-b border-border">
                <h1 className="text-3xl font-bold">Profile</h1>
                <p className="text-muted-foreground">
                    Manage your account and preferences
                </p>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 sm:py-5 md:py-6">
                <ProfileClient user={session.user} />
            </div>
        </div>
    );
}
