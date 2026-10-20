"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { Switch, TextAreaField } from "@/components/menu-admin/fields";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TextField } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { formatCents } from "@/lib/format";
import { savePlanAction } from "@/modules/platform-admin/actions";
import {
  LIMIT_KEYS,
  featuresToLines,
  planFormSchema,
  fieldErrorsOf,
} from "@/modules/platform-admin/schemas";
import type { PlanRow } from "@/modules/platform-admin/types";
import { ReadOnlyNotice } from "./common";

type Props = {
  plans: PlanRow[];
  canWrite: boolean;
  loadError: string | null;
};

type FormState = {
  id: string;
  code: string;
  name: string;
  price: string;
  max_members: string;
  max_tables: string;
  max_products: string;
  features: string;
  isActive: boolean;
};

const EMPTY: FormState = {
  id: "",
  code: "",
  name: "",
  price: "",
  max_members: "",
  max_tables: "",
  max_products: "",
  features: "",
  isActive: true,
};

function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
}

function toForm(plan: PlanRow): FormState {
  const limit = (key: string) => (typeof plan.limits[key] === "number" ? String(plan.limits[key]) : "");
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    price: centsToInput(plan.priceCents),
    max_members: limit("max_members"),
    max_tables: limit("max_tables"),
    max_products: limit("max_products"),
    features: featuresToLines(plan.features),
    isActive: plan.isActive,
  };
}

function limitText(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "ilimitado";
}

export function PlansWorkspace({ plans, canWrite, loadError }: Props) {
  const [form, setForm] = useState<FormState | null>(null);

  return (
    <div className="flex flex-col gap-6">
      {!canWrite ? <ReadOnlyNotice /> : null}
      {loadError ? <Alert tone="danger">{loadError}</Alert> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section aria-labelledby="planos-lista" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 id="planos-lista" className="text-base font-semibold text-fg">
              Planos cadastrados
            </h2>
            {canWrite ? (
              <Button size="sm" onClick={() => setForm({ ...EMPTY })}>
                <Plus aria-hidden="true" className="size-4" />
                Novo plano
              </Button>
            ) : null}
          </div>

          {plans.length === 0 && !loadError ? (
            <EmptyState title="Nenhum plano cadastrado" description="Crie o primeiro plano para poder atribuí-lo às assinaturas." />
          ) : (
            <ul className="flex flex-col gap-3">
              {plans.map((plan) => {
                const inUse = plan.subscriptionsTotal;
                const features = Object.entries(plan.features).filter(([, v]) => v !== false);
                return (
                  <li key={plan.id} className="rounded-card border border-line bg-surface p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-fg">{plan.name}</h3>
                          <Badge tone={plan.isActive ? "accent" : "neutral"}>{plan.isActive ? "Ativo" : "Inativo"}</Badge>
                        </div>
                        <p className="mt-0.5 text-sm text-muted">
                          <code className="font-mono">{plan.code}</code>
                          {" - "}
                          {inUse === 0 ? "sem assinaturas" : `${inUse} ${inUse === 1 ? "assinatura" : "assinaturas"}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <p className="text-lg font-semibold tabular-nums text-fg">
                          {formatCents(plan.priceCents)}
                          <span className="text-sm font-normal text-muted">/mês</span>
                        </p>
                        {canWrite ? (
                          <Button size="sm" variant="secondary" onClick={() => setForm(toForm(plan))} aria-label={`Editar o plano ${plan.name}`}>
                            <Pencil aria-hidden="true" className="size-4" />
                            Editar
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
                      {LIMIT_KEYS.map((limit) => (
                        <div key={limit.key}>
                          <dt className="text-xs text-muted">{limit.label}</dt>
                          <dd className="font-medium tabular-nums text-fg">{limitText(plan.limits[limit.key])}</dd>
                        </div>
                      ))}
                    </dl>
                    {features.length > 0 ? (
                      <p className="mt-3 text-xs leading-relaxed text-muted">
                        Recursos: {features.map(([key, value]) => (value === true ? key : `${key}=${String(value)}`)).join(", ")}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {canWrite ? (
          form ? (
            <PlanForm
              key={form.id || "novo"}
              initial={form}
              inUse={plans.find((plan) => plan.id === form.id)?.subscriptionsTotal ?? 0}
              onDone={() => setForm(null)}
              onCancel={() => setForm(null)}
            />
          ) : (
            <Card className="self-start">
              <p className="text-sm text-muted">
                Escolha um plano para editar ou crie um novo. Planos em uso por assinaturas não podem ser apagados: apenas
                inativados.
              </p>
            </Card>
          )
        ) : null}
      </div>
    </div>
  );
}

function PlanForm({
  initial,
  inUse,
  onDone,
  onCancel,
}: {
  initial: FormState;
  inUse: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const editing = initial.id !== "";

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = planFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError("Revise os campos destacados.");
      return;
    }
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof savePlanAction>>;
      try {
        result = await savePlanAction(values);
      } catch {
        result = { ok: false, message: "Não foi possível salvar agora. Tente novamente em instantes." };
      }
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.message);
        return;
      }
      toast({ title: result.message ?? "Plano salvo", tone: "success" });
      router.refresh();
      onDone();
    });
  }

  return (
    <Card as="section" aria-labelledby="plano-form" className="self-start">
      <CardHeader
        title={<span id="plano-form">{editing ? "Editar plano" : "Novo plano"}</span>}
        description={editing && inUse > 0 ? `Em uso por ${inUse} ${inUse === 1 ? "assinatura" : "assinaturas"}. Para retirar de circulação, inative.` : undefined}
      />
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Código"
            hint="Identificador único, ex.: basico"
            required
            value={values.code}
            error={errors.code}
            maxLength={40}
            autoComplete="off"
            onChange={(e) => set("code", e.target.value)}
          />
          <TextField label="Nome" required value={values.name} error={errors.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
        </div>
        <TextField
          label="Preço mensal (R$)"
          required
          inputMode="decimal"
          value={values.price}
          error={errors.price}
          hint="Ex.: 99,90"
          onChange={(e) => set("price", e.target.value)}
        />
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium text-fg">Limites</legend>
          <p className="-mt-1 text-sm text-muted">Deixe vazio para ilimitado.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {LIMIT_KEYS.map((limit) => (
              <TextField
                key={limit.key}
                label={limit.label}
                inputMode="numeric"
                value={values[limit.key]}
                error={errors[limit.key]}
                onChange={(e) => set(limit.key, e.target.value)}
              />
            ))}
          </div>
        </fieldset>
        <TextAreaField
          label="Recursos"
          hint="Um por linha: 'chave' (ativo) ou 'chave=valor'. Ex.: reports_basic"
          rows={5}
          value={values.features}
          error={errors.features}
          onChange={(e) => set("features", e.target.value)}
        />
        <Switch
          checked={values.isActive}
          onChange={(checked) => set("isActive", checked)}
          label="Plano ativo"
          description="Planos inativos não aparecem para novas assinaturas."
        />
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" loading={pending}>
            {editing ? "Salvar alterações" : "Criar plano"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

