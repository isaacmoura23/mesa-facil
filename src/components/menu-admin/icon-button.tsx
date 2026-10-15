"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** Rótulo acessível (obrigatório: o botão só tem ícone). */
  label: string;
  tone?: "default" | "danger";
  children: ReactNode;
};

/** Botão só com ícone, alvo de toque de 40 px no celular. */
export function IconButton({ label, tone = "default", className, type = "button", children, ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-control transition-colors disabled:pointer-events-none disabled:opacity-45 sm:size-9 [&_svg]:size-[1.125rem]",
        tone === "danger"
          ? "text-danger hover:bg-danger-soft"
          : "text-muted hover:bg-surface-2 hover:text-fg",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
