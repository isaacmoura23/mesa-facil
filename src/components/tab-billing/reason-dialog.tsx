"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type ReasonDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  label: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  minLength: number;
  maxLength?: number;
  /** Executa a ação. Devolve a mensagem de erro (fica no diálogo) ou null quando deu certo. */
  onSubmit: (reason: string) => Promise<string | null>;
  onClose: () => void;
};

/**
 * Diálogo com texto obrigatório (justificativa/motivo). O contador mostra
 * quanto falta; o botão só habilita com o mínimo. Erros do servidor aparecem
 * dentro do diálogo para a pessoa corrigir sem perder o texto.
 */
export function ReasonDialog({
  open,
  title,
  description,
  label,
  confirmLabel,
  cancelLabel = "Voltar",
  tone = "default",
  minLength,
  maxLength = 500,
  onSubmit,
  onClose,
}: ReasonDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const fieldId = useId();
  const countId = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lockRef = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const length = text.trim().length;
  const valid = length >= minLength && length <= maxLength;

  function close() {
    if (pending) return;
    setText("");
    setError(null);
    onClose();
  }

  async function submit() {
    if (lockRef.current || !valid) return;
    lockRef.current = true;
    setPending(true);
    setError(null);
    try {
      const failure = await onSubmit(text.trim());
      if (failure) {
        setError(failure);
      } else {
        setText("");
      }
    } finally {
      lockRef.current = false;
      setPending(false);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === ref.current) close();
      }}
      className="m-auto max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-md overflow-y-auto rounded-card border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <form
        className="flex flex-col gap-4 p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <div id={descId} className="text-sm leading-relaxed text-muted">
          {description}
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={fieldId} className="text-sm font-medium">
            {label}
          </label>
          <textarea
            id={fieldId}
            rows={3}
            value={text}
            maxLength={maxLength}
            onChange={(event) => setText(event.target.value)}
            disabled={pending}
            aria-describedby={countId}
            className="block w-full resize-y rounded-control border border-line bg-surface px-3 py-2 text-base text-fg hover:border-line-strong disabled:opacity-60 sm:text-sm"
          />
          <p id={countId} className="text-xs text-muted" aria-live="polite">
            {length < minLength
              ? `Escreva pelo menos ${minLength} caracteres (faltam ${minLength - length}).`
              : `${length} de ${maxLength} caracteres.`}
          </p>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={close} disabled={pending} autoFocus>
            {cancelLabel}
          </Button>
          <Button type="submit" variant={tone === "danger" ? "danger" : "primary"} loading={pending} disabled={!valid}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
