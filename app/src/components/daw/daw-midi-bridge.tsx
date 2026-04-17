"use client";

import { useEffect, useCallback, useState, useRef } from "react";
import { useMidi, useMidiMessages, useExternalDevices } from "@/hooks/use-midi";
import { useDAW } from "./daw-context";
import { CircuitTracksPanel, CircuitTracksBadge } from "../circuit-tracks-panel";
import type { MidiMessage, MidiActionHandler } from "@/lib/midi-engine";

// ─── DAW MIDI Action Categories ──────────────────────────────────────────
// These define what MIDI controller actions mean in the DAW context.
// Reuses the same MidiAction types from the engine but routes them to DAW actions.

/**
 * DAWMidiBridge connects the shared MIDI engine to the DAW.
 * - Routes MIDI controller actions (play/stop/record) to DAW transport
 * - Forwards incoming MIDI notes to the active synth/drum track
 * - Shows external device panels (Circuit Tracks) in the DAW context
 */
export function DAWMidiBridge() {
    const daw = useDAW();
    const midi = useMidi();
    const { externalDevices, engine } = useExternalDevices();

    // External device panel state
    const [panelVisible, setPanelVisible] = useState(false);
    const [panelMinimized, setPanelMinimized] = useState(false);
    const [panelPosition, setPanelPosition] = useState(() => {
        try {
            const raw = localStorage.getItem("daw-external-device-position");
            return raw ? JSON.parse(raw) : { x: 20, y: 400 };
        } catch { return { x: 20, y: 400 }; }
    });
    const [panelSize, setPanelSize] = useState(() => {
        try {
            const raw = localStorage.getItem("daw-external-device-size");
            return raw ? JSON.parse(raw) : { w: 340, h: 480 };
        } catch { return { w: 340, h: 480 }; }
    });

    // Persist panel position/size
    useEffect(() => {
        try { localStorage.setItem("daw-external-device-position", JSON.stringify(panelPosition)); } catch { /* */ }
    }, [panelPosition]);
    useEffect(() => {
        try { localStorage.setItem("daw-external-device-size", JSON.stringify(panelSize)); } catch { /* */ }
    }, [panelSize]);

    // Auto-show panel when external device connects
    useEffect(() => {
        if (externalDevices.length > 0) {
            setPanelVisible(true);
        } else {
            setPanelVisible(false);
        }
    }, [externalDevices]);

    // ── Route MIDI controller actions to DAW transport ──────────────────
    const dawRef = useRef(daw);
    dawRef.current = daw;

    const handleMidiAction: MidiActionHandler = useCallback((action, value, deck) => {
        const d = dawRef.current;
        switch (action) {
            case "play":
                d.togglePlay();
                break;
            case "cue":
                d.stop();
                break;
            case "pause":
                if (d.isPlaying) d.togglePlay();
                break;
            case "tempo-slider":
                // Map 0-1 MIDI value to BPM range (60-200)
                if (typeof value === "number") {
                    const bpm = Math.round(60 + value * 140);
                    d.setTempo(Math.max(20, Math.min(999, bpm)));
                }
                break;
            case "master-volume":
                if (typeof value === "number") {
                    d.setMasterVolume(value);
                }
                break;
        }
    }, []);

    // Set the action handler on the engine
    useEffect(() => {
        midi.setActionHandler(handleMidiAction);
    }, [midi, handleMidiAction]);

    // ── Forward MIDI notes to DAW synth/drum ────────────────────────────
    // When a MIDI note comes in from any controller, route it to the DAW's
    // active instrument via custom events that synth/drum panels listen to.
    // Also route to engine for MIDI recording when active.
    useMidiMessages((msg: MidiMessage) => {
        // Forward to Circuit Tracks panel via custom event
        window.dispatchEvent(new CustomEvent("circuit-tracks-midi", { detail: msg }));

        // Forward note messages to DAW instruments via custom event
        if (msg.type === "noteOn" || msg.type === "noteOff") {
            window.dispatchEvent(new CustomEvent("daw-midi-note", { detail: msg }));

            // Route to MIDI recording if recording is active
            if (dawRef.current.isRecording) {
                const engine = dawRef.current.getEngine();
                if (engine) {
                    if (msg.type === "noteOn" && msg.value > 0) {
                        engine.recordMidiNoteOn(msg.note, msg.value);
                    } else {
                        engine.recordMidiNoteOff(msg.note);
                    }
                }
            }
        }

        // Route CC messages for DAW mixer control
        if (msg.type === "cc") {
            window.dispatchEvent(new CustomEvent("daw-midi-cc", { detail: msg }));
        }

        // Route transport from System Real-Time
        if (msg.type === "start") dawRef.current.play();
        if (msg.type === "stop") dawRef.current.stop();
    });

    return (
        <>
            {/* External Device Floating Panels */}
            {panelVisible && !panelMinimized && engine && externalDevices.map(({ profile, device }) => (
                <CircuitTracksPanel
                    key={device.id}
                    profile={profile}
                    device={device}
                    midiEngine={engine}
                    isMinimized={false}
                    onMinimize={() => setPanelMinimized(true)}
                    onClose={() => setPanelVisible(false)}
                    position={panelPosition}
                    onPositionChange={setPanelPosition}
                    size={panelSize}
                    onSizeChange={setPanelSize}
                />
            ))}

            {/* Minimized badge */}
            {panelVisible && panelMinimized && externalDevices.map(({ profile, device }) => (
                <div key={device.id} className="fixed bottom-2 left-2 z-50">
                    <CircuitTracksBadge
                        profile={profile}
                        isPlaying={daw.isPlaying}
                        bpm={daw.project.tempo}
                        syncMode="receive"
                        onRestore={() => setPanelMinimized(false)}
                    />
                </div>
            ))}
        </>
    );
}
