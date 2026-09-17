import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../theme/theme-provider.tsx";
import { EmptyState, ErrorState, NotSignedInState } from "./empty-state.tsx";

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
});
