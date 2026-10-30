"use client";

import { useRef, useState, type FormEvent } from "react";
import { FormActions, FormDialog, FormError } from "@/components/menu-admin/form-dialog";
import { TextField } from "@/components/ui/input";
import { CashError } from "@/modules/cash/rpc";
import { formatMoney } from "@/modules/operations/format";
import { parseMoneyToCents } from "@/modules/tab-billing/money";

type CommonProps = { open: boolean; onClose: () => void };

const messageOf = (cause: unknown) => (cause instanceof CashError ? cause.message : "Não foi possível concluir agora. Tente de novo.");

/** Chave da tentativa: o mesmo envio (clique duplo, rede ruim) reaproveita a chave e não duplica. */
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}-xxxx`;

type MoneyReasonProps = CommonProps & {
  title: string;
  description?: string;
  submitLabel: string;
  reasonLabel: string;
  reasonHint?: string;
  reasonRequired: boolean;
  amountLabel?: string;
  /** Grava; `key` é a chave de idempotência desta tentativa. */
  onSubmit: (amountCents: number, reason: string, key: string) => Promise<void>;
};

/** Formulário de valor + motivo (entrada, saída, pedir retirada e retirar direto). */
export function MoneyReasonDialog({ open, onClose, title, description, submitLabel, reasonLabel, reasonHint, reasonRequired, amountLabel = "Valor (R$)", onSubmit }: MoneyReasonProps) {
  return (
    <FormDialog open={open} title={title} description={description} onClose={onClose}>
      <MoneyReasonForm
        onClose={onClose}
        submitLabel={submitLabel}
        reasonLabel={reasonLabel}
        reasonHint={reasonHint}
        reasonRequired={reasonRequired}
        amountLabel={amountLabel}
        onSubmit={onSubmit}
      />
    </FormDialog>
  );
}

function MoneyReasonForm({ onClose, submitLabel, reasonLabel, reasonHint, reasonRequired, amountLabel, onSubmit }: Omit<MoneyReasonProps, "open" | "title" | "description">) {
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const cents = amountText.trim() ? parseMoneyToCents(amountText) : null;
  const amountError = amountText.trim() && (cents === null || cents <= 0) ? "Informe um valor maior que zero, por exemplo 25,90." : undefined;
  const reasonError = reasonRequired && reason.trim().length > 0 && reason.trim().length < 3 ? "Escreva pelo menos 3 letras." : undefined;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (cents === null || cents <= 0) return setError("Informe um valor maior que zero.");
    if (reasonRequired && reason.trim().length < 3) return setError("Informe o motivo (pelo menos 3 letras).");
    const signature = `${cents}|${reason.trim()}`;
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: newKey() };
    setPending(true);
    setError(null);
    try {
      await onSubmit(cents, reason.trim(), attempt.current.key);
      attempt.current = null;
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField label={amountLabel ?? "Valor (R$)"} inputMode="decimal" autoComplete="off" value={amountText} onChange={(event) => setAmountText(event.target.value)} error={amountError} disabled={pending} autoFocus />
      <TextField label={reasonLabel} hint={reasonHint} maxLength={300} autoComplete="off" value={reason} onChange={(event) => setReason(event.target.value)} error={reasonError} disabled={pending} />
      <FormError message={error} />
      <FormActions pending={pending} submitLabel={submitLabel} onCancel={onClose} />
    </form>
  );
}

/** Abrir turno: valor inicial na gaveta (troco inicial). */
export function OpenSessionDialog({ open, onClose, onSubmit }: CommonProps & { onSubmit: (openingCents: number) => Promise<void> }) {
  return (
    <FormDialog open={open} title="Abrir turno do caixa" description="Informe o dinheiro que já está na gaveta (troco inicial). Pode ser zero." onClose={onClose}>
      <OpenForm onClose={onClose} onSubmit={onSubmit} />
    </FormDialog>
  );
}

function OpenForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (openingCents: number) => Promise<void> }) {
  const [text, setText] = useState("0,00");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseMoneyToCents(text);
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (cents === null) return setError("Informe um valor, por exemplo 50,00.");
    setPending(true);
    setError(null);
    try {
      await onSubmit(cents);
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField label="Dinheiro na gaveta (R$)" inputMode="decimal" autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} error={text.trim() && cents === null ? "Informe um valor, por exemplo 50,00." : undefined} disabled={pending} autoFocus />
      <FormError message={error} />
      <FormActions pending={pending} submitLabel="Abrir turno" onCancel={onClose} />
    </form>
  );
}

/** Fechar turno: conta o dinheiro; mostra o esperado e a diferença. */
export function CloseSessionDialog({ open, onClose, expectedCents, onSubmit }: CommonProps & { expectedCents: number; onSubmit: (countedCents: number, notes: string | null) => Promise<void> }) {
  return (
    <FormDialog open={open} title="Fechar turno do caixa" description="Conte o dinheiro da gaveta e informe o total. O sistema mostra a diferença." onClose={onClose}>
      <CloseForm onClose={onClose} expectedCents={expectedCents} onSubmit={onSubmit} />
    </FormDialog>
  );
}

function CloseForm({ onClose, expectedCents, onSubmit }: { onClose: () => void; expectedCents: number; onSubmit: (countedCents: number, notes: string | null) => Promise<void> }) {
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counted = text.trim() ? parseMoneyToCents(text) : null;
  const diff = counted === null ? null : counted - expectedCents;
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (counted === null) return setError("Informe o valor contado, por exemplo 350,00.");
    setPending(true);
    setError(null);
    try {
      await onSubmit(counted, notes.trim() || null);
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <p className="rounded-control bg-surface-2 px-3 py-2 text-sm text-fg">
        Esperado na gaveta: <span className="font-semibold tabular-nums">{formatMoney(expectedCents)}</span>
      </p>
      <TextField label="Dinheiro contado (R$)" inputMode="decimal" autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} error={text.trim() && counted === null ? "Informe um valor, por exemplo 350,00." : undefined} disabled={pending} autoFocus />
      <div aria-live="polite" className="min-h-6 text-sm font-medium">
        {diff === null ? null : diff === 0 ? (
          <span className="text-accent-soft-fg">Confere: sem diferença.</span>
        ) : diff > 0 ? (
          <span className="text-warning-soft-fg">Sobra {formatMoney(diff)}.</span>
        ) : (
          <span className="text-danger">Falta {formatMoney(-diff)}.</span>
        )}
      </div>
      <TextField label="Observação (opcional)" maxLength={300} autoComplete="off" value={notes} onChange={(event) => setNotes(event.target.value)} disabled={pending} />
      <FormError message={error} />
      <FormActions pending={pending} submitLabel="Fechar turno" onCancel={onClose} />
    </form>
  );
}

/** Só motivo/observação: estorno, recusar retirada. */
export function ReasonDialog({ open, onClose, title, description, label, required, submitLabel, onSubmit }: CommonProps & { title: string; description?: string; label: string; required: boolean; submitLabel: string; onSubmit: (text: string) => Promise<void> }) {
  return (
    <FormDialog open={open} title={title} description={description} onClose={onClose}>
      <ReasonForm onClose={onClose} label={label} required={required} submitLabel={submitLabel} onSubmit={onSubmit} />
    </FormDialog>
  );
}

function ReasonForm({ onClose, label, required, submitLabel, onSubmit }: { onClose: () => void; label: string; required: boolean; submitLabel: string; onSubmit: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (required && text.trim().length < 3) return setError("Escreva pelo menos 3 letras.");
    setPending(true);
    setError(null);
    try {
      await onSubmit(text.trim());
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      <TextField label={label} maxLength={300} autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} disabled={pending} autoFocus />
      <FormError message={error} />
      <FormActions pending={pending} submitLabel={submitLabel} onCancel={onClose} />
    </form>
  );
}
