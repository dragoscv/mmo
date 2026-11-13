import { useState } from "react";
import { Check } from "lucide-react";
import { engine } from "@/bridge/engine";
import { useCompanionStore } from "@/state/companion-store";
import { buildProfileJson, applyProfileJson } from "@/lib/cloud-sync";
import { midiBtn } from "./shared";

export function ProfileSection() {
    const [copied, setCopied] = useState(false);
    const [importText, setImportText] = useState("");
    const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
    const [cloud, setCloud] = useState<"idle" | "saving" | "loading" | "saved" | "loaded" | "empty" | "error">("idle");
    const cloudReady = useCompanionStore((s) => Boolean(s.deviceToken && s.userId));

    // Manual save/load + paste-restore all share the cloud-sync helpers so the
    // serialize/apply logic lives in exactly one place. The paste-restore path
    // (and "Load from cloud") DO restore the companion connection, unlike the
    // background auto-sync.
    const buildJson = buildProfileJson;
    const applyProfile = (raw: string): Promise<boolean> =>
        applyProfileJson(raw, { includeCompanion: true });

    const doExport = async () => {
        const json = await buildJson();
        try {
            await navigator.clipboard.writeText(json);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard may be blocked; non-fatal */
        }
    };

    const doImport = async () => {
        const ok = await applyProfile(importText);
        if (!ok) {
            setStatus("error");
            return;
        }
        setImportText("");
        setStatus("ok");
        setTimeout(() => setStatus("idle"), 1500);
    };

    const doCloudSave = async () => {
        setCloud("saving");
        try {
            const json = await buildJson();
            await engine.companionPutProfile(json);
            setCloud("saved");
            setTimeout(() => setCloud("idle"), 1800);
        } catch {
            setCloud("error");
            setTimeout(() => setCloud("idle"), 2500);
        }
    };

    const doCloudLoad = async () => {
        setCloud("loading");
        try {
            const json = await engine.companionGetProfile();
            if (!json) {
                setCloud("empty");
                setTimeout(() => setCloud("idle"), 2500);
                return;
            }
            const ok = await applyProfile(json);
            setCloud(ok ? "loaded" : "error");
            setTimeout(() => setCloud("idle"), 1800);
        } catch {
            setCloud("error");
            setTimeout(() => setCloud("idle"), 2500);
        }
    };

    return (
        <div style={{ display: "grid", gap: 8 }}>
            <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>
                Back up your themes, deck layout, library connection, MIDI + HID mappings,
                keyboard shortcuts and installed plugins to a single code — then restore
                everything on another machine.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => void doExport()} style={midiBtn(false)}>
                    {copied ? <><Check size={11} aria-hidden /> Copied</> : "Export profile"}
                </button>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
                <input
                    value={importText}
                    onChange={(e) => {
                        setImportText(e.target.value);
                        setStatus("idle");
                    }}
                    placeholder="Paste a profile backup code…"
                    style={{
                        flex: 1,
                        fontSize: 11,
                        padding: "6px 8px",
                        borderRadius: 8,
                        background: "var(--bg-elev-2)",
                        border: `1px solid ${status === "error" ? "var(--danger)" : "var(--border)"}`,
                        color: "var(--fg)",
                    }}
                />
                <button
                    onClick={() => void doImport()}
                    disabled={!importText.trim()}
                    style={midiBtn(false)}
                >
                    Restore
                </button>
            </div>
            {status === "error" && (
                <span style={{ fontSize: 11, color: "var(--danger)" }}>
                    That doesn't look like a valid profile backup.
                </span>
            )}
            {status === "ok" && (
                <span style={{ fontSize: 11, color: "var(--good)" }}><Check size={11} aria-hidden style={{ verticalAlign: "-2px" }} /> Profile restored</span>
            )}
            <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
            <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>
                Or sync to your account through MixAI Server — sign in to your library
                (device token + user) in the Library tab first.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                    onClick={() => void doCloudSave()}
                    disabled={!cloudReady || cloud === "saving" || cloud === "loading"}
                    style={midiBtn(false)}
                >
                    {cloud === "saving" ? "Saving…" : cloud === "saved" ? <><Check size={11} aria-hidden /> Saved</> : "Save to cloud"}
                </button>
                <button
                    onClick={() => void doCloudLoad()}
                    disabled={!cloudReady || cloud === "saving" || cloud === "loading"}
                    style={midiBtn(false)}
                >
                    {cloud === "loading" ? "Loading…" : cloud === "loaded" ? <><Check size={11} aria-hidden /> Loaded</> : "Load from cloud"}
                </button>
            </div>
            {!cloudReady && (
                <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                    Connect the server library to enable account sync.
                </span>
            )}
            {cloud === "empty" && (
                <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                    No profile saved to your account yet — use “Save to cloud” first.
                </span>
            )}
            {cloud === "error" && (
                <span style={{ fontSize: 11, color: "var(--danger)" }}>
                    Couldn't reach your account. Check the server connection.
                </span>
            )}
        </div>
    );
}
