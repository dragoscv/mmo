/**
 * Component-level smoke tests for the empty-state panels. These are
 * the first jsdom-environment tests in the suite; they prove the
 * Testing Library wiring works end-to-end (renders RSC-friendly client
 * components, asserts against the rendered DOM, follows the `feature`
 * prop into both the title and the description).
 */
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { NotSignedIn, NoCompanion } from "./library-empty-state";

afterEach(() => cleanup());

describe("library-empty-state", () => {
    it("NotSignedIn renders the default feature copy and a sign-in link", () => {
        render(<NotSignedIn />);
        expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(/your library/i);
        const link = screen.getByRole("link", { name: /sign in/i });
        expect(link).toHaveAttribute("href", "/login");
    });

    it("NotSignedIn substitutes the feature prop into both the title and the description", () => {
        render(<NotSignedIn feature="your dashboard" />);
        // Title + description both interpolate `feature`. Use queryAllByText
        // because both nodes match.
        const matches = screen.getAllByText(/your dashboard/i);
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it("NoCompanion renders the devices link", () => {
        render(<NoCompanion />);
        const link = screen.getByRole("link", { name: /manage devices/i });
        expect(link).toHaveAttribute("href", "/devices");
    });

    it("NoCompanion substitutes the feature prop", () => {
        render(<NoCompanion feature="your playlists" />);
        expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(/your playlists/i);
    });
});
