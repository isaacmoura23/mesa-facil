"use client";

import { useState, type FormEvent } from "react";
import { FormError } from "@/components/menu-admin/form-dialog";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { TextField } from "@/components/ui/input";
import { saveRulesAction } from "@/modules/restaurant-settings/actions";
import {
  PICKUP_INSTRUCTIONS_MAX,
  fieldErrorsOf,
  rulesSchema,
} from "@/modules/restaurant-settings/schemas";
import {
  FULFILLMENT_LABELS,
  FULFILLMENT_TYPES,
  type FulfillmentType,
  type SettingsRow,
} from "@/modules/restaurant-settings/types";
import { CheckField, SaveBar, Switch, TextAreaField } from "./fields";

type RulesFormProps = {
  slug: string;
  settings: SettingsRow;
};

type FormValues = {
  types: FulfillmentType[];
  prep: string;
  minOrder: string;
  pickup: string;
  singleTab: boolean;
};

function toValues(settings: SettingsRow): FormValues {
  return {
    types: FULFILLMENT_TYPES.filter((type) => settings.enabled_fulfillment_types.includes(type)),
    prep: String(settings.prep_time_minutes),
    minOrder: (settings.min_order_cents / 100).toFixed(2).replace(".", ","),
    pickup: settings.pickup_instructions ?? "",
    singleTab: settings.single_tab_per_table,
  };
}

function sameValues(a: FormValues, b: FormValues): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Seção "Modalidades e regras": tipos de atendimento, preparo, pedido mínimo, retirada e comanda. */
export function RulesForm({ slug, settings }: RulesFormProps) {
  const { run, pending } = useMenuAction();
  const [saved, setSaved] = useState(() => toValues(settings));
  const [values, setValues] = useState(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const dirty = !sameValues(values, saved);

  function patch(next: Partial<FormValues>) {
    setValues((current) => ({ ...current, ...next }));
  }

  function toggleType(type: FulfillmentType, checked: boolean) {
    const next = checked ? [...values.types, type] : values.types.filter((item) => item !== type);
    patch({ types: FULFILLMENT_TYPES.filter((item) => next.includes(item)) });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = {
      fulfillmentTypes: values.types,
      prepMinutes: values.prep,
      minOrder: values.minOrder,
      pickupInstructions: values.pickup,
      singleTabPerTable: values.singleTab,
    };
    const parsed = rulesSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError(null);
      return;
    }
    setErrors({});
    setFormError(null);
    const result = await run(() => saveRulesAction(slug, input), { inlineError: true });
    if (result.ok) {
      const normalized: FormValues = {
        ...values,
        minOrder: (parsed.data.minOrder / 100).toFixed(2).replace(".", ","),
        prep: String(parsed.data.prepMinutes),
        pickup: parsed.data.pickupInstructions ?? "",
      };
      setValues(normalized);
      setSaved(normalized);
      return;
    }
    setErrors(result.fieldErrors ?? {});
    setFormError(result.fieldErrors ? null : result.message);
  }

  const delivery = values.types.includes("DELIVERY");
  const pickup = values.types.includes("PICKUP");

  return (
    <Card aria-labelledby="rules-title">
      <CardHeader
        title={<span id="rules-title">Modalidades e regras de atendimento</span>}
        description="Como o cliente pode receber o pedido e quais regras valem para ele."
      />
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium text-fg">Modalidades habilitadas</legend>
          {FULFILLMENT_TYPES.map((type) => (
            <CheckField
              key={type}
              label={FULFILLMENT_LABELS[type].label}
              hint={FULFILLMENT_LABELS[type].hint}
              checked={values.types.includes(type)}
              onChange={(checked) => toggleType(type, checked)}
            />
          ))}
          {errors.fulfillmentTypes ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {errors.fulfillmentTypes}
            </p>
          ) : null}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Tempo estimado de preparo (minutos)"
            inputMode="numeric"
            autoComplete="off"
            hint="Mostrado ao cliente antes de pedir."
            value={values.prep}
            onChange={(event) => patch({ prep: event.target.value.replace(/\D/g, "").slice(0, 3) })}
            error={errors.prepMinutes}
          />
          <TextField
            label="Pedido mínimo (R$)"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0,00"
            hint="Zero significa sem mínimo."
            value={values.minOrder}
            onChange={(event) => patch({ minOrder: event.target.value })}
            error={errors.minOrder}
          />
        </div>

        <TextAreaField
          label="Instruções de retirada"
          rows={3}
          maxLength={PICKUP_INSTRUCTIONS_MAX}
          placeholder="Ex.: Retire no balcão e informe o número do pedido."
          hint={
            pickup
              ? `${values.pickup.length} de ${PICKUP_INSTRUCTIONS_MAX} caracteres.`
              : `Só aparece se a retirada estiver habilitada. ${values.pickup.length} de ${PICKUP_INSTRUCTIONS_MAX} caracteres.`
          }
          value={values.pickup}
          onChange={(event) => patch({ pickup: event.target.value })}
          error={errors.pickupInstructions}
        />

        <Switch
          checked={values.singleTab}
          onChange={(checked) => patch({ singleTab: checked })}
          label="Uma comanda por mesa"
          description="Cada mesa só pode ter uma comanda aberta por vez. A regra vale para as novas comandas; as comandas já abertas continuam como foram abertas."
        />

        {delivery ? (
          <Alert tone="info">
            Com entrega habilitada, cadastre ao menos uma região ativa em &ldquo;Regiões de entrega&rdquo;. Sem
            elas, o cliente não consegue pedir para entregar.
          </Alert>
        ) : null}
        <FormError message={formError} />
        <SaveBar dirty={dirty} pending={pending} label="Salvar regras" onDiscard={() => { setValues(saved); setErrors({}); setFormError(null); }} />
      </form>
    </Card>
  );
}
