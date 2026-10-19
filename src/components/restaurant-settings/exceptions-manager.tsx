"use client";

import { useState, type FormEvent } from "react";
import { CalendarPlus, Pencil, Trash2 } from "lucide-react";
import { FormError } from "@/components/menu-admin/form-dialog";
import { IconButton } from "@/components/menu-admin/icon-button";
import { useConfirm } from "@/components/menu-admin/use-confirm";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TextField } from "@/components/ui/input";
import { deleteExceptionAction, saveExceptionAction } from "@/modules/restaurant-settings/actions";
import {
  WEEKDAYS,
  describeInterval,
  formatDateBr,
  trimSeconds,
  weekdayOf,
} from "@/modules/restaurant-settings/hours";
import { exceptionSchema, fieldErrorsOf } from "@/modules/restaurant-settings/schemas";
import type { ExceptionRow } from "@/modules/restaurant-settings/types";
import { Switch } from "./fields";

type ExceptionsManagerProps = {
  slug: string;
  exceptions: ExceptionRow[];
  /** Hoje (AAAA-MM-DD) no fuso do restaurante. */
  today: string;
};

type Editing = ExceptionRow | "new" | null;

function summary(row: ExceptionRow): string {
  if (row.is_closed || !row.opens_at || !row.closes_at) return "Fechado o dia todo";
  return `Aberto das ${describeInterval({ opens: trimSeconds(row.opens_at), closes: trimSeconds(row.closes_at) })}`;
}

function ExceptionRowItem({
  row,
  past,
  onEdit,
  onDelete,
}: {
  row: ExceptionRow;
  past: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const weekday = WEEKDAYS[weekdayOf(row.on_date)]?.label ?? "";
  return (
    <li className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
          {formatDateBr(row.on_date)}
          <span className="font-normal text-muted">{weekday}</span>
          <Badge tone={row.is_closed ? "danger" : "info"}>{row.is_closed ? "Fechado" : "Horário especial"}</Badge>
        </p>
        <p className="mt-1 text-sm text-muted">
          {summary(row)}
          {row.description ? `. ${row.description}` : ""}
        </p>
      </div>
      <div className="flex shrink-0">
        {past ? null : (
          <IconButton label={`Editar exceção de ${formatDateBr(row.on_date)}`} onClick={onEdit}>
            <Pencil aria-hidden="true" />
          </IconButton>
        )}
        <IconButton label={`Excluir exceção de ${formatDateBr(row.on_date)}`} tone="danger" onClick={onDelete}>
          <Trash2 aria-hidden="true" />
        </IconButton>
      </div>
    </li>
  );
}

function ExceptionForm({
  slug,
  row,
  today,
  onClose,
}: {
  slug: string;
  row: ExceptionRow | null;
  today: string;
  onClose: () => void;
}) {
  const { run, pending } = useMenuAction();
  const [onDate, setOnDate] = useState(row?.on_date ?? "");
  const [isClosed, setIsClosed] = useState(row?.is_closed ?? true);
  const [opensAt, setOpensAt] = useState(row?.opens_at ? trimSeconds(row.opens_at) : "11:00");
  const [closesAt, setClosesAt] = useState(row?.closes_at ? trimSeconds(row.closes_at) : "16:00");
  const [description, setDescription] = useState(row?.description ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { id: row?.id, onDate, isClosed, opensAt, closesAt, description };
    const parsed = exceptionSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError(null);
      return;
    }
    if (!row && onDate < today) {
      setErrors({ onDate: "Escolha uma data de hoje em diante." });
      return;
    }
    setErrors({});
    setFormError(null);
    const result = await run(() => saveExceptionAction(slug, input), { inlineError: true });
    if (result.ok) {
      onClose();
      return;
    }
    setErrors(result.fieldErrors ?? {});
    setFormError(result.fieldErrors ? null : result.message);
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={row ? "Editar exceção" : "Nova exceção"}
      className="flex flex-col gap-4 rounded-control border border-line bg-surface-2/50 p-4"
    >
      <h3 className="text-sm font-semibold text-fg">{row ? "Editar exceção" : "Nova exceção"}</h3>
      <TextField
        label="Data"
        type="date"
        required
        min={row ? undefined : today}
        disabled={row !== null}
        hint={row ? "Para mudar a data, exclua esta exceção e crie outra." : undefined}
        value={onDate}
        onChange={(event) => setOnDate(event.target.value)}
        error={errors.onDate}
        className="sm:max-w-56"
      />
      <Switch
        checked={isClosed}
        onChange={setIsClosed}
        label="Fechado o dia todo"
        description="Desligue para definir um horário especial que substitui o horário normal desse dia."
      />
      {isClosed ? null : (
        <div className="grid gap-4 sm:grid-cols-2 sm:max-w-md">
          <TextField
            label="Abre"
            type="time"
            required
            value={opensAt}
            onChange={(event) => setOpensAt(event.target.value)}
            error={errors.opensAt}
          />
          <TextField
            label="Fecha"
            type="time"
            required
            hint="Menor que a abertura = fecha no dia seguinte."
            value={closesAt}
            onChange={(event) => setClosesAt(event.target.value)}
            error={errors.closesAt}
          />
        </div>
      )}
      <TextField
        label="Descrição (opcional)"
        maxLength={200}
        placeholder="Ex.: Feriado, Natal, Evento privado"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        error={errors.description}
      />
      <FormError message={formError} />
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" loading={pending}>
          Salvar exceção
        </Button>
      </div>
    </form>
  );
}

