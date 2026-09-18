"use client";

// Compat wrapper over @mmo/ui Badge (Base UI): keeps Radix-style `asChild`.
import { Badge as UiBadge, badgeVariants, type BadgeProps as UiBadgeProps } from "@mmo/ui";
import { withAsChild, type AsChildProps } from "./as-child";

export type BadgeProps = AsChildProps<UiBadgeProps>;
export const Badge = withAsChild<UiBadgeProps>(UiBadge, "Badge");
export { badgeVariants };