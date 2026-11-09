import type { CSSProperties, ReactNode } from "react";

/** Inline button style shared by the controller/library sections. */
export function midiBtn(active: boolean): CSSProperties {
    return {
        fontSize: 12,
        fontWeight: 700,
        padding: "6px 12px",
        borderRadius: 8,
        background: active ? "var(--accent)" : "var(--bg-elev-2)",
        color: active ? "var(--accent-fg)" : "var(--fg)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
    };
}

export const selStyle: CSSProperties = {
    fontSize: 12,
    padding: "5px 8px",
    borderRadius: 8,
    background: "var(--bg-elev-2)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
};

export function Field({
    label,
    value,
    placeholder,
    type,
    onChange,
}: {
    label: string;
    value: string;
    placeholder?: string;
    type?: string;
    onChange: (v: string) => void;
}) {
    return (
        <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{label}</span>
            <input
                type={type ?? "text"}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                style={{
                    background: "var(--bg-elev-2)",
                    color: "var(--fg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 13,
                }}
            />
        </label>
    );
}

/**
 * A titled group of setting rows. `settingId` makes it a search target
 * (`data-setting-id`) so a search result can scroll it into view.
 */
export function Section({ title, settingId, children }: { title: string; settingId?: string; children: ReactNode }) {
    return (
        <section
            data-setting-id={settingId}
            className="grid scroll-mt-4 gap-2 rounded-xl transition-shadow duration-(--dur-base) data-[highlight=true]:ring-2 data-[highlight=true]:ring-ring/60 data-[highlight=true]:ring-offset-4 data-[highlight=true]:ring-offset-card"
        >
            <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{title}</h3>
            {children}
        </section>
    );
}
