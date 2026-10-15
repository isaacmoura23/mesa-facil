"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type ReasonDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  suggestions: readonly string[];
  pending?: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
};

/** Modal de motivo obrigatório (recusar/cancelar), com sugestões de um toque. */
export function ReasonDialog(props: ReasonDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const { open, onClose, pending = false } = props;
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
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current && !pending) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-card border border-line bg-surface p-0 shadow-pop"
    >
      {/* O conteúdo só existe com o modal aberto: o estado do formulário zera a cada abertura. */}
      {open ? <ReasonForm {...props} titleId={titleId} /> : null}
    </dialog>
  );
}

function ReasonForm({
  titleId,
  title,
  description,
  confirmLabel,
  suggestions,
  pending = false,
  onConfirm,
  onClose,
}: ReasonDialogProps & { titleId: string }) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const invalid = touched && reason.trim().length === 0;

  function submit() {
    setTouched(true);
    if (reason.trim().length === 0) return;
    onConfirm(reason.trim());
  }

  return (
    <div className="p-5 sm:p-6">
      <h2 id={titleId} className="text-lg font-semibold text-fg">
        {title}
      </h2>
      {description ? <p className="mt-1.5 text-sm leading-relaxed text-muted">{description}</p> : null}

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Motivos rápidos">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => setReason(suggestion)}
            className="h-10 rounded-full border border-line-strong bg-surface px-4 text-sm font-medium text-fg hover:bg-surface-2"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <label htmlFor={fieldId} className="mt-4 block text-sm font-medium text-fg">
        Motivo (obrigatório)
      </label>
      <textarea
        id={fieldId}
        value={reason}
        maxLength={300}
        rows={3}
        autoFocus
        onChange={(event) => setReason(event.target.value)}
        onBlur={() => setTouched(true)}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        className="mt-2 block w-full resize-none rounded-control border border-line bg-surface p-3 text-base text-fg hover:border-line-strong aria-invalid:border-danger sm:text-sm"
      />
      {invalid ? (
        <p id={errorId} className="mt-1.5 text-sm font-medium text-danger">
          Informe o motivo para continuar.
        </p>
      ) : null}

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" size="lg" onClick={onClose} disabled={pending}>
          Voltar
        </Button>
        <Button variant="danger" size="lg" onClick={submit} loading={pending}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
