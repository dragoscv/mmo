import type { LucideIcon } from "lucide-react";

export function SettingsStub({ title, description, Icon }: { title: string; description: string; Icon?: LucideIcon }) {
    return (
        <main className="p-4 sm:p-6 max-w-3xl">
            <header className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                    {Icon && <Icon className="h-6 w-6 text-muted-foreground" />}
                    <h1 className="text-2xl font-bold">{title}</h1>
                </div>
                <p className="text-sm text-muted-foreground">{description}</p>
            </header>
            <div className="rounded-lg border border-dashed border-border bg-card/40 p-8 text-center">
                <p className="text-sm text-muted-foreground">
                    Această secțiune este în construcție. Setările se vor activa pe măsură ce sub-sistemele respective sunt finalizate.
                </p>
            </div>
        </main>
    );
}
