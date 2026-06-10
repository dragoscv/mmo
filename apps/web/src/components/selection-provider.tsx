"use client";

import { createContext, useContext, useCallback, useState } from "react";

interface SelectionContextValue {
    selectedIds: Set<number>;
    toggle: (id: number) => void;
    toggleAll: (ids: number[]) => void;
    select: (ids: number[]) => void;
    deselect: (ids: number[]) => void;
    clear: () => void;
    isSelected: (id: number) => boolean;
    count: number;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: React.ReactNode }) {
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

    const toggle = useCallback((id: number) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleAll = useCallback((ids: number[]) => {
        setSelectedIds((prev) => {
            const allSelected = ids.every((id) => prev.has(id));
            if (allSelected) {
                const next = new Set(prev);
                for (const id of ids) next.delete(id);
                return next;
            } else {
                const next = new Set(prev);
                for (const id of ids) next.add(id);
                return next;
            }
        });
    }, []);

    const select = useCallback((ids: number[]) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.add(id);
            return next;
        });
    }, []);

    const deselect = useCallback((ids: number[]) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.delete(id);
            return next;
        });
    }, []);

    const clear = useCallback(() => {
        setSelectedIds(new Set());
    }, []);

    const isSelected = useCallback(
        (id: number) => selectedIds.has(id),
        [selectedIds]
    );

    return (
        <SelectionContext.Provider
            value={{
                selectedIds,
                toggle,
                toggleAll,
                select,
                deselect,
                clear,
                isSelected,
                count: selectedIds.size,
            }}
        >
            {children}
        </SelectionContext.Provider>
    );
}

export function useSelection() {
    const ctx = useContext(SelectionContext);
    if (!ctx) throw new Error("useSelection must be used within SelectionProvider");
    return ctx;
}
