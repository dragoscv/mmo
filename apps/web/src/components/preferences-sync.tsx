"use client";

import { usePreferencesSync } from "@/hooks/use-preferences-sync";

export function PreferencesSync() {
    usePreferencesSync();
    return null;
}
