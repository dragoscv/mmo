"use client";

/**
 * WP9-01 — every `@mmo/ui` component family in a grid of `surface` cards.
 * Toolbar flips every theme dimension live; the "matrix" renders Buttons + Cards
 * 3× side-by-side forced to light/dark × glass/solid/flat.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
    Accordion,
    AccordionItem,
    AccordionPanel,
    AccordionTrigger,
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
    Avatar,
    AvatarFallback,
    AvatarImage,
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
    Checkbox,
    Collapsible,
    CollapsiblePanel,
    CollapsibleTrigger,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    DataTable,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    EmptyState,
    ErrorState,
    Field,
    FieldDescription,
    FieldLabel,
    Input,
    Kbd,
    KbdCombo,
    Label,
    NoCompanionState,
    NoResultsState,
    NotSignedInState,
    Page,
    PageHeader,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Progress,
    ProgressJob,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
    Skeleton,
    SkeletonCard,
    SkeletonGrid,
    SkeletonTable,
    SkeletonText,
    Slider,
    Switch,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    Textarea,
    Toaster,
    ToastProvider,
    ToggleGroup,
    ToggleGroupItem,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    ThemeSettings,
    useThemePrefs,
    useToast,
    type DataTableColumnDef,
} from "@mmo/ui";
import {
    ACCENTS,
    DENSITIES,
    MODES,
    ROLES,
    SURFACES,
    SURFACE_VARS,
    oklchCss,
    type AccentPreset,
    type Surface,
} from "@mmo/design-tokens";
import { Download, Grid3x3, Music, Play, Settings2, Sparkles } from "lucide-react";

// ─── Helpers ────────────────────────────────────────────────────────────────

const BUTTON_VARIANTS = ["default", "gradient", "outline", "secondary", "ghost", "destructive", "link"] as const;
const BUTTON_SIZES = ["xs", "sm", "default", "lg"] as const;
const BADGE_VARIANTS = ["default", "secondary", "outline", "destructive", "success", "warning", "info", "gradient"] as const;

/** Inline role vars so a wrapper re-themes independently of `:root[data-mode]`. */
function modeVars(mode: "light" | "dark"): CSSProperties {
    const out: Record<string, string> = {};
    for (const [name, c] of Object.entries(ROLES[mode])) out[`--${name}`] = oklchCss(c);
    out["--primary-l"] = String(ROLES[mode].primary.l);
    out["--primary-c"] = String(ROLES[mode].primary.c);
    out.colorScheme = mode;
    return out as CSSProperties;
}

function surfaceVars(surface: Surface): CSSProperties {
    return SURFACE_VARS[surface] as CSSProperties;
}

function Section({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
    return (
        <section id={id} data-catalog-section={id} className={`surface flex flex-col gap-4 rounded-xl p-5 ${className ?? ""}`}>
            <h2 className="font-heading text-base font-semibold">{title}</h2>
            {children}
        </section>
    );
}

function Row({ children }: { children: ReactNode }) {
    return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

// ─── Fake data ──────────────────────────────────────────────────────────────

interface FakeTrack {
    id: number;
    title: string;
    artist: string;
    bpm: number;
    key: string;
    genre: string;
    duration: string;
    added: string;
}

const FAKE_TRACKS: FakeTrack[] = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    title: `Track ${i + 1}`,
    artist: ["Nova", "Kyma", "Orbit", "Lumen"][i % 4]!,
    bpm: 120 + (i * 3) % 20,
    key: ["8A", "9B", "11A", "2B", "5A", "7B"][i % 6]!,
    genre: ["Techno", "House", "Trance", "Drum & Bass"][i % 4]!,
    duration: `${5 + (i % 4)}:${String((i * 17) % 60).padStart(2, "0")}`,
    added: `2026-09-${String(1 + i).padStart(2, "0")}`,
}));

