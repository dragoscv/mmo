"use client";

import * as React from "react";
import {
  columnVisibilityFeature,
  createCoreRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type Row,
  type RowData,
} from "@tanstack/react-table";
import { Popover } from "@base-ui/react/popover";
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, Columns3Icon } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { useUiT } from "../i18n/index.tsx";
import { useIsMobile } from "../hooks/index.ts";
import { SkeletonTable } from "./skeleton.tsx";
import { NoResultsState } from "./empty-state.tsx";
import { Button } from "./button.tsx";

// ─── Classic table primitives (legacy call sites) ───────────────────────────

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "h-row border-b border-border transition-colors duration-(--dur-fast) hover:bg-muted/50 data-[state=selected]:bg-accent/60 data-[selected]:bg-accent/60",
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground compact:h-8 compact:px-2 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-3 py-2 align-middle whitespace-nowrap compact:px-2 compact:py-1 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]", className)}
      {...props}
    />
  );
}

export function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />;
}

// ─── DataTable ──────────────────────────────────────────────────────────────

/** Column meta understood by <DataTable>. */
export interface DataTableColumnMeta {
  /** 1 = always visible, 2 = hidden below `md`, 3 = hidden below `lg` (unless `hideBelow` is set). */
  priority?: 1 | 2 | 3;
  hideBelow?: "sm" | "md" | "lg";
  /** Applied to both header and cells. */
  className?: string;
  /** Right-align numeric columns. */
  align?: "left" | "right" | "center";
}

export const dataTableFeatures = tableFeatures({
  rowSelectionFeature,
  rowPaginationFeature,
  columnVisibilityFeature,
  rowSortingFeature,
  coreRowModel: createCoreRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  columnMeta: {} as DataTableColumnMeta,
});

export type DataTableFeatures = typeof dataTableFeatures;
export type DataTableColumnDef<TData extends RowData, TValue = unknown> = ColumnDef<DataTableFeatures, TData, TValue>;
export type DataTableRow<TData extends RowData> = Row<DataTableFeatures, TData>;

