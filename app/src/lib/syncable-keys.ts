export const SYNCABLE_KEYS = [
    "mmo-personalization",
    "mmo-daw-display-settings",
    "mmo-fx-presets",
    "mmo-midi-settings",
    "mmo-restore-now-playing",
    "theme",
] as const;

export type SyncableKey = (typeof SYNCABLE_KEYS)[number];
