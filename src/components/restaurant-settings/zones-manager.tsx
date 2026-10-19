"use client";

import { useState, type FormEvent } from "react";
import { MapPinPlus, Pencil, Power, Trash2 } from "lucide-react";
import { FormError } from "@/components/menu-admin/form-dialog";
import { IconButton } from "@/components/menu-admin/icon-button";
import { useConfirm } from "@/components/menu-admin/use-confirm";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TextField } from "@/components/ui/input";
import { formatCents } from "@/lib/format";
import { deleteZoneAction, saveZoneAction, setZoneActiveAction } from "@/modules/restaurant-settings/actions";
import {
  MAX_NEIGHBORHOODS,
  fieldErrorsOf,
  parseNeighborhoods,
  zoneSchema,
} from "@/modules/restaurant-settings/schemas";
import type { ZoneRow } from "@/modules/restaurant-settings/types";
import { Switch, TextAreaField } from "./fields";

type ZonesManagerProps = {
  slug: string;
  zones: ZoneRow[];
  deliveryEnabled: boolean;
};

type Editing = ZoneRow | "new" | null;

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function ZoneForm({ slug, zone, onClose }: { slug: string; zone: ZoneRow | null; onClose: () => void }) {
  const { run, pending } = useMenuAction();
  const [name, setName] = useState(zone?.name ?? "");
  const [fee, setFee] = useState(zone ? centsToInput(zone.fee_cents) : "");
  const [minOrder, setMinOrder] = useState(zone ? centsToInput(zone.min_order_cents) : "");
  const [minutes, setMinutes] = useState(zone?.estimated_minutes ? String(zone.estimated_minutes) : "");
  const [neighborhoods, setNeighborhoods] = useState(zone?.neighborhoods.join("\n") ?? "");
  const [isActive, setIsActive] = useState(zone?.is_active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { id: zone?.id, name, fee, minOrder, estimatedMinutes: minutes, neighborhoods, isActive };
    const parsed = zoneSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError(null);
      return;
    }
    setErrors({});
    setFormError(null);
    const result = await run(() => saveZoneAction(slug, input), { inlineError: true });
    if (result.ok) {
      onClose();
      return;
    }
    setErrors(result.fieldErrors ?? {});
    setFormError(result.fieldErrors ? null : result.message);
  }

  const count = parseNeighborhoods(neighborhoods).length;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={zone ? `Editar região ${zone.name}` : "Nova região de entrega"}
      className="flex flex-col gap-4 rounded-control border border-line bg-surface-2/50 p-4"
    >
      <h3 className="text-sm font-semibold text-fg">{zone ? "Editar região" : "Nova região de entrega"}</h3>
      <TextField
        label="Nome da região"
        required
        maxLength={120}
        placeholder="Ex.: Centro, Zona Sul"
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={errors.name}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Taxa de entrega (R$)"
          inputMode="decimal"
          placeholder="0,00"
          value={fee}
          onChange={(event) => setFee(event.target.value)}
          error={errors.fee}
        />
        <TextField
          label="Pedido mínimo (R$)"
          inputMode="decimal"
          placeholder="0,00"
          value={minOrder}
          onChange={(event) => setMinOrder(event.target.value)}
          error={errors.minOrder}
        />
        <TextField
          label="Tempo estimado (min)"
          inputMode="numeric"
          placeholder="45"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value.replace(/\D/g, "").slice(0, 4))}
          error={errors.estimatedMinutes}
        />
      </div>
      <TextAreaField
        label="Bairros atendidos"
        rows={4}
        placeholder={"Um bairro por linha\nCentro\nVila Nova"}
        hint={`${count} de ${MAX_NEIGHBORHOODS} bairros. Separe por linha ou vírgula.`}
        value={neighborhoods}
        onChange={(event) => setNeighborhoods(event.target.value)}
        error={errors.neighborhoods}
      />
      <Switch
        checked={isActive}
        onChange={setIsActive}
        label="Região ativa"
        description="Regiões inativas não aparecem para o cliente."
      />
      <FormError message={formError} />
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" loading={pending}>
          Salvar região
        </Button>
      </div>
    </form>
  );
}

/** Seção "Regiões de entrega": criar, editar, ativar/inativar e excluir zonas. */
export function ZonesManager({ slug, zones, deliveryEnabled }: ZonesManagerProps) {
  const { run, isBusy } = useMenuAction();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<Editing>(null);

  function askDelete(zone: ZoneRow) {
    confirm({
      title: `Excluir a região ${zone.name}?`,
      description:
        "Os pedidos antigos não mudam: eles guardam a taxa como foi cobrada. Se preferir só tirar da vitrine, inative a região.",
      confirmLabel: "Excluir região",
      tone: "danger",
      onConfirm: () => run(() => deleteZoneAction(slug, { id: zone.id })),
    });
  }

  const activeCount = zones.filter((zone) => zone.is_active).length;

  return (
    <Card aria-labelledby="zones-title">
      <CardHeader
        title={<span id="zones-title">Regiões de entrega</span>}
        description="Cada região tem a sua taxa, pedido mínimo e prazo. O cliente escolhe a região ao pedir para entregar."
        action={
          editing === null ? (
            <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
              <MapPinPlus aria-hidden="true" className="size-4" />
              Nova região
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-4">
        {deliveryEnabled && activeCount === 0 ? (
          <p role="status" className="rounded-control bg-warning-soft px-4 py-3 text-sm text-warning-soft-fg">
            A entrega está habilitada, mas não há nenhuma região ativa. O cliente não consegue pedir para entregar.
          </p>
        ) : null}
        {editing !== null ? (
          <ZoneForm
            key={editing === "new" ? "new" : editing.id}
            slug={slug}
            zone={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
          />
        ) : null}

        {zones.length === 0 ? (
          <EmptyState
            title="Nenhuma região cadastrada"
            description="Cadastre as regiões atendidas, com taxa e prazo, para vender com entrega."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {zones.map((zone) => (
              <li key={zone.id} className="flex flex-col gap-2 py-4 first:pt-0 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
                    {zone.name}
                    <Badge tone={zone.is_active ? "accent" : "neutral"}>{zone.is_active ? "Ativa" : "Inativa"}</Badge>
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    Taxa {formatCents(zone.fee_cents)}. Mínimo {formatCents(zone.min_order_cents)}.{" "}
                    {zone.estimated_minutes ? `Cerca de ${zone.estimated_minutes} min.` : "Sem prazo informado."}
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    {zone.neighborhoods.length > 0
                      ? `Bairros: ${zone.neighborhoods.join(", ")}`
                      : "Nenhum bairro informado."}
                  </p>
                </div>
                <div className="flex shrink-0">
                  <IconButton label={`Editar ${zone.name}`} onClick={() => setEditing(zone)}>
                    <Pencil aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={zone.is_active ? `Inativar ${zone.name}` : `Ativar ${zone.name}`}
                    disabled={isBusy(zone.id)}
                    onClick={() =>
                      void run(() => setZoneActiveAction(slug, { id: zone.id, isActive: !zone.is_active }), {
                        key: zone.id,
                      })
                    }
                  >
                    <Power aria-hidden="true" />
                  </IconButton>
                  <IconButton label={`Excluir ${zone.name}`} tone="danger" onClick={() => askDelete(zone)}>
                    <Trash2 aria-hidden="true" />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {dialog}
    </Card>
  );
}
