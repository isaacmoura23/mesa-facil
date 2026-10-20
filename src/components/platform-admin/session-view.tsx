"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, TimerReset } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCents } from "@/lib/format";
import { ROLE_LABELS, STATUS_LABELS } from "@/lib/auth/permissions";
import { closeSessionAction } from "@/modules/platform-admin/actions";
import type { SupportOverview } from "@/modules/platform-admin/overview";
import { FULFILLMENT_LABELS, PAYMENT_STATUS_LABELS } from "@/modules/operations/types";
import { ORDER_STATUS_LABELS } from "@/modules/reports/format";
import { formatDateTime } from "@/modules/team/audit";
import { formatRemaining, useNow } from "./support-workspace";

function label(map: Record<string, string>, key: string): string {
  return Object.hasOwn(map, key) ? map[key] : "Outro";
}

export function SessionView({ overview }: { overview: SupportOverview }) {
  const router = useRouter();
  const now = useNow(1000);
  const expiresMs = overview.expiresAt ? new Date(overview.expiresAt).getTime() : 0;
  const remaining = now === null ? null : expiresMs - now;
  const expired = remaining !== null && remaining <= 0;
  const [closing, setClosing] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Ao expirar, sai da visão: o banco já nega novas leituras.
  useEffect(() => {
    if (!expired) return;
    const timer = window.setTimeout(() => router.replace("/platform/support?aba=sessoes"), 4000);
    return () => window.clearTimeout(timer);
  }, [expired, router]);

  function close() {
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof closeSessionAction>>;
      try {
        result = await closeSessionAction(overview.sessionId);
      } catch {
        result = { ok: false, message: "Não foi possível encerrar agora. Tente novamente em instantes." };
      }
      setClosing(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setEnded(true);
      router.replace("/platform/support?aba=sessoes");
    });
  }

  const finished = expired || ended;
  const urgent = !finished && remaining !== null && remaining < 5 * 60_000;

  return (
    <div className="flex flex-col gap-6">
      <div
        className={
          "sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:mx-0 sm:rounded-card sm:border " +
          (finished ? "border-line bg-surface-2" : urgent ? "border-transparent bg-warning-soft text-warning-soft-fg" : "border-transparent bg-info-soft text-info-soft-fg")
        }
        role="status"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Eye aria-hidden="true" className="size-5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {finished ? "Sessão de suporte encerrada" : "Sessão de suporte ativa (somente leitura)"}
            </p>
            <p className="text-xs">Acesso auditado e visível ao restaurante.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {finished ? (
            <span className="text-sm font-medium">Redirecionando...</span>
          ) : (
            <>
              <span className="flex items-center gap-1.5 text-lg font-semibold tabular-nums" aria-label={remaining === null ? "Tempo restante" : `Tempo restante ${formatRemaining(remaining)}`}>
                <TimerReset aria-hidden="true" className="size-4" />
                {remaining === null ? "--:--" : formatRemaining(remaining)}
              </span>
              <Button size="sm" variant="danger" onClick={() => setClosing(true)}>
                Encerrar sessão
              </Button>
            </>
          )}
        </div>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {finished ? (
        <Alert tone="warning" title="A sessão terminou">
          A expiração revoga o acesso imediatamente. <Link href="/platform/support?aba=sessoes" className="font-medium underline">Voltar às sessões</Link>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold text-fg">{overview.restaurant.name}</h2>
        {overview.restaurant.status ? (
          <Badge tone={overview.restaurant.status === "active" ? "accent" : "warning"}>
            {Object.hasOwn(STATUS_LABELS, overview.restaurant.status)
              ? STATUS_LABELS[overview.restaurant.status as keyof typeof STATUS_LABELS]
              : "Outro estado"}
          </Badge>
        ) : null}
      </div>
      <p className="-mt-4 text-sm text-muted">
        Motivo da sessão: {overview.reason}
        {overview.startedAt ? ` - iniciada em ${formatDateTime(overview.startedAt)}` : ""}
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card as="section" aria-labelledby="sv-menu">
          <CardHeader title={<span id="sv-menu">Cardápio (contagens)</span>} />
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {overview.menu.map((item) => (
              <div key={item.label}>
                <dt className="text-xs text-muted">{item.label}</dt>
                <dd className="text-xl font-semibold tabular-nums text-fg">{item.value}</dd>
              </div>
            ))}
          </dl>
          {overview.settings.length > 0 ? (
            <dl className="mt-5 flex flex-col gap-2 border-t border-line pt-4 text-sm">
              {overview.settings.map((item) => (
                <div key={item.label} className="flex justify-between gap-3">
                  <dt className="text-muted">{item.label}</dt>
                  <dd className="text-right font-medium text-fg">{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </Card>

        <Card as="section" aria-labelledby="sv-team">
          <CardHeader title={<span id="sv-team">Equipe</span>} description="Papel e estado; sem contatos." />
          {overview.team.length === 0 ? (
            <p className="text-sm text-muted">Nenhum integrante.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {overview.team.map((member, index) => (
                <li key={index} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate font-medium text-fg">{member.name ?? "Convite pendente"}</span>
                  <span className="shrink-0 text-muted">
                    {Object.hasOwn(ROLE_LABELS, member.role) ? ROLE_LABELS[member.role as keyof typeof ROLE_LABELS] : "Função"}
                    {member.status === "active" ? "" : " (inativo)"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card as="section" aria-labelledby="sv-orders">
        <CardHeader title={<span id="sv-orders">Pedidos recentes</span>} description="Até 50 pedidos, sem nome, telefone ou endereço do cliente." />
        {overview.orders.length === 0 ? (
          <EmptyState title="Nenhum pedido ainda" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <caption className="sr-only">Pedidos recentes do restaurante</caption>
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Pedido</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Estado</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Modalidade</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Pagamento</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Total</th>
                  <th scope="col" className="py-2 font-medium">Data</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {overview.orders.map((order) => (
                  <tr key={order.number}>
                    <td className="py-2 pr-3 font-medium tabular-nums text-fg">#{order.number}</td>
                    <td className="py-2 pr-3">{label(ORDER_STATUS_LABELS, order.status)}</td>
                    <td className="py-2 pr-3">{label(FULFILLMENT_LABELS, order.fulfillment)}</td>
                    <td className="py-2 pr-3">{label(PAYMENT_STATUS_LABELS, order.payment)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatCents(order.totalCents)}</td>
                    <td className="py-2 text-muted">{formatDateTime(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card as="section" aria-labelledby="sv-tabs">
        <CardHeader title={<span id="sv-tabs">Comandas abertas</span>} />
        {overview.tabs.length === 0 ? (
          <p className="text-sm text-muted">Nenhuma comanda aberta.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {overview.tabs.map((tab, index) => (
              <li key={index} className="flex items-center justify-between gap-3 py-2">
                <span className="font-medium text-fg">{tab.label}</span>
                <span className="tabular-nums text-muted">
                  {formatCents(tab.totalCents)}
                  {tab.openedAt ? ` - desde ${formatDateTime(tab.openedAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div>
        <Link href="/platform/support?aba=sessoes" className={buttonStyles({ variant: "secondary" })}>
          Voltar às sessões
        </Link>
      </div>

      <ConfirmDialog
        open={closing}
        title="Encerrar sessão de suporte?"
        description="O acesso ao restaurante será revogado imediatamente e o encerramento fica registrado."
        confirmLabel="Encerrar sessão"
        tone="danger"
        pending={pending}
        onConfirm={close}
        onClose={() => setClosing(false)}
      />
    </div>
  );
}