const TRACK_COLUMNS: Array<DataTableColumnDef<FakeTrack, any>> = [
    { accessorKey: "title", header: "Title", meta: { priority: 1 } },
    { accessorKey: "artist", header: "Artist", meta: { priority: 1 } },
    { accessorKey: "bpm", header: "BPM", meta: { priority: 2, align: "right" } },
    { accessorKey: "key", header: "Key", meta: { priority: 2 } },
    { accessorKey: "genre", header: "Genre", meta: { priority: 3 } },
    { accessorKey: "duration", header: "Duration", meta: { priority: 3, align: "right" } },
    { accessorKey: "added", header: "Added", meta: { priority: 3, hideBelow: "lg" } },
];

// ─── Sections ───────────────────────────────────────────────────────────────

function ButtonsSection() {
    return (
        <Section id="buttons" title="Buttons">
            {BUTTON_VARIANTS.map((variant) => (
                <Row key={variant}>
                    <span className="w-24 text-xs text-muted-foreground">{variant}</span>
                    {BUTTON_SIZES.map((size) => (
                        <Button key={size} variant={variant} size={size}>
                            {size}
                        </Button>
                    ))}
                    <Button variant={variant} size="icon" aria-label="icon">
                        <Play />
                    </Button>
                    <Button variant={variant}>
                        <Download /> Icon
                    </Button>
                    <Button variant={variant} loading>
                        Loading
                    </Button>
                    <Button variant={variant} disabled>
                        Disabled
                    </Button>
                </Row>
            ))}
        </Section>
    );
}

function CardsSection() {
    return (
        <Section id="cards" title="Card">
            <div className="grid gap-4 sm:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>Now playing</CardTitle>
                        <CardDescription>Card with header, content and footer.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Progress value={64} showValue />
                    </CardContent>
                    <CardFooter className="gap-2">
                        <Button size="sm">Play</Button>
                        <Button size="sm" variant="ghost">
                            Queue
                        </Button>
                    </CardFooter>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>Badges</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Row>
                            {BADGE_VARIANTS.map((v) => (
                                <Badge key={v} variant={v}>
                                    {v}
                                </Badge>
                            ))}
                        </Row>
                    </CardContent>
                </Card>
            </div>
        </Section>
    );
}

function InputsSection() {
    const [slider, setSlider] = useState<number>(40);
    return (
        <Section id="inputs" title="Inputs">
            <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                    <FieldLabel>Email</FieldLabel>
                    <Input placeholder="you@mixai.ro" />
                    <FieldDescription>Field + Input with description.</FieldDescription>
                </Field>
                <Field>
                    <FieldLabel>Notes</FieldLabel>
                    <Textarea placeholder="Textarea…" rows={3} />
                </Field>
                <Row>
                    <Input size="sm" placeholder="sm" />
                    <Input placeholder="default" />
                    <Input size="lg" placeholder="lg" />
                    <Input placeholder="disabled" disabled />
                </Row>
                <Select defaultValue="house">
                    <SelectTrigger className="w-48">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="house">House</SelectItem>
                        <SelectItem value="techno">Techno</SelectItem>
                        <SelectItem value="trance">Trance</SelectItem>
                    </SelectContent>
                </Select>
                <Row>
                    <Label className="flex items-center gap-2">
                        <Checkbox defaultChecked /> Checkbox
                    </Label>
                    <Label className="flex items-center gap-2">
                        <Checkbox disabled /> Disabled
                    </Label>
                    <Label className="flex items-center gap-2">
                        <Switch defaultChecked /> Switch
                    </Label>
                    <Label className="flex items-center gap-2">
                        <Switch size="sm" /> Small
                    </Label>
                </Row>
                <Slider label="Volume" showValue min={0} max={100} value={slider} onValueChange={(v) => setSlider(Array.isArray(v) ? v[0] ?? 0 : v)} />
                <RadioGroup defaultValue="a" className="flex gap-4">
                    {["a", "b", "c"].map((v) => (
                        <Label key={v} className="flex items-center gap-2">
                            <RadioGroupItem value={v} /> Option {v.toUpperCase()}
                        </Label>
                    ))}
                </RadioGroup>
                <ToggleGroup defaultValue={["deck-b"]} variant="outline">
                    <ToggleGroupItem value="deck-a">Deck A</ToggleGroupItem>
                    <ToggleGroupItem value="deck-b">Deck B</ToggleGroupItem>
                    <ToggleGroupItem value="deck-c">Deck C</ToggleGroupItem>
                </ToggleGroup>
            </div>
        </Section>
    );
}

