"use client";

// Compat wrapper over @mmo/ui Button (Base UI): keeps Radix-style `asChild`.
import { Button as UiButton, buttonVariants, type ButtonProps as UiButtonProps } from "@mmo/ui";
import { withAsChild, type AsChildProps } from "./as-child";

export type ButtonProps = AsChildProps<UiButtonProps>;
export const Button = withAsChild<UiButtonProps>(UiButton, "Button");
export { buttonVariants };