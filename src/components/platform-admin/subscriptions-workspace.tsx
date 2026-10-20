"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CreditCard } from "lucide-react";
import { SelectField, TextAreaField } from "@/components/menu-admin/fields";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { TextField } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { loadSubscriptionsAction, setSubscriptionAction } from "@/modules/platform-admin/actions";
import { SUBSCRIPTION_STATUSES, fieldErrorsOf, subscriptionFormSchema } from "@/modules/platform-admin/schemas";
import { formatDate } from "@/modules/team/audit";
import type { Cursor, PlanRow, SubscriptionRow } from "@/modules/platform-admin/types";
import { LoadMore, ReadOnlyNotice, SUBSCRIPTION_LABELS, SubscriptionBadge, usePagedList } from "./common";

type Props = {
  initialRows: SubscriptionRow[];
  initialCursor: Cursor | null;
  initialStatus: string;
  loadError: string | null;
  plans: PlanRow[];
  canWrite: boolean;
};

type Draft = {
  restaurant: string;
  restaurantName: string;
  plan: string;
  status: string;
  periodEnd: string;
  note: string;
};

function ymdOf(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // Fuso do painel (America/Sao_Paulo, UTC-3 fixo).
  return new Date(date.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
}

export function SubscriptionsWorkspace({ initialRows, initialCursor, initialStatus, loadError, plans, canWrite }: Props) {
  const router = useRouter();
  const list = usePagedList<SubscriptionRow>(initialRows, initialCursor, loadError);
  const [status, setStatus] = useState(initialStatus);
  const [draft, setDraft] = useState<Draft | null>(null);

  const loader = (value: string) => (cursor: Cursor | null) => loadSubscriptionsAction(value, cursor);

  function changeFilter(value: string) {
    setStatus(value);
    void list.reload(loader(value));
  }

  function edit(row: SubscriptionRow) {
    setDraft({
      restaurant: row.restaurantId,
      restaurantName: row.restaurantName,
      plan: row.planId ?? plans.find((plan) => plan.isActive)?.id ?? "",
      status: row.status ?? "active",
      periodEnd: ymdOf(row.periodEnd),
      note: "",
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert tone="warning" title="Cobrança manual">
        Cobrança manual - sem provedor de pagamento. As assinaturas são registros administrados pelo superadmin; nenhuma
        cobrança é feita automaticamente.
      </Alert>
      {!canWrite ? <ReadOnlyNotice /> : null}

      <div className="max-w-xs">
        <SelectField label="Estado da assinatura" value={status} onChange={(event) => changeFilter(event.target.value)} disabled={list.loading !== null}>
          <option value="">Todos</option>
          {SUBSCRIPTION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {SUBSCRIPTION_LABELS[value]}
            </option>
          ))}
        </SelectField>
      </div>

      {list.error ? <Alert tone="danger">{list.error}</Alert> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4" aria-live="polite" aria-busy={list.loading !== null}>
          {list.rows.length === 0 && !list.error ? (
            <EmptyState icon={<CreditCard />} title="Nenhuma assinatura neste filtro" description="Tente outro estado ou limpe o filtro." />
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
              {list.rows.map((row) => (
                <li key={row.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{row.restaurantName}</p>
                    <p className="text-xs text-muted">
                      {row.planName ?? "Sem plano"}
                      {row.periodEnd ? ` - até ${formatDate(row.periodEnd)}` : ""}
                      {!row.periodEnd && row.status === "trial" && row.trialEndsAt ? ` - teste até ${formatDate(row.trialEndsAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <SubscriptionBadge status={row.status} />
                    {canWrite ? (
                      <Button size="sm" variant="secondary" onClick={() => edit(row)} aria-label={`Alterar a assinatura de ${row.restaurantName}`}>
                        Alterar
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <LoadMore
            hasMore={list.cursor !== null}
            loading={list.loading === "more"}
            empty={list.rows.length === 0}
            onClick={() => void list.more(loader(status))}
          />
        </div>

        {canWrite && draft ? (
          <SubscriptionForm
            key={draft.restaurant}
            initial={draft}
            plans={plans}
            onCancel={() => setDraft(null)}
            onDone={() => {
              setDraft(null);
              void list.reload(loader(status));
              router.refresh();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function SubscriptionForm({
  initial,
  plans,
  onCancel,
  onDone,
}: {
  initial: Draft;
  plans: PlanRow[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [values, setValues] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = subscriptionFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError("Revise os campos destacados.");
      return;
    }
    setErrors({});
    setFormError(null);
    setConfirming(true);
  }

  function confirm() {
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof setSubscriptionAction>>;
      try {
        result = await setSubscriptionAction(values as Parameters<typeof setSubscriptionAction>[0]);
      } catch {
        result = { ok: false, message: "Não foi possível salvar agora. Tente novamente em instantes." };
      }
      setConfirming(false);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.message);
        return;
      }
      toast({ title: result.message ?? "Assinatura atualizada", tone: "success" });
      onDone();
    });
  }

  const planName = plans.find((plan) => plan.id === values.plan)?.name ?? "plano";
  const statusLabel = SUBSCRIPTION_LABELS[values.status as keyof typeof SUBSCRIPTION_LABELS] ?? values.status;

  return (
    <Card as="section" aria-labelledby="assinatura-form" className="self-start">
      <CardHeader title={<span id="assinatura-form">Alterar assinatura</span>} description={initial.restaurantName} />
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <SelectField label="Plano" required value={values.plan} error={errors.plan} onChange={(e) => set("plan", e.target.value)}>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id} disabled={!plan.isActive && plan.id !== initial.plan}>
              {plan.name}
              {plan.isActive ? "" : " (inativo)"}
            </option>
          ))}
        </SelectField>
        <SelectField label="Estado" required value={values.status} error={errors.status} onChange={(e) => set("status", e.target.value)}>
          {SUBSCRIPTION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {SUBSCRIPTION_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Fim do período"
          type="date"
          value={values.periodEnd}
          error={errors.periodEnd}
          hint="Opcional. Deixe vazio para não definir."
          onChange={(e) => set("periodEnd", e.target.value)}
        />
        <TextAreaField
          label="Nota interna"
          hint="Ex.: pagamento recebido por Pix em 12/10."
          rows={3}
          maxLength={500}
          value={values.note}
          error={errors.note}
          onChange={(e) => set("note", e.target.value)}
        />
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit">Revisar alteração</Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title="Confirmar alteração da assinatura?"
        description={`${initial.restaurantName} ficará no plano ${planName} com estado "${statusLabel}". A ação é registrada na auditoria.`}
        confirmLabel="Alterar assinatura"
        pending={pending}
        onConfirm={confirm}
        onClose={() => setConfirming(false)}
      />
    </Card>
  );
}
