import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
    title: { template: "%s · Settings · MMO", default: "Settings · MMO" },
};

export default function SettingsLayout({ children }: { children: ReactNode }) {
    // No secondary sidebar — settings navigation now lives in the main
    // app sidebar's drilled "Settings" view.
    return (
        <div className="h-full min-h-screen overflow-y-auto">
            <div
                className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-8"
                style={{ paddingBottom: "7rem" }}
            >
                {children}
            </div>
        </div>
    );
}
