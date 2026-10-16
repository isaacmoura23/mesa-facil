"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";
import type { RestaurantTable } from "@/modules/tables/types";
import { ModalDialog } from "./modal-dialog";

export type OpenTabTarget = { kind: "table"; table: RestaurantTable } | { kind: "counter" };

type OpenTabDialogProps = {
  target: OpenTabTarget | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { tableId: string | null; label: string | null; guests: number | null }) => void;
};

export function OpenTabDialog({ target, busy, onClose, onSubmit }: OpenTabDialogProps) {
  const title =
    target?.kind === "table" ? `Abrir comanda: ${target.table.name}` : "Abrir comanda de balcão";
  return (
    <ModalDialog
      open={target !== null}
      title={title}
      description={
        target?.kind === "table"
          ? "O número de pessoas é opcional."
          : "Comanda sem mesa. Identifique o cliente para achar depois."
      }
      onClose={onClose}
      locked={busy}
    >
      {target ? (
        <OpenTabForm
          key={target.kind === "table" ? target.table.id : "counter"}
          target={target}
          busy={busy}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      ) : null}
    </ModalDialog>
  );
}

function OpenTabForm({
  target,
  busy,
  onClose,
  onSubmit,
}: {
  target: OpenTabTarget;
  busy: boolean;
  onClose: () => void;
  onSubmit: OpenTabDialogProps["onSubmit"];
}) {
  const uid = useId();
  const [guests, setGuests] = useState("");
  const [label, setLabel] = useState("");
  const [touched, setTouched] = useState(false);

  const isCounter = target.kind === "counter";
  const guestsNumber = guests.trim() === "" ? null : Number(guests);
  const guestsInvalid =
    guestsNumber !== null && (!Number.isInteger(guestsNumber) || guestsNumber < 1 || guestsNumber > 99);
  const labelMissing = isCounter && label.trim().length === 0;
  const capacity = target.kind === "table" ? target.table.capacity : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (busy || guestsInvalid || labelMissing) return;
    onSubmit({
      tableId: target.kind === "table" ? target.table.id : null,
      label: label.trim() ? label.trim().slice(0, 80) : null,
      guests: guestsNumber,
    });
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 overflow-y-auto px-5 py-5">
      {isCounter ? (
        <TextField
          id={`${uid}-label`}
          label="Identificação"
          hint="Ex.: nome do cliente ou número da senha."
          value={label}
          maxLength={80}
          autoComplete="off"
          autoFocus
          required
          onChange={(event) => setLabel(event.target.value)}
          error={touched && labelMissing ? "Informe uma identificação." : undefined}
        />
      ) : (
        <TextField
          id={`${uid}-label`}
          label="Nome do cliente (opcional)"
          value={label}
          maxLength={80}
          autoComplete="off"
          onChange={(event) => setLabel(event.target.value)}
        />
      )}
      <TextField
        id={`${uid}-guests`}
        label="Número de pessoas (opcional)"
        hint={capacity ? `A mesa comporta ${capacity} lugares.` : undefined}
        type="number"
        inputMode="numeric"
        min={1}
        max={99}
        value={guests}
        autoFocus={!isCounter}
        onChange={(event) => setGuests(event.target.value)}
        error={touched && guestsInvalid ? "Informe um número de 1 a 99." : undefined}
      />
      <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button type="submit" size="lg" loading={busy}>
          Abrir comanda
        </Button>
      </div>
    </form>
  );
}