const HIDE_CLASSES: Record<NonNullable<DataTableColumnMeta["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

function responsiveClass(meta: DataTableColumnMeta | undefined): string | undefined {
  if (!meta) return undefined;
  const bp = meta.hideBelow ?? (meta.priority === 2 ? "md" : meta.priority === 3 ? "lg" : undefined);
  return cn(bp ? HIDE_CLASSES[bp] : undefined, meta.align === "right" && "text-right", meta.align === "center" && "text-center", meta.className);
}

export interface DataTableProps<TData extends RowData> {
  columns: Array<DataTableColumnDef<TData, any>>;
  data: TData[];
  isLoading?: boolean;
  emptyState?: React.ReactNode;
  pageSize?: number;
  pageSizeOptions?: number[];
  /** Hide the footer entirely (no pagination). */
  pagination?: boolean;
  enableSelection?: boolean;
  enableColumnVisibility?: boolean;
  stickyHeader?: boolean;
  onRowClick?: (row: TData, tableRow: DataTableRow<TData>) => void;
  getRowId?: (row: TData, index: number) => string;
  onSelectionChange?: (rows: TData[]) => void;
  /** Rendered above the table, right-aligned with the column toggle. */
  toolbar?: React.ReactNode;
  /** Below `md`, render this card per row instead of the table. */
  mobileCard?: (row: TData, tableRow: DataTableRow<TData>) => React.ReactNode;
  className?: string;
  tableClassName?: string;
  caption?: React.ReactNode;
}

const SELECT_COLUMN_ID = "__select";

export function DataTable<TData extends RowData>({
  columns,
  data,
  isLoading = false,
  emptyState,
  pageSize = 25,
  pageSizeOptions = [10, 25, 50, 100],
  pagination = true,
  enableSelection = false,
  enableColumnVisibility = false,
  stickyHeader = false,
  onRowClick,
  getRowId,
  onSelectionChange,
  toolbar,
  mobileCard,
  className,
  tableClassName,
  caption,
}: DataTableProps<TData>) {
  const t = useUiT();
  const isMobile = useIsMobile();

  const allColumns = React.useMemo<Array<DataTableColumnDef<TData, any>>>(() => {
    if (!enableSelection) return columns;
    const selectCol: DataTableColumnDef<TData, unknown> = {
      id: SELECT_COLUMN_ID,
      enableHiding: false,
      enableSorting: false,
      header: ({ table }) => (
        <input
          type="checkbox"
          aria-label="Select all"
          className="size-4 accent-primary"
          checked={table.getIsAllPageRowsSelected()}
          ref={(el) => {
            if (el) el.indeterminate = !table.getIsAllPageRowsSelected() && table.getIsSomePageRowsSelected();
          }}
          onChange={table.getToggleAllPageRowsSelectedHandler()}
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label="Select row"
          className="size-4 accent-primary"
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onClick={(e) => e.stopPropagation()}
          onChange={row.getToggleSelectedHandler()}
        />
      ),
      meta: { priority: 1, className: "w-10" },
    };
    return [selectCol, ...columns];
  }, [columns, enableSelection]);

  const table = useTable({
    features: dataTableFeatures,
    columns: allColumns,
    data,
    getRowId,
    enableRowSelection: enableSelection,
    initialState: { pagination: { pageIndex: 0, pageSize } },
    autoResetPageIndex: true,
  });

  const { rowSelection, pagination: pageState } = table.state;

  React.useEffect(() => {
    if (!onSelectionChange) return;
    onSelectionChange(table.getSelectedRowModel().rows.map((r) => r.original));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSelection, onSelectionChange]);

  const selectedCount = Object.keys(rowSelection ?? {}).length;
  const rows = pagination ? table.getRowModel().rows : table.getSortedRowModel().rows;
  const pageCount = Math.max(1, table.getPageCount());
  const visibleLeafCount = table.getAllLeafColumns().filter((c) => c.getIsVisible()).length || 1;

  const showToolbar = Boolean(toolbar) || enableColumnVisibility;
  const useCards = isMobile && mobileCard !== undefined;

  return (
    <div data-slot="data-table" className={cn("flex w-full flex-col gap-3", className)}>
      {showToolbar ? (
        <div data-slot="data-table-toolbar" className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {enableColumnVisibility ? <ColumnVisibilityToggle table={table} label={t("table.columns")} /> : null}
        </div>
      ) : null}

      {isLoading ? (
        <SkeletonTable rows={Math.min(pageSize, 8)} cols={Math.min(allColumns.length, 6)} />
      ) : rows.length === 0 ? (
        (emptyState ?? <NoResultsState />)
      ) : useCards ? (
        <ul data-slot="data-table-cards" className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              data-selected={row.getIsSelected() || undefined}
              onClick={onRowClick ? () => onRowClick(row.original, row) : undefined}
              className={cn("surface rounded-xl p-3", onRowClick && "cursor-pointer active:scale-[0.99] transition-transform duration-(--dur-fast)", "data-[selected]:ring-2 data-[selected]:ring-ring/50")}
            >
              {mobileCard(row.original, row)}
            </li>
          ))}
        </ul>
      ) : (
        <div data-slot="table-container" className={cn("surface relative w-full overflow-auto rounded-xl", stickyHeader && "max-h-[70dvh]")}>
          <table data-slot="table" className={cn("w-full caption-bottom text-sm", tableClassName)}>
            {caption ? <TableCaption>{caption}</TableCaption> : null}
            <thead data-slot="table-header" className={cn("[&_tr]:border-b", stickyHeader && "sticky top-0 z-(--z-sticky) bg-card/95 backdrop-blur-sm")}>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="h-10 border-b border-border compact:h-8">
                  {hg.headers.map((header) => {
                    const meta = header.column.columnDef.meta;
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    return (
                      <TableHead
                        key={header.id}
                        colSpan={header.colSpan}
                        className={cn(responsiveClass(meta), canSort && "cursor-pointer select-none hover:text-foreground")}
                        aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : canSort ? "none" : undefined}
                        onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                      >
                        {header.isPlaceholder ? null : (
                          <span className={cn("inline-flex items-center gap-1", meta?.align === "right" && "flex-row-reverse")}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? <ArrowUpIcon className="size-3" aria-hidden /> : sorted === "desc" ? <ArrowDownIcon className="size-3" aria-hidden /> : null}
                          </span>
                        )}
                      </TableHead>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody data-slot="table-body" className="[&_tr:last-child]:border-0">
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-selected={row.getIsSelected() || undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row.original, row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row.original, row);
                          }
                        }
                      : undefined
                  }
                  className={cn(onRowClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40")}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={responsiveClass(cell.column.columnDef.meta)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {/* keeps colSpan consistent for screen readers when columns are hidden */}
              <tr aria-hidden className="hidden">
                <td colSpan={visibleLeafCount} />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {pagination && !isLoading && data.length > 0 ? (
        <div data-slot="data-table-footer" className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-3">
            {enableSelection ? <span aria-live="polite">{t("table.selected", { count: selectedCount })}</span> : null}
            <label className="flex items-center gap-2">
              <span className="hidden sm:inline">{t("table.rowsPerPage")}</span>
              <select
                aria-label={t("table.rowsPerPage")}
                className="h-control-sm rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30"
                value={pageState.pageSize}
                onChange={(e) => table.setPageSize(Number(e.target.value))}
              >
                {pageSizeOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <span className="tabular-nums">{t("table.page", { page: pageState.pageIndex + 1, total: pageCount })}</span>
            <Button variant="outline" size="icon-sm" aria-label={t("common.back")} disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
              <ChevronLeftIcon />
            </Button>
            <Button variant="outline" size="icon-sm" aria-label={t("common.more")} disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Column visibility (inline Base UI popover) ─────────────────────────────

function ColumnVisibilityToggle<TData extends RowData>({ table, label }: { table: ReturnType<typeof useTable<DataTableFeatures, TData>>; label: string }) {
  const columns = table.getAllLeafColumns().filter((c) => c.getCanHide());
  if (columns.length === 0) return null;
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button variant="outline" size="sm" />}>
        <Columns3Icon />
        <span className="hidden sm:inline">{label}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-(--z-popover)">
          <Popover.Popup className="surface min-w-44 rounded-xl p-1 text-sm text-popover-foreground outline-none transition-[opacity,scale] duration-(--dur-fast) ease-(--ease-out) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
            {columns.map((col) => {
              const header = col.columnDef.header;
              const text = typeof header === "string" ? header : col.id;
              return (
                <label key={col.id} className="flex h-row cursor-pointer items-center gap-2 rounded-md px-2 compact:h-8 hover:bg-accent hover:text-accent-foreground">
                  <input type="checkbox" className="size-4 accent-primary" checked={col.getIsVisible()} onChange={(e) => col.toggleVisibility(e.target.checked)} />
                  <span className="truncate">{text}</span>
                </label>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
