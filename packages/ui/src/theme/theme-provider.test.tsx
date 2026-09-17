import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PREFS_STORAGE_KEY } from "@mmo/design-tokens";
import { ThemeProvider, useThemePrefs } from "./theme-provider.tsx";
import { loadPrefs } from "./prefs-store.ts";

function Probe() {
  const { prefs, resolvedMode, setPrefs } = useThemePrefs();
  return (
    <div>
      <span data-testid="mode">{prefs.mode}</span>
      <span data-testid="resolved">{resolvedMode}</span>
      <span data-testid="accent">{prefs.accent}</span>
      <button onClick={() => setPrefs({ accent: "custom:120", mode: "light" })}>set</button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("migrates the legacy `theme` key", () => {
    window.localStorage.setItem("theme", "light");
    const p = loadPrefs(window.localStorage);
    expect(p.mode).toBe("light");
    expect(window.localStorage.getItem(PREFS_STORAGE_KEY)).toContain('"mode":"light"');
  });

  it("applies data attributes and accent hue to <html>", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    const html = document.documentElement;
    expect(html.getAttribute("data-accent")).toBe("violet");
    expect(html.getAttribute("data-surface")).toBe("glass");
    act(() => screen.getByText("set").click());
    expect(screen.getByTestId("accent").textContent).toBe("custom:120");
    expect(html.getAttribute("data-accent")).toBe("custom");
    expect(html.style.getPropertyValue("--accent-h")).toBe("120");
    expect(html.getAttribute("data-mode")).toBe("light");
    expect(html.classList.contains("light")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY)!).accent).toBe("custom:120");
  });
});
