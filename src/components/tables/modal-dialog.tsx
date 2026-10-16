"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type ModalDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  /** Bloqueia fechar (Esc, fundo, X) enquanto uma ação roda. */
  locked?: boolean;
  /** "sheet" ocupa a tela toda no celular; "center" é um modal comum. */
  variant?: "center" | "sheet";
  children: ReactNode;
};

/** <dialog> modal nativo: foco preso, Esc fecha, restante da página inerte. */
export function ModalDialog({
  open,
  title,
  description,
  onClose,
  locked = false,
  variant = "center",
  children,
}: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current && !locked) onClose();
      }}
      className={cn(
        "m-auto overflow-hidden border border-line bg-surface p-0 shadow-pop",
        variant === "center"
          ? "w-[calc(100%-2rem)] max-w-md rounded-card"
          : "h-dvh max-h-dvh w-full max-w-none sm:h-[min(52rem,calc(100dvh-2rem))] sm:max-h-[calc(100dvh-2rem)] sm:w-[min(64rem,calc(100%-2rem))] sm:rounded-card",
      )}
    >
      {open ? (
        <div className={cn("flex flex-col", variant === "sheet" ? "h-full" : "max-h-[calc(100dvh-2rem)]")}>
          <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold text-fg">
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="mt-1 text-sm text-muted">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={locked}
              aria-label="Fechar"
              className="-mr-2 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </header>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
