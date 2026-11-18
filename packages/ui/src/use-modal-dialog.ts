"use client";

import type { SyntheticEvent } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";

const FALLBACK_INITIAL_FOCUS = [
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  'button:not([disabled]):not([tabindex="-1"])',
  '[href]:not([tabindex="-1"])'
].join(",");

export function useModalDialog(onCancel: () => void, cancelDisabled: boolean, active = true) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const initialFocus = dialog.querySelector<HTMLElement>("[data-modal-initial-focus]")
      ?? dialog.querySelector<HTMLElement>(FALLBACK_INITIAL_FOCUS);
    initialFocus?.focus();

    return () => {
      if (dialog.open) dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active]);

  const handleCancel = useCallback((event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    if (!cancelDisabled) onCancel();
  }, [cancelDisabled, onCancel]);

  return { dialogRef, handleCancel };
}
