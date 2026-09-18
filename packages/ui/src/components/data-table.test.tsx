import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/theme-provider";
import { DataTable, type DataTableColumnDef } from "./data-table";

interface Row {
  id: string;
  name: string;
  bpm: number;
  key: string;
}

const data: Row[] = [
  { id: "1", name: "Bravo", bpm: 128, key: "8A" },
  { id: "2", name: "Alpha", bpm: 96, key: "3B" },
  { id: "3", name: "Charlie", bpm: 174, key: "11A" },
];

const columns: Array<DataTableColumnDef<Row, any>> = [
  { id: "name", accessorKey: "name", header: "Name", meta: { priority: 1 } },
  { id: "bpm", accessorKey: "bpm", header: "BPM", meta: { priority: 2, align: "right" } },
  { id: "key", accessorKey: "key", header: "Key", meta: { hideBelow: "lg" } },
];

const wrap = (ui: React.ReactNode) => render(<ThemeProvider>{ui}</ThemeProvider>);
const head = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name, "i") });

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("DataTable", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("ResizeObserver", RO);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("maps column priority/hideBelow to responsive hide classes", () => {
    wrap(<DataTable columns={columns} data={data} />);
    // priority 1 → always visible
    expect(head("Name").className).not.toContain("hidden");
    // priority 2 → hidden below md, and align right
    expect(head("BPM").className).toContain("hidden md:table-cell");
    expect(head("BPM").className).toContain("text-right");
    // explicit hideBelow wins over the (absent) priority
    expect(head("Key").className).toContain("hidden lg:table-cell");
    // cells carry the same classes as their header
    const bpmCell = screen.getByText("128").closest("td")!;
    expect(bpmCell.className).toContain("hidden md:table-cell");
    expect(screen.getByText("8A").closest("td")!.className).toContain("hidden lg:table-cell");
  });

  it("sorting toggles aria-sort and reorders the rows", () => {
    wrap(<DataTable columns={columns} data={data} pagination={false} />);
    const nameHead = head("Name");
    expect(nameHead).toHaveAttribute("aria-sort", "none");
    const bodyNames = () => Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelector("td")?.textContent).filter(Boolean);
    expect(bodyNames()).toEqual(["Bravo", "Alpha", "Charlie"]);

    act(() => nameHead.click());
    expect(nameHead).toHaveAttribute("aria-sort", "ascending");
    expect(bodyNames()).toEqual(["Alpha", "Bravo", "Charlie"]);

    act(() => nameHead.click());
    expect(nameHead).toHaveAttribute("aria-sort", "descending");
    expect(bodyNames()).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("renders the custom empty state instead of a table when there are no rows", () => {
    wrap(<DataTable columns={columns} data={[]} emptyState={<p>Nothing to see</p>} />);
    expect(screen.getByText("Nothing to see")).toBeInTheDocument();
    expect(document.querySelector("table")).toBeNull();
  });

  it("falls back to NoResultsState when no emptyState is given", () => {
    wrap(<DataTable columns={columns} data={[]} />);
    expect(screen.getByText("Niciun rezultat")).toBeInTheDocument();
  });

  it("loading renders skeleton rows (min(pageSize,8) rows × min(cols,6)) and no data", () => {
    wrap(<DataTable columns={columns} data={data} isLoading pageSize={5} />);
    expect(screen.queryByText("Bravo")).toBeNull();
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    // 1 header row of 3 + 5 body rows of 3
    expect(skeletons.length).toBe(3 + 5 * 3);
  });

  it("selection column toggles rows and reports the selected originals", () => {
    const seen: Row[][] = [];
    wrap(<DataTable columns={columns} data={data} enableSelection onSelectionChange={(rows) => seen.push(rows)} />);
    const rowBoxes = screen.getAllByLabelText("Select row");
    expect(rowBoxes).toHaveLength(3);
    act(() => rowBoxes[1]!.click());
    expect(seen.at(-1)!.map((r) => r.name)).toEqual(["Alpha"]);
    act(() => screen.getByLabelText("Select all").click());
    expect(seen.at(-1)!).toHaveLength(3);
  });

  it("paginates: page 2 shows the remaining row and the label tracks the page", () => {
    wrap(<DataTable columns={columns} data={data} pageSize={2} />);
    expect(screen.getByText("Pagina 1 din 2")).toBeInTheDocument();
    expect(document.querySelectorAll("tbody tr[data-slot='table-row']")).toHaveLength(2);
    act(() => screen.getByRole("button", { name: "Mai mult" }).click());
    expect(screen.getByText("Pagina 2 din 2")).toBeInTheDocument();
    expect(document.querySelectorAll("tbody tr[data-slot='table-row']")).toHaveLength(1);
    expect(screen.getByText("Charlie")).toBeInTheDocument();
  });
});
