/** Settings: language, appearance (@mmo/ui ThemeSettings → mixai:prefs:v1), audio setup, shortcuts. */
import { SlidersHorizontal } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Kbd, ThemeSettings, ToggleGroup, ToggleGroupItem } from "@mmo/ui";
import { useThemePrefs } from "@mmo/ui/theme";
import { useT } from "../i18n";
import { useStore } from "../store";

export function SettingsDialog() {
    const t = useT();
    const open = useStore((s) => s.panel === "settings");
    const openPanel = useStore((s) => s.openPanel);
    const { prefs, setPrefs } = useThemePrefs();
    const keys: [string, string][] = [
        ["Space", t("keys.space")],
        ["M", t("keys.m")],
        ["← →", t("keys.arrows")],
        ["T", t("keys.t")],
        ["Esc", t("keys.esc")],
    ];
    return (
        <Dialog open={open} onOpenChange={(o) => openPanel(o ? "settings" : null)}>
            <DialogContent size="lg" className="max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t("settings.title")}</DialogTitle>
                </DialogHeader>
                <section className="flex flex-col gap-2">
                    <h3 id="set-lang" className="text-sm font-semibold">
                        {t("settings.language")}
                    </h3>
                    <ToggleGroup
                        variant="outline"
                        aria-labelledby="set-lang"
                        value={[prefs.locale]}
                        onValueChange={(v) => {
                            const l = v[0];
                            if (l === "ro" || l === "en") setPrefs({ locale: l });
                        }}
                    >
                        <ToggleGroupItem value="ro" lang="ro">
                            {t("settings.ro")}
                        </ToggleGroupItem>
                        <ToggleGroupItem value="en" lang="en">
                            {t("settings.en")}
                        </ToggleGroupItem>
                    </ToggleGroup>
                </section>
                <section className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">{t("settings.appearance")}</h3>
                    <ThemeSettings hide={["locale", "feedback"]} />
                </section>
                <section className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">{t("settings.audio")}</h3>
                    <Button variant="outline" className="w-fit" onClick={() => openPanel("setup")}>
                        <SlidersHorizontal /> {t("settings.openSetup")}
                    </Button>
                </section>
                <section className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">{t("settings.keys")}</h3>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                        {keys.map(([k, v]) => (
                            <div key={k} className="contents">
                                <dt>
                                    <Kbd>{k}</Kbd>
                                </dt>
                                <dd className="text-muted-foreground">{v}</dd>
                            </div>
                        ))}
                    </dl>
                </section>
            </DialogContent>
        </Dialog>
    );
}
