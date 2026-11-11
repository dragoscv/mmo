/**
 * Props of a button that is unavailable right now but must keep keyboard focus: `aria-disabled`
 * and no click handler. A natively `disabled` button drops focus, which strands a keyboard user
 * when the button disables itself by its own action (EXIT a loop, undo the last step, last page).
 */
export function soft(disabled: boolean, onClick: () => void): { "aria-disabled": true | undefined; onClick: (() => void) | undefined } {
    return { "aria-disabled": disabled || undefined, onClick: disabled ? undefined : onClick };
}