function OverlaysSection() {
    return (
        <Section id="overlays" title="Overlays">
            <TooltipProvider>
                <Row>
                    <Dialog>
                        <DialogTrigger render={<Button variant="outline" />}>Dialog</DialogTrigger>
                        <DialogContent>
                            <DialogHeader>
                                <DialogTitle>Dialog title</DialogTitle>
                                <DialogDescription>Centered on desktop, sheet on mobile.</DialogDescription>
                            </DialogHeader>
                            <DialogFooter>
                                <Button>Confirm</Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                    <Sheet>
                        <SheetTrigger render={<Button variant="outline" />}>Sheet</SheetTrigger>
                        <SheetContent>
                            <SheetHeader>
                                <SheetTitle>Sheet title</SheetTitle>
                                <SheetDescription>Slides in from the right.</SheetDescription>
                            </SheetHeader>
                        </SheetContent>
                    </Sheet>
                    <AlertDialog>
                        <AlertDialogTrigger render={<Button variant="destructive" />}>Alert dialog</AlertDialogTrigger>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>Delete playlist?</AlertDialogTitle>
                                <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction variant="destructive">Delete</AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                    <Popover>
                        <PopoverTrigger render={<Button variant="outline" />}>Popover</PopoverTrigger>
                        <PopoverContent className="w-56 text-sm">Popover content.</PopoverContent>
                    </Popover>
                    <Tooltip>
                        <TooltipTrigger render={<Button variant="outline" />}>Tooltip</TooltipTrigger>
                        <TooltipContent>Hover / focus tooltip</TooltipContent>
                    </Tooltip>
                    <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="outline" />}>Dropdown</DropdownMenuTrigger>
                        <DropdownMenuContent>
                            <DropdownMenuLabel>Track</DropdownMenuLabel>
                            <DropdownMenuItem>Play</DropdownMenuItem>
                            <DropdownMenuItem>Add to queue</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive">Remove</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <ContextMenu>
                        <ContextMenuTrigger className="flex h-control items-center rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground">
                            Right-click me
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                            <ContextMenuItem>Play</ContextMenuItem>
                            <ContextMenuItem>Edit tags</ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
                        </ContextMenuContent>
                    </ContextMenu>
                </Row>
            </TooltipProvider>
        </Section>
    );
}

function DisclosureSection() {
    return (
        <Section id="disclosure" title="Tabs · Accordion · Collapsible">
            <Tabs defaultValue="one">
                <TabsList>
                    <TabsTrigger value="one">Tracks</TabsTrigger>
                    <TabsTrigger value="two">Albums</TabsTrigger>
                    <TabsTrigger value="three">Artists</TabsTrigger>
                </TabsList>
                <TabsContent value="one" className="text-sm text-muted-foreground">
                    Tab panel one.
                </TabsContent>
                <TabsContent value="two" className="text-sm text-muted-foreground">
                    Tab panel two.
                </TabsContent>
                <TabsContent value="three" className="text-sm text-muted-foreground">
                    Tab panel three.
                </TabsContent>
            </Tabs>
            <Tabs defaultValue="a">
                <TabsList variant="line">
                    <TabsTrigger value="a">Line A</TabsTrigger>
                    <TabsTrigger value="b">Line B</TabsTrigger>
                </TabsList>
            </Tabs>
            <Accordion defaultValue={["1"]}>
                <AccordionItem value="1">
                    <AccordionTrigger>What is MixAI?</AccordionTrigger>
                    <AccordionPanel>A media organizer for DJs and producers.</AccordionPanel>
                </AccordionItem>
                <AccordionItem value="2">
                    <AccordionTrigger>Does it run offline?</AccordionTrigger>
                    <AccordionPanel>Yes, via the companion and the PWA.</AccordionPanel>
                </AccordionItem>
            </Accordion>
            <Collapsible>
                <CollapsibleTrigger className="text-sm font-medium">Toggle collapsible</CollapsibleTrigger>
                <CollapsiblePanel className="pt-2 text-sm text-muted-foreground">Collapsible content.</CollapsiblePanel>
            </Collapsible>
        </Section>
    );
}

