import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { accounts, devices, sessions } from "@/db/schema";
import { agentPats } from "@/db/schema-ai";
import { notSignedInFor } from "@/components/empty-state-server";
import { formatRelativeTime } from "@/lib/relative-time";
import {
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@mmo/ui";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("nav");
    return { title: t("settings-security") };
}

function mask(id: string): string {
    if (id.length <= 6) return "•".repeat(id.length);
    return `${id.slice(0, 3)}…${id.slice(-3)}`;
}

export default async function SecuritySettingsPage() {
    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("settings");
    const userId = session.user.id;
    const [t, locale] = await Promise.all([getTranslations("settings.security"), getLocale()]);

    const [sessionRows, accountRows, deviceRows, patRows] = await Promise.all([
        db.select({ token: sessions.sessionToken, expires: sessions.expires, expired: sql<boolean>`${sessions.expires} < now()` })
            .from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.expires)),
        db.select({ provider: accounts.provider, providerAccountId: accounts.providerAccountId }).from(accounts).where(eq(accounts.userId, userId)),
        db.select({ id: devices.id }).from(devices).where(eq(devices.userId, userId)),
        db.select({ id: agentPats.id, label: agentPats.label, createdAt: agentPats.createdAt, lastUsedAt: agentPats.lastUsedAt, expiresAt: agentPats.expiresAt })
            .from(agentPats).where(and(eq(agentPats.userId, userId), isNull(agentPats.revokedAt))).orderBy(desc(agentPats.createdAt)),
    ]);
    return (
        <main className="space-y-6">
            <header>
                <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("title")}</h1>
                <p className="text-sm text-muted-foreground">{t("description")}</p>
            </header>

            <Card>
                <CardHeader>
                    <CardTitle>{t("sessions.title")}</CardTitle>
                    <CardDescription>{t("sessions.description", { count: sessionRows.length })}</CardDescription>
                </CardHeader>
                <CardContent>
                    {sessionRows.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("sessions.empty")}</p>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("sessions.token")}</TableHead>
                                    <TableHead>{t("sessions.expires")}</TableHead>
                                    <TableHead>{t("sessions.state")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {sessionRows.map((s) => (
                                    <TableRow key={s.token}>
                                        <TableCell className="font-mono text-xs">{mask(s.token)}</TableCell>
                                        <TableCell title={s.expires.toLocaleString(locale)}>{formatRelativeTime(s.expires, locale)}</TableCell>
                                        <TableCell>
                                            <Badge variant={s.expired ? "secondary" : "success"}>{s.expired ? t("sessions.expired") : t("sessions.active")}</Badge>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("accounts.title")}</CardTitle>
                    <CardDescription>{t("accounts.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                    {accountRows.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("accounts.empty")}</p>
                    ) : (
                        <ul className="divide-y divide-border">
                            {accountRows.map((a) => (
                                <li key={`${a.provider}:${a.providerAccountId}`} className="flex items-center justify-between gap-4 py-2 text-sm">
                                    <span className="font-medium capitalize">{a.provider}</span>
                                    <span className="font-mono text-xs text-muted-foreground">{mask(a.providerAccountId)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("tokens.title")}</CardTitle>
                    <CardDescription>{t("tokens.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between gap-4 text-sm">
                        <span>{t("tokens.devices", { count: deviceRows.length })}</span>
                        <Button variant="link" size="sm" render={<Link href="/settings/devices" />}>{t("tokens.manageDevices")}</Button>
                    </div>
                    {patRows.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("tokens.patsEmpty")}</p>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("tokens.patName")}</TableHead>
                                    <TableHead>{t("tokens.patCreated")}</TableHead>
                                    <TableHead>{t("tokens.patLastUsed")}</TableHead>
                                    <TableHead>{t("tokens.patExpires")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {patRows.map((p) => (
                                    <TableRow key={p.id}>
                                        <TableCell className="font-medium">{p.label}</TableCell>
                                        <TableCell>{formatRelativeTime(p.createdAt, locale) ?? "—"}</TableCell>
                                        <TableCell>{formatRelativeTime(p.lastUsedAt, locale) ?? t("tokens.never")}</TableCell>
                                        <TableCell>{p.expiresAt ? formatRelativeTime(p.expiresAt, locale) : t("tokens.noExpiry")}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("auth.title")}</CardTitle>
                    <CardDescription>{t("auth.description")}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                    <Badge variant="secondary">{t("auth.passkeys")}</Badge>
                    <Badge variant="secondary">{t("auth.twoFactor")}</Badge>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("data.title")}</CardTitle>
                    <CardDescription>{t("data.description")}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                    <Button variant="outline" render={<Link href="/settings/account" />}>{t("data.export")}</Button>
                    <Button variant="destructive" render={<Link href="/settings/account#account-delete-confirm" />}>{t("data.delete")}</Button>
                </CardContent>
            </Card>
        </main>
    );
}
