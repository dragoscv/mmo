"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { cn } from "../lib/cn";

export const avatarVariants = cva("relative inline-flex shrink-0 select-none overflow-hidden rounded-full bg-muted align-middle", {
  variants: {
    size: {
      sm: "size-6 text-[0.625rem]",
      default: "size-8 text-xs",
      lg: "size-12 text-base",
    },
  },
  defaultVariants: { size: "default" },
});

export interface AvatarProps extends BaseAvatar.Root.Props, VariantProps<typeof avatarVariants> {}

/** Circular avatar container; place AvatarImage and AvatarFallback inside. */
export function Avatar({ className, size = "default", ...props }: AvatarProps) {
  return <BaseAvatar.Root data-slot="avatar" data-size={size} className={cn(avatarVariants({ size }), className)} {...props} />;
}

/** Avatar photo; hidden until loaded, falls back to AvatarFallback on error. */
export function AvatarImage({ className, ...props }: BaseAvatar.Image.Props) {
  return <BaseAvatar.Image data-slot="avatar-image" className={cn("size-full object-cover", className)} {...props} />;
}

/** Initials or icon shown while the image loads or when it fails. */
export function AvatarFallback({ className, ...props }: BaseAvatar.Fallback.Props) {
  return (
    <BaseAvatar.Fallback
      data-slot="avatar-fallback"
      className={cn("flex size-full items-center justify-center bg-accent font-medium uppercase text-accent-foreground", className)}
      {...props}
    />
  );
}