function FeedbackSection() {
    return (
        <Section id="feedback" title="Avatar · Progress · Skeleton · Kbd">
            <Row>
                <Avatar size="sm">
                    <AvatarFallback>SM</AvatarFallback>
                </Avatar>
                <Avatar>
                    <AvatarImage src="/icons/icon-192.png" alt="" />
                    <AvatarFallback>MX</AvatarFallback>
                </Avatar>
                <Avatar size="lg">
                    <AvatarFallback>LG</AvatarFallback>
                </Avatar>
                <Kbd>K</Kbd>
                <KbdCombo combo="mod+k" />
                <KbdCombo combo="shift+?" size="md" />
            </Row>
            <Progress value={35} />
            <Progress indeterminate />
            <ProgressJob label="Scanning D:\Music" value={340} max={1200} eta="2 min left · 340/1200 files" />
            <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-1/2" />
                    <SkeletonText lines={3} />
                </div>
                <SkeletonCard />
                <SkeletonTable rows={3} cols={4} />
                <SkeletonGrid count={6} />
            </div>
        </Section>
    );
}

function EmptyStatesSection() {
    return (
        <Section id="empty-states" title="Empty states">
            <div className="grid gap-4 lg:grid-cols-2">
                <EmptyState variant="inline" icon={<Music aria-hidden />} title="No tracks yet" description="Import a folder to get started." actions={<Button size="sm">Import</Button>} />
                <NotSignedInState variant="inline" action={<Button size="sm">Sign in</Button>} />
                <NoCompanionState variant="inline" actions={<Button size="sm" variant="outline">Install companion</Button>} />
                <ErrorState variant="inline" onRetry={() => {}} />
                <NoResultsState variant="inline" />
            </div>
        </Section>
    );
}

function TableSection() {
    return (
        <Section id="data-table" title="DataTable (column priority — resize the window)">
            <DataTable columns={TRACK_COLUMNS} data={FAKE_TRACKS} pageSize={10} enableColumnVisibility getRowId={(r) => String(r.id)} />
        </Section>
    );
}

function ToastSection() {
    const toast = useToast();
    return (
        <Section id="toast" title="Toast">
            <Row>
                <Button variant="outline" onClick={() => toast.add({ title: "Saved", description: "Playlist exported.", type: "success" })}>
                    Success toast
                </Button>
                <Button variant="outline" onClick={() => toast.add({ title: "Failed", description: "Companion unreachable.", type: "error" })}>
                    Error toast
                </Button>
                <Button variant="outline" onClick={() => toast.add({ title: "Heads up", type: "warning" })}>
                    Warning toast
                </Button>
                <Button variant="outline" onClick={() => toast.add({ title: "Info", description: "Scan started.", type: "info" })}>
                    Info toast
                </Button>
            </Row>
        </Section>
    );
}

// ─── Matrix ─────────────────────────────────────────────────────────────────

