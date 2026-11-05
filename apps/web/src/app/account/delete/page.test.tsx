import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../messages/wp16/account.en.json";
import ro from "../../../../messages/wp16/account.ro.json";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/actions/account", () => ({ deleteAccount: vi.fn() }));
vi.mock("@/lib/account/delete-account", () => ({ DELETE_CONFIRMATION: "DELETE" }));
vi.mock("next-intl/server", () => ({
    getTranslations: async (ns: string) => {
        const { createTranslator } = await import("next-intl");
        return createTranslator({ locale: "en", messages: { mx: { account: en } }, namespace: ns as never });
    },
}));

import AccountDeletePage from "./page";

afterEach(cleanup);

async function renderPage() {
    const ui = await AccountDeletePage();
    return render(<NextIntlClientProvider locale="en" messages={{ mx: { account: en } }}>{ui}</NextIntlClientProvider>);
}

describe("/account/delete", () => {
    it("signed out: explains how to delete, with sign-in and email request", async () => {
        authMock.mockResolvedValue(null);
        await renderPage();
        expect(screen.getByRole("heading", { level: 1, name: "Delete your MixAI account" })).toBeInTheDocument();
        expect(screen.getByTestId("delete-signed-out")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Sign in to delete" })).toHaveAttribute("href", "/login?callbackUrl=%2Faccount%2Fdelete");
        expect(screen.getByRole("link", { name: "Email a deletion request" }).getAttribute("href")).toMatch(/^mailto:support@mixai\.ro\?subject=/);
        expect(screen.queryByLabelText(/Type DELETE/)).toBeNull();
    });

    it("signed in: shows the account and the typed confirmation", async () => {
        authMock.mockResolvedValue({ user: { id: "u1", email: "a@b.ro" } });
        await renderPage();
        expect(screen.getByTestId("delete-signed-in")).toHaveTextContent("Signed in as a@b.ro");
        expect(screen.getByLabelText("Type DELETE to confirm")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Delete my account permanently" })).toBeDisabled();
    });

    it("RO and EN messages have the same keys", () => {
        const keys = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
        expect(keys(ro).sort()).toEqual(keys(en).sort());
    });
});
