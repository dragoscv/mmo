/**
 * WP2-17 — the Radix→Base UI compat wrappers in this folder must keep the
 * legacy call-site contracts alive: `asChild`, `onSelect`, native `onChange`,
 * string-only `onValueChange`. Each test pins one of those contracts.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@mmo/ui";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "./dropdown-menu";
import { NativeSelect, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const wrap = (ui: React.ReactNode) => render(<ThemeProvider>{ui}</ThemeProvider>);

beforeEach(() => vi.stubGlobal("ResizeObserver", RO));
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("Button (asChild compat)", () => {
    it("asChild renders the child element type with merged className and keeps its own props", () => {
        wrap(
            <Button asChild variant="outline" size="sm" className="extra">
                <a href="/library" data-x="1">
                    Library
                </a>
            </Button>,
        );
        const el = screen.getByRole("link", { name: "Library" });
        expect(el.tagName).toBe("A");
        expect(el).toHaveAttribute("href", "/library");
        expect(el).toHaveAttribute("data-x", "1");
        expect(el).toHaveAttribute("data-slot", "button");
        expect(el).toHaveAttribute("data-variant", "outline");
        expect(el).toHaveAttribute("data-size", "sm");
        expect(el.className).toContain("extra");
        expect(el.className).toContain("inline-flex");
        expect(document.querySelector("button")).toBeNull();
    });

    it("without asChild renders a <button type=button> and forwards onClick", () => {
        const onClick = vi.fn();
        wrap(<Button onClick={onClick}>Go</Button>);
        const btn = screen.getByRole("button", { name: "Go" });
        expect(btn.tagName).toBe("BUTTON");
        expect(btn).toHaveAttribute("type", "button");
        fireEvent.click(btn);
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});

describe("NativeSelect", () => {
    it("fires onChange with the event and onValueChange with the string value", () => {
        const onChange = vi.fn();
        const onValueChange = vi.fn();
        wrap(
            <NativeSelect aria-label="Key" defaultValue="a" onChange={onChange} onValueChange={onValueChange}>
                <option value="a">A</option>
                <option value="b">B</option>
            </NativeSelect>,
        );
        const sel = screen.getByRole("combobox", { name: "Key" });
        expect(sel.tagName).toBe("SELECT");
        fireEvent.change(sel, { target: { value: "b" } });
        expect(onValueChange).toHaveBeenCalledWith("b");
        expect(onChange).toHaveBeenCalledTimes(1);
        expect((onChange.mock.calls[0]![0] as React.ChangeEvent<HTMLSelectElement>).target.value).toBe("b");
    });
});

describe("Select (Base UI, Radix-shaped onValueChange)", () => {
    it("calls onValueChange with a string when an item is picked", async () => {
        const onValueChange = vi.fn();
        wrap(
            <Select defaultValue="a" defaultOpen onValueChange={onValueChange}>
                <SelectTrigger aria-label="Mode">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="a">Alpha</SelectItem>
                    <SelectItem value="b">Beta</SelectItem>
                </SelectContent>
            </Select>,
        );
        expect(screen.getByRole("combobox", { name: "Mode" })).toBeInTheDocument();
        const beta = await screen.findByRole("option", { name: "Beta" });
        expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
        await act(async () => {
            // Base UI commits a selection on keyboard Enter (a bare click is ignored in jsdom).
            beta.focus();
            fireEvent.keyDown(beta, { key: "Enter" });
        });
        expect(onValueChange).toHaveBeenCalledTimes(1);
        expect(onValueChange.mock.calls[0]![0]).toBe("b");
        expect(typeof onValueChange.mock.calls[0]![0]).toBe("string");
    });
});

describe("DropdownMenuItem (onSelect compat)", () => {
    it("clicking an item calls onSelect with a native Event and onClick with the React event", async () => {
        const onSelect = vi.fn();
        const onClick = vi.fn();
        wrap(
            <DropdownMenu defaultOpen>
                <DropdownMenuTrigger asChild>
                    <button>Open</button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                    <DropdownMenuLabel>Actions</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={onSelect} onClick={onClick}>
                        Rescan
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>,
        );
        const trigger = screen.getByRole("button", { name: "Open" });
        expect(trigger.tagName).toBe("BUTTON"); // asChild kept our element
        expect(trigger).toHaveAttribute("aria-haspopup", "menu");
        const item = await screen.findByRole("menuitem", { name: "Rescan" });
        expect(screen.getByText("Actions")).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(item);
        });
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect.mock.calls[0]![0]).toBeInstanceOf(Event);
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});

describe("Checkbox (legacy onChange)", () => {
    it("synthesises e.target.checked and still calls onCheckedChange", () => {
        const onChange = vi.fn();
        const onCheckedChange = vi.fn();
        wrap(<Checkbox aria-label="Hidden" onChange={onChange} onCheckedChange={onCheckedChange} />);
        const box = screen.getByRole("checkbox", { name: "Hidden" });
        expect(box).toHaveAttribute("aria-checked", "false");
        fireEvent.click(box);
        expect(box).toHaveAttribute("aria-checked", "true");
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0]![0].target.checked).toBe(true);
        expect(onChange.mock.calls[0]![0].currentTarget.checked).toBe(true);
        expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
        fireEvent.click(box);
        expect(onChange.mock.calls[1]![0].target.checked).toBe(false);
    });
});
