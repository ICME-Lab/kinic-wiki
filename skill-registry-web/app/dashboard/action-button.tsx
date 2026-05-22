"use client";

// Dashboard action buttons: keep ACL button feedback consistent during writes.

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export function ActionButton({
  children,
  dataTid,
  disabled = false,
  loading = false,
  loadingLabel,
  onClick,
  size = "normal",
  type = "button",
  variant
}: {
  children: ReactNode;
  dataTid?: string;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  onClick?: () => void;
  size?: "normal" | "compact";
  type?: "button" | "submit";
  variant: "primary" | "secondary" | "danger";
}) {
  const baseClass =
    "inline-flex min-w-[96px] items-center justify-center gap-2 rounded-2xl border text-sm transition duration-300 ease-out hover:-translate-y-[3px] disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const sizeClass = size === "compact" ? "px-3 py-1.5" : "px-3 py-2";
  const variantClass = buttonVariantClass(variant, loading);
  return (
    <button aria-busy={loading || undefined} className={`${baseClass} ${sizeClass} ${variantClass}`} data-tid={dataTid} disabled={disabled} type={type} onClick={onClick}>
      {loading ? <Loader2 aria-hidden className="animate-spin" size={15} /> : null}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </button>
  );
}

function buttonVariantClass(variant: "primary" | "secondary" | "danger", loading: boolean): string {
  if (variant === "danger") return loading ? "border-red-800 bg-red-800 text-white shadow-sm ring-2 ring-red-200" : "border-red-700 bg-red-700 text-white hover:bg-red-800";
  if (variant === "primary") return loading ? "border-actionHover bg-actionHover text-white shadow-sm ring-2 ring-accentLine" : "border-action bg-action font-bold text-white hover:border-accent hover:bg-accent";
  return loading ? "border-accent bg-accentSoft text-accentText shadow-sm ring-2 ring-accentLine" : "border-line bg-white text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white";
}
