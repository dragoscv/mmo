import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../theme/theme-provider";
import { EmptyState, ErrorState, GhostTable, NotSignedInState } from "./empty-state";

const wrap = (ui: React.ReactNode) => render(<ThemeProvider>{ui}</ThemeProvider>);

describe("EmptyState", () => {
  it("renders title, description and actions", () => {
    wrap(<EmptyState title="Nothing" description="Zip" actions={<button>Go</button>} />);
    expect(screen.getByRole("heading", { name: "Nothing" })).toBeInTheDocument();
    expect(screen.getByText("Zip")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go" })).toBeInTheDocument();
  });
  it("ErrorState has role=alert and retry", () => {
    let hit = 0;
    wrap(<ErrorState onRetry={() => hit++} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    screen.getByRole("button", { name: "Reîncearcă" }).click();
    expect(hit).toBe(1);
  });
  it("NotSignedInState uses built-in RO copy by default", () => {
    wrap(<NotSignedInState action={<a href="/login">x</a>} />);
    expect(screen.getByText("Autentifică-te pentru a continua")).toBeInTheDocument();
  });
  it("backdrop is aria-hidden and does not block the CTA", () => {
    let hit = 0;
    const { container } = wrap(<EmptyState title="Gate" backdrop={<GhostTable rows={3} />} actions={<button onClick={() => hit++}>Sign in</button>} />);
    const backdrop = container.querySelector('[data-slot="empty-state-backdrop"]');
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    expect(backdrop!.className).toContain("pointer-events-none");
    expect(container.querySelectorAll('[data-slot="ghost-table"] [data-slot="skeleton"]').length).toBeGreaterThanOrEqual(9);
    const cta = screen.getByRole("button", { name: "Sign in" });
    cta.focus();
    expect(cta).toHaveFocus();
    fireEvent.click(cta);
    expect(hit).toBe(1);
  });
});
