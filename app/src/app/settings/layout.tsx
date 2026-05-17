import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";

export const metadata: Metadata = {
    title: { template: "%s · Settings · MMO", default: "Settings · MMO" },
};

export default function SettingsLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-full min-h-screen">
            <SettingsSidebar />
            <div className="flex-1 min-w-0 overflow-y-auto">{children}</div>
        </div>
    );
}
