"use client";

import { Field as BaseField } from "@base-ui/react/field";
import { cn } from "../lib/cn";

/**
 * Form field container: label above control, description/error below.
 * Wires `htmlFor`, `aria-describedby` and validity state to the child control automatically.
 * Pass `invalid`, `disabled`, `name`, `validate`, `validationMode`.
 */
export function Field({ className, ...props }: BaseField.Root.Props) {
  return <BaseField.Root data-slot="field" className={cn("group/field flex flex-col gap-2 data-disabled:opacity-60", className)} {...props} />;
}

/**
 * Field label. Automatically linked to the field's control.
 */
export function FieldLabel({ className, ...props }: BaseField.Label.Props) {
  return (
    <BaseField.Label
      data-slot="field-label"
      className={cn("flex items-center gap-2 text-sm leading-none font-medium text-foreground select-none data-disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

/**
 * Helper text under the control. Announced via `aria-describedby`.
 */
export function FieldDescription({ className, ...props }: BaseField.Description.Props) {
  return <BaseField.Description data-slot="field-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

/**
 * Validation error text. Renders only when the field is invalid (or `match` is satisfied);
 * pass `match={true}` to force it visible for server-side errors.
 */
export function FieldError({ className, ...props }: BaseField.Error.Props) {
  return <BaseField.Error data-slot="field-error" className={cn("text-sm text-destructive", className)} {...props} />;
}

/**
 * Generic control wrapper for custom inputs inside a `Field`. `Input`/`Textarea` already use it internally.
 */
export function FieldControl({ className, ...props }: BaseField.Control.Props) {
  return <BaseField.Control data-slot="field-control" className={cn(className)} {...props} />;
}
