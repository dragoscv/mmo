import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFS_STORAGE_KEY, type ThemePrefs } from "@mmo/design-tokens";
import { ThemeProvider } from "../theme/theme-provider";
import { ThemeSettings } from "./theme-settings";

const mount = (props: Partial<React.ComponentProps<typeof ThemeSettings>> = {}, onChange?: (p: ThemePrefs) => void) =>
  render(
    <ThemeProvider onChange={onChange}>
      <ThemeSettings {...props} />
    </ThemeProvider>,
  );

const group = (name: string) => screen.getByRole("radiogroup", { name });
const stored = () => JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY)!) as ThemePrefs;

describe("ThemeSettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("mode radios call setPrefs({mode}) and only the chosen one is aria-checked", () => {
    const onChange = vi.fn();
    mount({}, onChange);
    const modes = group("Mod");
    const light = within(modes).getByRole("radio", { name: "Luminos" });
    expect(within(modes).getByRole("radio", { name: "Sistem" })).toHaveAttribute("aria-checked", "true");
    act(() => light.click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "light" }));
    expect(light).toHaveAttribute("aria-checked", "true");
    expect(within(modes).getByRole("radio", { name: "Sistem" })).toHaveAttribute("aria-checked", "false");
    expect(document.documentElement.getAttribute("data-mode")).toBe("light");
    expect(stored().mode).toBe("light");
  });

  it.each([
    ["Suprafețe", "Plat", { surface: "flat" }],
    ["Densitate", "Compact", { density: "compact" }],
    ["Rotunjire colțuri", "Ascuțit", { radius: "sm" }],
    ["Animații", "Reduse", { motion: "reduced" }],
  ] as const)("%s → %s patches %o", (groupName, optionName, patch) => {
    const onChange = vi.fn();
    mount({}, onChange);
    // surface cards append a description to the accessible name → prefix match
    act(() => within(group(groupName)).getByRole("radio", { name: new RegExp(`^${optionName}`) }).click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining(patch));
    const [k, v] = Object.entries(patch)[0]!;
    expect(document.documentElement.getAttribute(`data-${k}`)).toBe(v);
  });

  it("accent presets set data-accent + --accent-h; custom reveals the hue slider", () => {
    const onChange = vi.fn();
    mount({}, onChange);
    const accents = group("Culoare de accent");
    act(() => within(accents).getByRole("radio", { name: "Smarald" }).click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ accent: "emerald" }));
    expect(document.documentElement.getAttribute("data-accent")).toBe("emerald");
    expect(document.documentElement.style.getPropertyValue("--accent-h")).toBe("160");
    expect(screen.queryByRole("slider")).toBeNull();

    act(() => within(accents).getByRole("radio", { name: "Personalizat" }).click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ accent: "custom:285" }));
    expect(document.documentElement.getAttribute("data-accent")).toBe("custom");
    expect(document.documentElement.style.getPropertyValue("--accent-h")).toBe("285");
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuenow", "285");
    expect(screen.getByText("285°")).toBeInTheDocument();

    // keyboard nudge → new hue flows to prefs and <html>
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ accent: "custom:286" }));
    expect(document.documentElement.style.getPropertyValue("--accent-h")).toBe("286");
    expect(screen.getByText("286°")).toBeInTheDocument();
  });

  it("artwork accent is only offered with allowArtworkAccent", () => {
    const { unmount } = mount();
    expect(screen.queryByRole("radio", { name: "Din copertă" })).toBeNull();
    unmount();
    const onChange = vi.fn();
    mount({ allowArtworkAccent: true }, onChange);
    act(() => screen.getByRole("radio", { name: "Din copertă" }).click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ accent: "artwork" }));
    expect(document.documentElement.getAttribute("data-accent")).toBe("artwork");
  });

  it("hide removes exactly the named sections", () => {
    mount({ hide: ["mode", "locale", "feedback"] });
    expect(screen.queryByRole("radiogroup", { name: "Mod" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Limbă" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    // untouched sections still render
    expect(group("Culoare de accent")).toBeInTheDocument();
    expect(group("Suprafețe")).toBeInTheDocument();
    expect(group("Densitate")).toBeInTheDocument();
  });

  it("locale radio switches prefs.locale, <html lang> and the component's own strings", () => {
    const onChange = vi.fn();
    mount({}, onChange);
    expect(document.documentElement.getAttribute("lang")).toBe("ro");
    act(() => within(group("Limbă")).getByRole("radio", { name: "English" }).click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ locale: "en" }));
    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(stored().locale).toBe("en");
    // headings re-render in English
    expect(screen.getByRole("radiogroup", { name: "Language" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Limbă" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Light" })).toBeInTheDocument();
  });

  it("feedback switch and reset round-trip through prefs", () => {
    const onChange = vi.fn();
    mount({}, onChange);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
    act(() => sw.click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ feedback: true }));
    expect(sw).toHaveAttribute("aria-checked", "true");

    act(() => within(group("Mod")).getByRole("radio", { name: "Luminos" }).click());
    act(() => screen.getByRole("button", { name: "Revino la implicite" }).click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "system", feedback: false, accent: "violet" }));
    expect(sw).toHaveAttribute("aria-checked", "false");
  });
});
