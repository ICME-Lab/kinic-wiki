// Where: wikibrowser/components/ui/toast.tsx
// What: Minimal self-built toast notifications replacing sonner.
// Why: Avoid the sonner dependency for a small success/error/info notification surface.
import { useSyncExternalStore, type ReactNode } from "react";

type ToastVariant = "success" | "error" | "info";

type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
};

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ToastItem[] {
  return toasts;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function show(message: string, variant: ToastVariant): void {
  const id = nextId++;
  toasts = [...toasts, { id, message, variant }];
  emit();
  window.setTimeout(() => dismiss(id), 4000);
}

function dismiss(id: number): void {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

export const toast = {
  success: (message: string) => show(message, "success"),
  error: (message: string) => show(message, "error"),
  info: (message: string) => show(message, "info")
};

export function Toaster(): ReactNode {
  const items = useSyncExternalStore(subscribe, getSnapshot);
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Notifications"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2"
    >
      {items.map((item) => (
        <button
          aria-label="Dismiss notification"
          className={`pointer-events-auto w-72 rounded-lg border-l-4 bg-white px-4 py-3 text-left text-sm text-ink shadow-lg ${variantBorder(item.variant)}`}
          key={item.id}
          type="button"
          onClick={() => dismiss(item.id)}
        >
          {item.message}
        </button>
      ))}
    </section>
  );
}

function variantBorder(variant: ToastVariant): string {
  switch (variant) {
    case "success":
      return "border-emerald-500";
    case "error":
      return "border-red-500";
    case "info":
      return "border-accent";
  }
}
