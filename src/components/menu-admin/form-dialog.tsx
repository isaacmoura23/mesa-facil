"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type FormDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  /** Bloqueia o fechamento enquanto uma gravação está em andamento. */
  locked?: boolean;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Modal para formulários, baseado em <dialog> (foco preso, Esc e `inert`
 * nativos), igual ao ConfirmDialog. O conteúdo só é montado quando aberto,
 * então cada abertura começa com o formulário limpo.
 */
export function FormDialog({ open, title, description, locked = false, onClose, children }: FormDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

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
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current && !locked) onClose();
      }}
      className="m-auto max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-xl overflow-y-auto overscroll-contain rounded-card border border-line bg-surface p-0 shadow-pop"
    >
      {open ? (
        <div className="p-5 sm:p-6">
          <h2 id={titleId} className="text-lg font-semibold text-fg">
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p> : null}
          <div className="mt-5">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <Alert tone="danger">{message}</Alert>;
}

type FormActionsProps = {
  pending: boolean;
  submitLabel: string;
  onCancel: () => void;
};

export function FormActions({ pending, submitLabel, onCancel }: FormActionsProps) {
  return (
    <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button variant="secondary" onClick={onCancel} disabled={pending}>
        Cancelar
      </Button>
      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </div>
  );
}
