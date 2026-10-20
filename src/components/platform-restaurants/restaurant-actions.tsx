"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { LifeBuoy, Pause, Play } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { inputStyles } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import {
  openSupportSessionAction,
  reactivateRestaurantAction,
  suspendRestaurantAction,
} from "@/modules/platform-restaurants/actions";
import { SUPPORT_READONLY_REASON } from "@/modules/platform-restaurants/labels";

type Props = {
  restaurantId: string;
  restaurantName: string;
  status: string;
  /** Superadmin escreve; suporte só lê (o banco continua sendo a autoridade). */
  canWrite: boolean;
};

const DURATIONS = [15, 30, 60] as const;
const MIN_REASON = 10;

/** Modal com formulário (motivo/justificativa). Baseado em <dialog> nativo. */
function FormDialog({
  open,
  title,
  description,
  onClose,
  onSubmit,
  pending,
  error,
  submitLabel,
  danger,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  onSubmit: () => void;
  pending: boolean;
  error: string | null;
  submitLabel: string;
  danger?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current && !pending) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-card border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <form onSubmit={submit} noValidate className="p-6">
        <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
        <p id={descId} className="mt-2 text-sm leading-relaxed text-muted">{description}</p>
        <div className="mt-4 flex flex-col gap-4">{children}</div>
        {error ? <Alert tone="danger" className="mt-4">{error}</Alert> : null}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancelar</Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} loading={pending}>{submitLabel}</Button>
        </div>
      </form>
    </dialog>
  );
}

function ReasonField({
  label,
  hint,
  value,
  onChange,
  error,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
        <span aria-hidden="true" className="ml-1 text-muted">*</span>
      </label>
      <p id={`${id}-hint`} className="-mt-1 text-sm text-muted">{hint}</p>
      <textarea
        id={id}
        rows={4}
        maxLength={500}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
        className={inputStyles(Boolean(error), "h-auto py-2")}
      />
      <p className="text-xs text-muted tabular-nums">{value.trim().length}/500</p>
      {error ? <p id={`${id}-error`} className="text-sm font-medium text-danger">{error}</p> : null}
    </div>
  );
}

export function RestaurantActions({ restaurantId, restaurantName, status, canWrite }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const noteId = useId();
  const [pending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<"suspend" | "reactivate" | "support" | null>(null);
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState<number>(30);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const close = () => {
    if (pending) return;
    setDialog(null);
    setReason("");
    setFieldError(undefined);
    setError(null);
  };

  const run = (task: () => Promise<{ ok: boolean; message?: string; fieldErrors?: Record<string, string>; sessionId?: string }>) => {
    setFieldError(undefined);
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (!result.ok) {
        const field = result.fieldErrors?.reason;
        setFieldError(field);
        if (!field) setError(result.message ?? "Não foi possível concluir a operação.");
        return;
      }
      toast({ title: result.message ?? "Concluído", tone: "success" });
      setDialog(null);
      setReason("");
      if (result.sessionId) {
        setSessionId(result.sessionId);
        router.push(`/platform/support/${result.sessionId}`);
      } else {
        router.refresh();
      }
    });
  };

  const suspended = status === "suspended";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {suspended ? (
          <Button
            variant="secondary"
            disabled={!canWrite}
            aria-describedby={canWrite ? undefined : noteId}
            onClick={() => setDialog("reactivate")}
          >
            <Play aria-hidden="true" className="size-4" />
            Reativar
          </Button>
        ) : (
          <Button
            variant="danger"
            disabled={!canWrite}
            aria-describedby={canWrite ? undefined : noteId}
            onClick={() => setDialog("suspend")}
          >
            <Pause aria-hidden="true" className="size-4" />
            Suspender
          </Button>
        )}
        <Button variant="secondary" onClick={() => setDialog("support")}>
          <LifeBuoy aria-hidden="true" className="size-4" />
          Abrir sessão de suporte
        </Button>
      </div>
      {!canWrite ? (
        <p id={noteId} className="text-xs text-muted">{SUPPORT_READONLY_REASON}</p>
      ) : null}
      {sessionId ? (
        <Alert tone="success" title="Sessão aberta">
          Identificador da sessão: <span className="font-mono break-all">{sessionId}</span>
        </Alert>
      ) : null}

      <FormDialog
        open={dialog === "suspend"}
        title={`Suspender ${restaurantName}?`}
        description="A equipe perde o acesso ao painel e a vitrine deixa de aceitar pedidos até a reativação. O motivo fica registrado na auditoria."
        onClose={close}
        pending={pending}
        error={error}
        submitLabel="Suspender restaurante"
        danger
        onSubmit={() => {
          if (reason.trim().length < MIN_REASON) {
            setFieldError(`Descreva o motivo com pelo menos ${MIN_REASON} caracteres.`);
            return;
          }
          run(() => suspendRestaurantAction(restaurantId, { reason }));
        }}
      >
        <ReasonField
          label="Motivo da suspensão"
          hint={`Mínimo de ${MIN_REASON} caracteres.`}
          value={reason}
          onChange={setReason}
          error={fieldError}
        />
      </FormDialog>

      <ConfirmDialog
        open={dialog === "reactivate"}
        title={`Reativar ${restaurantName}?`}
        description="A equipe volta a ter acesso ao painel e a vitrine volta a funcionar."
        confirmLabel="Reativar restaurante"
        pending={pending}
        onClose={close}
        onConfirm={() => run(() => reactivateRestaurantAction(restaurantId))}
      />

      <FormDialog
        open={dialog === "support"}
        title="Abrir sessão de suporte"
        description="Dá acesso temporário somente leitura aos dados deste restaurante. A justificativa fica registrada e visível para o restaurante."
        onClose={close}
        pending={pending}
        error={error}
        submitLabel="Abrir sessão"
        onSubmit={() => {
          if (reason.trim().length < MIN_REASON) {
            setFieldError(`Descreva a justificativa com pelo menos ${MIN_REASON} caracteres.`);
            return;
          }
          run(async () => {
            const result = await openSupportSessionAction(restaurantId, { reason, minutes });
            return result.ok
              ? { ok: true, message: result.message, sessionId: result.data?.sessionId }
              : { ok: false, message: result.message, fieldErrors: result.fieldErrors };
          });
        }}
      >
        <ReasonField
          label="Justificativa"
          hint={`Por que você precisa acessar este restaurante? Mínimo de ${MIN_REASON} caracteres.`}
          value={reason}
          onChange={setReason}
          error={fieldError}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-fg">Duração</legend>
          <div className="flex gap-2">
            {DURATIONS.map((value) => (
              <label
                key={value}
                className="flex h-11 flex-1 cursor-pointer items-center justify-center rounded-control border border-line text-sm font-medium has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:text-accent-soft-fg has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
              >
                <input
                  type="radio"
                  name="minutes"
                  value={value}
                  checked={minutes === value}
                  onChange={() => setMinutes(value)}
                  className="sr-only"
                />
                {value} min
              </label>
            ))}
          </div>
        </fieldset>
      </FormDialog>
    </div>
  );
}