function Matrix() {
    return (
        <div className="grid gap-4 xl:grid-cols-3">
            {SURFACES.map((surface) => (
                <div key={surface} className="flex flex-col gap-4">
                    {(["light", "dark"] as const).map((mode) => (
                        <div
                            key={mode}
                            data-mode={mode}
                            data-surface={surface}
                            className={`${mode === "dark" ? "dark" : ""} rounded-xl bg-background p-4 text-foreground`}
                            style={{ ...modeVars(mode), ...surfaceVars(surface) }}
                        >
                            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {mode} · {surface}
                            </p>
                            <div className="flex flex-col gap-4">
                                <div className="surface rounded-xl p-4">
                                    <Row>
                                        {BUTTON_VARIANTS.map((v) => (
                                            <Button key={v} size="sm" variant={v}>
                                                {v}
                                            </Button>
                                        ))}
                                    </Row>
                                </div>
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Card</CardTitle>
                                        <CardDescription>
                                            {mode} / {surface}
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <Row>
                                            {BADGE_VARIANTS.slice(0, 5).map((v) => (
                                                <Badge key={v} variant={v}>
                                                    {v}
                                                </Badge>
                                            ))}
                                        </Row>
                                    </CardContent>
                                </Card>
                            </div>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

// ─── Toolbar ────────────────────────────────────────────────────────────────

function Toolbar({ matrix, onMatrixChange }: { matrix: boolean; onMatrixChange: (v: boolean) => void }) {
    const t = useTranslations("dev.ui");
    const { prefs, setPrefs } = useThemePrefs();
    const accents = useMemo(() => Object.keys(ACCENTS) as AccentPreset[], []);
    return (
        <div data-catalog-toolbar="" className="surface sticky top-2 z-(--z-sticky) flex flex-wrap items-center gap-3 rounded-xl px-4 py-2 text-sm">
            <ToggleGroup value={[prefs.mode]} onValueChange={(v) => v[0] && setPrefs({ mode: v[0] })} variant="outline" size="sm" aria-label={t("mode")}>
                {MODES.map((m) => (
                    <ToggleGroupItem key={m} value={m}>
                        {m}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            <ToggleGroup value={[prefs.surface]} onValueChange={(v) => v[0] && setPrefs({ surface: v[0] })} variant="outline" size="sm" aria-label={t("surface")}>
                {SURFACES.map((s) => (
                    <ToggleGroupItem key={s} value={s}>
                        {s}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            <ToggleGroup value={[prefs.density]} onValueChange={(v) => v[0] && setPrefs({ density: v[0] })} variant="outline" size="sm" aria-label={t("density")}>
                {DENSITIES.map((d) => (
                    <ToggleGroupItem key={d} value={d}>
                        {d}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            <div role="radiogroup" aria-label={t("accent")} className="flex items-center gap-1.5">
                {accents.map((a) => (
                    <button
                        key={a}
                        type="button"
                        role="radio"
                        aria-checked={prefs.accent === a}
                        aria-label={a}
                        title={a}
                        onClick={() => setPrefs({ accent: a })}
                        className={`size-6 rounded-full ${prefs.accent === a ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""}`}
                        style={{ background: `oklch(var(--primary-l) var(--primary-c) ${ACCENTS[a].hue})` }}
                    />
                ))}
            </div>
            <Label className="flex items-center gap-2">
                <Switch checked={matrix} onCheckedChange={onMatrixChange} size="sm" />
                <Grid3x3 className="size-4" aria-hidden /> {t("matrix")}
            </Label>
            <Sheet>
                <SheetTrigger render={<Button variant="ghost" size="sm" className="ml-auto" />}>
                    <Settings2 /> {t("allSettings")}
                </SheetTrigger>
                <SheetContent className="w-full max-w-md">
                    <SheetHeader>
                        <SheetTitle>{t("allSettings")}</SheetTitle>
                    </SheetHeader>
                    <ThemeSettings hide={["locale", "feedback"]} />
                </SheetContent>
            </Sheet>
        </div>
    );
}

// ─── Root ───────────────────────────────────────────────────────────────────

export function UiCatalog() {
    const t = useTranslations("dev.ui");
    const [matrix, setMatrix] = useState(false);
    return (
        <ToastProvider>
            <Page width="xl" data-ui-catalog="">
                <PageHeader
                    eyebrow="dev"
                    title={t("title")}
                    description={t("description")}
                    actions={
                        <Badge variant="outline">
                            <Sparkles /> @mmo/ui
                        </Badge>
                    }
                />
                <div className="flex flex-col gap-6">
                    <Toolbar matrix={matrix} onMatrixChange={setMatrix} />
                    {matrix ? (
                        <Section id="matrix" title={t("matrixTitle")}>
                            <Matrix />
                        </Section>
                    ) : null}
                    <ButtonsSection />
                    <CardsSection />
                    <InputsSection />
                    <OverlaysSection />
                    <DisclosureSection />
                    <FeedbackSection />
                    <EmptyStatesSection />
                    <TableSection />
                    <ToastSection />
                </div>
            </Page>
            <Toaster />
        </ToastProvider>
    );
}