/** Seção "Exceções e feriados": datas em que o horário normal é substituído. */
export function ExceptionsManager({ slug, exceptions, today }: ExceptionsManagerProps) {
  const { run } = useMenuAction();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<Editing>(null);

  const upcoming = exceptions.filter((row) => row.on_date >= today);
  const past = exceptions.filter((row) => row.on_date < today).reverse();

  function askDelete(row: ExceptionRow) {
    confirm({
      title: `Excluir a exceção de ${formatDateBr(row.on_date)}?`,
      description: "Nesse dia volta a valer o horário normal da semana.",
      confirmLabel: "Excluir",
      tone: "danger",
      onConfirm: () => run(() => deleteExceptionAction(slug, { id: row.id })),
    });
  }

  return (
    <Card aria-labelledby="exceptions-title">
      <CardHeader
        title={<span id="exceptions-title">Exceções e feriados</span>}
        description="Para uma data específica, feche o dia todo ou defina um horário especial no lugar do horário normal."
        action={
          editing === null ? (
            <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
              <CalendarPlus aria-hidden="true" className="size-4" />
              Nova exceção
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-4">
        {editing !== null ? (
          <ExceptionForm
            key={editing === "new" ? "new" : editing.id}
            slug={slug}
            row={editing === "new" ? null : editing}
            today={today}
            onClose={() => setEditing(null)}
          />
        ) : null}

        {upcoming.length === 0 ? (
          <EmptyState
            title="Nenhuma exceção cadastrada"
            description="Cadastre feriados e dias especiais para que o cliente veja o horário certo."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {upcoming.map((row) => (
              <ExceptionRowItem
                key={row.id}
                row={row}
                past={false}
                onEdit={() => setEditing(row)}
                onDelete={() => askDelete(row)}
              />
            ))}
          </ul>
        )}

        {past.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer rounded-control py-2 font-medium text-muted hover:text-fg">
              Datas passadas ({past.length})
            </summary>
            <ul className="mt-1 flex flex-col divide-y divide-line">
              {past.map((row) => (
                <ExceptionRowItem key={row.id} row={row} past onEdit={() => undefined} onDelete={() => askDelete(row)} />
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      {dialog}
    </Card>
  );
}
