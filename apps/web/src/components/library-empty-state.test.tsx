/**
 * Component-level smoke tests for the empty-state panels. These are
 * the first jsdom-environment tests in the suite; they prove the
 * Testing Library wiring works end-to-end (renders RSC-friendly client
 * components, asserts against the rendered DOM, follows the `feature`
 * prop into both the title and the description).
 */
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { ThemeProvider } from "@mmo/ui";
import { NotSignedIn, NoCompanion } from "./library-empty-state";

// LoginModal pulls next-auth/react + server actions; stub it for a DOM smoke.
vi.mock("@/components/login-modal", () => ({ LoginModal: () => null }));

const wrap = (ui: React.ReactNode) => render(<ThemeProvider>{ui}</ThemeProvider>);

afterEach(() => cleanup());

describe("library-empty-state", () => {
    it("NotSignedIn renders the default feature copy and a sign-in button", () => {
        wrap(<NotSignedIn />);
        expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/your library/i);
        expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    });

    it("NotSignedIn substitutes the feature prop into both the title and the description", () => {
        wrap(<NotSignedIn feature="your dashboard" />);
        // Title + description both interpolate `feature`. Use queryAllByText
        // because both nodes match.
        const matches = screen.getAllByText(/your dashboard/i);
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it("NoCompanion renders the devices link", () => {
        wrap(<NoCompanion />);
        const link = screen.getByRole("link", { name: /manage devices/i });
        expect(link).toHaveAttribute("href", "/devices");
    });

    it("NoCompanion substitutes the feature prop", () => {
        wrap(<NoCompanion feature="your playlists" />);
        expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/your playlists/i);
    });
});
