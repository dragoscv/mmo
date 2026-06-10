"use client";

import { useState, useMemo } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";

export interface ComboboxOption {
    value: string;
    label: string;
    icon?: React.ReactNode;
}

interface ComboboxFilterProps {
    options: ComboboxOption[];
    placeholder: string;
    emptyText?: string;
    className?: string;
    triggerClassName?: string;
}

interface SingleComboboxProps extends ComboboxFilterProps {
    multiple?: false;
    value: string;
    onChange: (value: string) => void;
}

interface MultiComboboxProps extends ComboboxFilterProps {
    multiple: true;
    value: string[];
    onChange: (value: string[]) => void;
}

type Props = SingleComboboxProps | MultiComboboxProps;

export function ComboboxFilter(props: Props) {
    const {
        options,
        placeholder,
        emptyText = "No results found.",
        className,
        triggerClassName,
    } = props;

    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");

    const filtered = useMemo(() => {
        if (!search) return options;
        const term = search.toLowerCase();
        return options.filter((o) => o.label.toLowerCase().includes(term));
    }, [options, search]);

    if (props.multiple) {
        return (
            <MultiCombobox
                open={open}
                setOpen={setOpen}
                search={search}
                setSearch={setSearch}
                filtered={filtered}
                value={props.value}
                onChange={props.onChange}
                placeholder={placeholder}
                emptyText={emptyText}
                className={className}
                triggerClassName={triggerClassName}
            />
        );
    }

    return (
        <SingleCombobox
            open={open}
            setOpen={setOpen}
            search={search}
            setSearch={setSearch}
            filtered={filtered}
            value={props.value}
            onChange={props.onChange}
            options={options}
            placeholder={placeholder}
            emptyText={emptyText}
            className={className}
            triggerClassName={triggerClassName}
        />
    );
}

function SingleCombobox({
    open,
    setOpen,
    search,
    setSearch,
    filtered,
    value,
    onChange,
    options,
    placeholder,
    emptyText,
    className,
    triggerClassName,
}: {
    open: boolean;
    setOpen: (open: boolean) => void;
    search: string;
    setSearch: (s: string) => void;
    filtered: ComboboxOption[];
    value: string;
    onChange: (value: string) => void;
    options: ComboboxOption[];
    placeholder: string;
    emptyText: string;
    className?: string;
    triggerClassName?: string;
}) {
    const selected = options.find((o) => o.value === value);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className={cn(
                        "h-8 justify-between gap-1 text-xs font-normal",
                        !value && "text-muted-foreground",
                        triggerClassName
                    )}
                >
                    <span className="truncate">
                        {selected ? selected.label : placeholder}
                    </span>
                    {value ? (
                        <X
                            className="h-3 w-3 shrink-0 opacity-50 hover:opacity-100"
                            onClick={(e) => {
                                e.stopPropagation();
                                onChange("");
                            }}
                        />
                    ) : (
                        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent className={cn("p-0", className)} align="start">
                <Command shouldFilter={false}>
                    <CommandInput
                        placeholder={`Search ${placeholder.toLowerCase()}...`}
                        value={search}
                        onValueChange={setSearch}
                    />
                    <CommandList>
                        <CommandEmpty>{emptyText}</CommandEmpty>
                        <CommandGroup>
                            {filtered.map((option) => (
                                <CommandItem
                                    key={option.value}
                                    value={option.value}
                                    data-checked={value === option.value}
                                    onSelect={() => {
                                        onChange(
                                            value === option.value
                                                ? ""
                                                : option.value
                                        );
                                        setOpen(false);
                                        setSearch("");
                                    }}
                                >
                                    {option.icon}
                                    {option.label}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}

function MultiCombobox({
    open,
    setOpen,
    search,
    setSearch,
    filtered,
    value,
    onChange,
    placeholder,
    emptyText,
    className,
    triggerClassName,
}: {
    open: boolean;
    setOpen: (open: boolean) => void;
    search: string;
    setSearch: (s: string) => void;
    filtered: ComboboxOption[];
    value: string[];
    onChange: (value: string[]) => void;
    placeholder: string;
    emptyText: string;
    className?: string;
    triggerClassName?: string;
}) {
    function toggle(val: string) {
        if (value.includes(val)) {
            onChange(value.filter((v) => v !== val));
        } else {
            onChange([...value, val]);
        }
    }

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className={cn(
                        "h-8 justify-between gap-1 text-xs font-normal",
                        value.length === 0 && "text-muted-foreground",
                        triggerClassName
                    )}
                >
                    <span className="truncate">
                        {value.length === 0
                            ? placeholder
                            : value.length === 1
                                ? value[0]
                                : `${value.length} selected`}
                    </span>
                    {value.length > 0 ? (
                        <X
                            className="h-3 w-3 shrink-0 opacity-50 hover:opacity-100"
                            onClick={(e) => {
                                e.stopPropagation();
                                onChange([]);
                            }}
                        />
                    ) : (
                        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent className={cn("p-0", className)} align="start">
                <Command shouldFilter={false}>
                    <CommandInput
                        placeholder={`Search ${placeholder.toLowerCase()}...`}
                        value={search}
                        onValueChange={setSearch}
                    />
                    <CommandList>
                        <CommandEmpty>{emptyText}</CommandEmpty>
                        <CommandGroup>
                            {filtered.map((option) => (
                                <CommandItem
                                    key={option.value}
                                    value={option.value}
                                    data-checked={value.includes(option.value)}
                                    onSelect={() => toggle(option.value)}
                                >
                                    {option.icon}
                                    {option.label}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
                {value.length > 0 && (
                    <div className="flex flex-wrap gap-1 border-t border-border p-2">
                        {value.map((v) => (
                            <Badge
                                key={v}
                                variant="secondary"
                                className="gap-1 text-[10px] h-5"
                            >
                                {v}
                                <button
                                    onClick={() => toggle(v)}
                                    className="hover:text-destructive"
                                >
                                    <X className="h-2.5 w-2.5" />
                                </button>
                            </Badge>
                        ))}
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}
