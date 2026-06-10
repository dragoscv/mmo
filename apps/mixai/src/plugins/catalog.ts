/**
 * Built-in catalog of ready-made declarative macro plugins.
 *
 * These ship with MIXAI as one-click installs — useful starting points that
 * also teach the {@link ExternalPluginSpec} format by example. They install
 * through the exact same validated path as pasted JSON or the builder, so they
 * carry no special privileges: pure data, curated engine only.
 */

import type { ExternalPluginSpec } from "./external";

export const PLUGIN_CATALOG: ExternalPluginSpec[] = [
    {
        id: "mixai.quick-drop",
        name: "Quick Drop",
        description: "One-tap drop: sync B to A, slam the crossfader over and play.",
        version: "1.0.0",
        author: "MIXAI",
        category: "utility",
        icon: "🎯",
        buttons: [
            {
                label: "Drop into B",
                steps: [
                    { kind: "sync", deck: "b" },
                    { kind: "play", deck: "b" },
                    { kind: "setCrossfader", value: 1 },
                    { kind: "notify", message: "Dropped into Deck B" },
                ],
                hotkey: "shift+b",
            },
            {
                label: "Drop into A",
                steps: [
                    { kind: "sync", deck: "a" },
                    { kind: "play", deck: "a" },
                    { kind: "setCrossfader", value: -1 },
                    { kind: "notify", message: "Dropped into Deck A" },
                ],
                hotkey: "shift+a",
            },
        ],
    },
    {
        id: "mixai.eq-slam",
        name: "EQ Slam",
        description: "Kill and restore bass/highs per deck for fast cuts.",
        version: "1.0.0",
        author: "MIXAI",
        category: "effect",
        icon: "🔪",
        buttons: [
            {
                label: "Kill bass A",
                steps: [{ kind: "setEq", deck: "a", band: "low", db: -26 }],
            },
            {
                label: "Restore bass A",
                steps: [{ kind: "setEq", deck: "a", band: "low", db: 0 }],
            },
            {
                label: "Kill bass B",
                steps: [{ kind: "setEq", deck: "b", band: "low", db: -26 }],
            },
            {
                label: "Restore bass B",
                steps: [{ kind: "setEq", deck: "b", band: "low", db: 0 }],
            },
        ],
    },
    {
        id: "mixai.filter-fade",
        name: "Filter Fade",
        description: "Open/close the filter for build-ups and breakdowns.",
        version: "1.0.0",
        author: "MIXAI",
        category: "effect",
        icon: "🌫️",
        buttons: [
            {
                label: "Sweep up A",
                steps: [
                    { kind: "setFilter", deck: "a", value: 0.4 },
                    { kind: "wait", ms: 200 },
                    { kind: "setFilter", deck: "a", value: 0.8 },
                ],
            },
            {
                label: "Reset filter A",
                steps: [{ kind: "setFilter", deck: "a", value: 0 }],
            },
            {
                label: "Sweep up B",
                steps: [
                    { kind: "setFilter", deck: "b", value: 0.4 },
                    { kind: "wait", ms: 200 },
                    { kind: "setFilter", deck: "b", value: 0.8 },
                ],
            },
            {
                label: "Reset filter B",
                steps: [{ kind: "setFilter", deck: "b", value: 0 }],
            },
        ],
    },
    {
        id: "mixai.echo-out",
        name: "Echo Out",
        description: "Throw a 1-bar echo tail then cut the deck — classic outro.",
        version: "1.0.0",
        author: "MIXAI",
        category: "effect",
        icon: "🌀",
        buttons: [
            {
                label: "Echo out A",
                steps: [
                    { kind: "setFxKind", deck: "a", fx: 1 },
                    { kind: "setFxBeats", deck: "a", beats: 1 },
                    { kind: "setFxWet", deck: "a", wet: 0.85 },
                    { kind: "wait", ms: 1200 },
                    { kind: "pause", deck: "a" },
                    { kind: "setFxWet", deck: "a", wet: 0 },
                    { kind: "notify", message: "Echoed out Deck A" },
                ],
            },
            {
                label: "Echo out B",
                steps: [
                    { kind: "setFxKind", deck: "b", fx: 1 },
                    { kind: "setFxBeats", deck: "b", beats: 1 },
                    { kind: "setFxWet", deck: "b", wet: 0.85 },
                    { kind: "wait", ms: 1200 },
                    { kind: "pause", deck: "b" },
                    { kind: "setFxWet", deck: "b", wet: 0 },
                    { kind: "notify", message: "Echoed out Deck B" },
                ],
            },
        ],
    },
    {
        id: "mixai.center-reset",
        name: "Center Reset",
        description: "Snap the crossfader to center and restore both EQs and filters.",
        version: "1.0.0",
        author: "MIXAI",
        category: "utility",
        icon: "🎚️",
        buttons: [
            {
                label: "Reset mixer",
                steps: [
                    { kind: "setCrossfader", value: 0 },
                    { kind: "setEq", deck: "a", band: "low", db: 0 },
                    { kind: "setEq", deck: "b", band: "low", db: 0 },
                    { kind: "setFilter", deck: "a", value: 0 },
                    { kind: "setFilter", deck: "b", value: 0 },
                    { kind: "notify", message: "Mixer reset to neutral" },
                ],
            },
        ],
    },
    {
        id: "mixai.end-of-track-alert",
        name: "End-of-Track Alert",
        description:
            "Automation: notify when a deck nears its end so you never get caught out. " +
            "A worked example of state-driven triggers.",
        version: "1.0.0",
        author: "MIXAI",
        category: "assistant",
        icon: "⏰",
        buttons: [
            {
                label: "Test alert",
                steps: [{ kind: "notify", message: "End-of-track alert is armed" }],
            },
        ],
        triggers: [
            {
                label: "Deck A < 20s",
                deck: "a",
                metric: "remaining",
                op: "lt",
                value: 20,
                steps: [{ kind: "notify", message: "⏰ Deck A ending — mix out!" }],
                cooldownMs: 30000,
            },
            {
                label: "Deck B < 20s",
                deck: "b",
                metric: "remaining",
                op: "lt",
                value: 20,
                steps: [{ kind: "notify", message: "⏰ Deck B ending — mix out!" }],
                cooldownMs: 30000,
            },
        ],
    },
];
