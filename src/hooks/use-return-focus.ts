import { useCallback, useRef, useState } from "react";

/**
 * Focus management for popovers / dropdowns / dialogs.
 *
 * Radix restores focus on close in most cases, but it fails when the element
 * that was focused unmounts (a filtered-out option, a removed chip) — focus
 * then falls back to <body> and keyboard users lose their place. This hook
 * makes the return explicit: the trigger always regains focus after the
 * overlay closes, whether it closed via Escape, outside click, or selection.
 */
export function useReturnFocus<T extends HTMLElement = HTMLButtonElement>() {
  const triggerRef = useRef<T | null>(null);
  const [open, setOpen] = useState(false);

  const returnFocus = useCallback(() => {
    // Wait a frame so Radix has finished unmounting the overlay content.
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);

  const closeAndReturnFocus = useCallback(() => {
    setOpen(false);
    returnFocus();
  }, [returnFocus]);

  /** Spread onto PopoverContent / DropdownMenuContent / DialogContent. */
  const contentProps = {
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      returnFocus();
    },
  };

  return { triggerRef, open, setOpen, returnFocus, closeAndReturnFocus, contentProps };
}
