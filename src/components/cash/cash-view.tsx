"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Calculator, Download, Minus, Plus } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { FormDialog } from "@/components/menu-admin/form-dialog";
import { Segmented } from "@/components/printing/segmented";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { buildCashCsv } from "@/modules/cash/csv";
import { expectedInDrawer } from "@/modules/cash/money";
import * as cash from "@/modules/cash/rpc";
import {
  KIND_LABELS,
  MOVEMENT_KINDS,
  type CashSummary,
  type MovementKind,
  type MovementRow,
  type RequestRow,
  type SessionRow,
} from "@/modules/cash/types";
import { formatDateTime, formatMoney, startOfTodayIso } from "@/modules/operations/format";
import { ChangeCalculator } from "./change-calculator";
import { CloseSessionDialog, MoneyReasonDialog, OpenSessionDialog, ReasonDialog } from "./cash-dialogs";

type Props = {
  /** Resolvido no servidor pelo guard; nunca derivado do slug no cliente. */
  restaurantId: string;
  restaurantName: string;
  userId: string;
  /** cash.operate: abrir/fechar turno, entradas, saídas e pedir retirada. */
  canOperate: boolean;
  /** cash.approve: aprovar retiradas, retirar direto e estornar. */
  canApprove: boolean;
};

type Period = "today" | "7d" | "30d";
const PERIODS: readonly { value: Period; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
];

const KIND_TONE: Record<MovementKind, BadgeTone> = {
  SUPPLY: "accent",
  SALE: "accent",
  EXPENSE: "warning",
  WITHDRAWAL: "warning",
  REVERSAL: "neutral",
};

function rangeFor(period: Period): { from: string; to: string } {
  const days = period === "today" ? 0 : period === "7d" ? 6 : 29;
  const start = new Date(startOfTodayIso());
  start.setUTCDate(start.getUTCDate() - days);
  return { from: start.toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
}

const REVERSIBLE: readonly MovementKind[] = ["SUPPLY", "EXPENSE", "WITHDRAWAL"];
const SAFETY_REFRESH_MS = 60_000;

export function CashView({ restaurantId, restaurantName, userId, canOperate, canApprove }: Props) {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const { toast } = useToast();
  const [period, setPeriod] = useState<Period>("today");
  const [kindFilter, setKindFilter] = useState<MovementKind | "ALL">("ALL");
  const [summary, setSummary] = useState<CashSummary | null>(null);
  const [movements, setMovements] = useState<MovementRow[] | null>(null);
  const [pending, setPending] = useState<RequestRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    "open" | "close" | "supply" | "expense" | "request" | "direct" | "calc" | { reverse: MovementRow } | { reject: RequestRow } | null
  >(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const periodRef = useRef(period);
  const kindRef = useRef(kindFilter);
  useEffect(() => {
    periodRef.current = period;
    kindRef.current = kindFilter;
  });

  const reload = useCallback(async () => {
    const { from, to } = rangeFor(periodRef.current);
    const kind = kindRef.current === "ALL" ? null : kindRef.current;
    try {
      const [s, m, r, ss] = await Promise.all([
        cash.loadSummary(supabase, restaurantId, from, to),
        cash.loadMovements(supabase, restaurantId, from, to, kind),
        cash.loadRequests(supabase, restaurantId, "PENDING"),
        cash.loadSessions(supabase, restaurantId),
      ]);
      setSummary(s);
      setMovements(m);
      setPending(r);
      setSessions(ss);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o caixa.");
    }
  }, [supabase, restaurantId]);

  // Carga inicial e nova leitura ao trocar período/filtro.
  useEffect(() => {
    void Promise.resolve().then(reload);
  }, [reload, period, kindFilter]);

  // Tempo real (a RLS de SELECT vale), ao voltar para a aba e a cada 60 s.
  useEffect(() => {
    const schedule = () => {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void reload(), 400);
    };
    const channel = supabase.channel(`cash:${restaurantId}`);
    let cancelled = false;
    void (async () => {
      try {
        await supabase.auth.getSession();
        await supabase.realtime.setAuth();
      } catch {
        // Sem tempo real, a releitura periódica continua valendo.
      }
      if (cancelled) return;
      for (const table of ["cash_movements", "cash_withdrawal_requests", "cash_sessions"]) {
        channel.on("postgres_changes", { event: "*", schema: "public", table, filter: `restaurant_id=eq.${restaurantId}` }, schedule);
      }
      channel.subscribe();
    })();
    const interval = setInterval(() => void reload(), SAFETY_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(reloadTimer.current);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      void supabase.removeChannel(channel);
    };
  }, [supabase, restaurantId, reload]);

  /** Executa uma ação, mostra o resultado e relê. Erros de regra viram aviso na tela. */
  const act = useCallback(
    async (fn: () => Promise<unknown>, success: string) => {
      try {
        await fn();
        toast({ title: success, tone: "success", duration: 3500 });
        await reload();
      } catch (cause) {
        toast({ title: cause instanceof Error ? cause.message : "Não foi possível concluir.", tone: "danger" });
        await reload();
      }
    },
    [reload, toast],
  );

  const open = summary?.open_session ?? null;
  const sale = summary?.by_kind.SALE;
  const close = () => setDialog(null);
  const csvHref = useMemo(() => {
    if (!movements || movements.length === 0) return null;
    return URL.createObjectURL(new Blob([buildCashCsv(movements)], { type: "text/csv;charset=utf-8" }));
  }, [movements]);
  useEffect(() => () => { if (csvHref) URL.revokeObjectURL(csvHref); }, [csvHref]);

  return (
    <div className="flex flex-col gap-6">
      {error ? <Alert tone="danger" title="Não foi possível atualizar o caixa">{error}</Alert> : null}

      {/* Turno e ações */}
      <Card aria-labelledby="turno-titulo">
        <CardHeader
          title={<span id="turno-titulo">{open ? "Turno aberto" : "Sem turno aberto"}</span>}
          description={
            open
              ? `Desde ${formatDateTime(open.opened_at)} · abertura ${formatMoney(open.opening_cents)}`
              : "O turno é opcional: pagamentos em dinheiro entram no caixa mesmo sem turno aberto."
          }
        />
        {open ? (
          <p className="mb-4 text-3xl font-semibold tabular-nums text-fg" data-testid="expected-now">
            {formatMoney(open.expected_cents)}
            <span className="ml-2 text-sm font-normal text-muted">esperado na gaveta agora</span>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Ações do caixa">
          {canOperate && !open ? <Button onClick={() => setDialog("open")}>Abrir turno</Button> : null}
          {canOperate ? (
            <>
              <Button variant="secondary" onClick={() => setDialog("supply")}><Plus aria-hidden="true" className="size-4" />Entrada</Button>
              <Button variant="secondary" onClick={() => setDialog("expense")}><Minus aria-hidden="true" className="size-4" />Saída</Button>
            </>
          ) : null}
          {canApprove ? <Button variant="secondary" onClick={() => setDialog("direct")}>Retirar dinheiro</Button> : canOperate ? <Button variant="secondary" onClick={() => setDialog("request")}>Pedir retirada</Button> : null}
          <Button variant="ghost" onClick={() => setDialog("calc")}><Calculator aria-hidden="true" className="size-4" />Calculadora de troco</Button>
          {canOperate && open ? <Button variant="secondary" onClick={() => setDialog("close")}>Fechar turno</Button> : null}
        </div>
        {!canOperate ? <p className="mt-3 text-sm text-muted">Você vê o caixa em modo leitura.</p> : null}
      </Card>

      {/* Retiradas aguardando */}
      {pending.length > 0 ? (
        <Card aria-labelledby="pendentes-titulo">
          <CardHeader
            title={<span id="pendentes-titulo">Retiradas aguardando o gerente</span>}
            description={canApprove ? "Aprove ou recuse. Quem pediu não pode aprovar o próprio pedido." : "O gerente precisa aprovar para o dinheiro sair."}
          />
          <ul className="flex flex-col divide-y divide-line">
            {pending.map((request) => {
              const mine = request.requested_by === userId;
              return (
                <li key={request.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold tabular-nums text-fg">{formatMoney(request.amount_cents)}</p>
                    <p className="text-sm text-fg">{request.reason}</p>
                    <p className="text-xs text-muted">Pedido por {request.requested_by_name} em {formatDateTime(request.requested_at)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canApprove ? (
                      <>
                        <Button size="sm" disabled={mine} onClick={() => void act(() => cash.decideWithdrawal(supabase, request.id, "APPROVE", null), "Retirada aprovada")}>Aprovar</Button>
                        <Button size="sm" variant="secondary" onClick={() => setDialog({ reject: request })}>Recusar</Button>
                        {mine ? <span className="self-center text-xs text-muted">Peça a outro gerente.</span> : null}
                      </>
                    ) : null}
                    {mine && canOperate ? (
                      <Button size="sm" variant="ghost" onClick={() => void act(() => cash.decideWithdrawal(supabase, request.id, "CANCEL", null), "Pedido cancelado")}>Cancelar pedido</Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {/* Período e totais */}
      <section aria-labelledby="totais-titulo" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="totais-titulo" className="text-lg font-semibold text-fg">Resumo</h2>
          <Segmented legend="Período" value={period} options={PERIODS} onChange={setPeriod} />
        </div>
        {summary ? (
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Entradas" value={formatMoney(summary.in_cents)} />
            <Stat label="Saídas" value={formatMoney(summary.out_cents)} />
            <Stat label="Saldo do período" value={formatMoney(expectedInDrawer(0, summary.in_cents, summary.out_cents))} />
            <Stat label="Vendas em dinheiro" value={formatMoney(sale?.amount_cents ?? 0)} note={`${summary.sales_count} venda(s)`} />
            <Stat label="Troco dado" value={formatMoney(summary.change_given_cents)} note={summary.tendered_cents > 0 ? `de ${formatMoney(summary.tendered_cents)} recebidos` : undefined} />
          </dl>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
        )}
      </section>

      {/* Histórico */}
      <Card aria-labelledby="historico-titulo">
        <CardHeader
          title={<span id="historico-titulo">Histórico do dinheiro</span>}
          description="Entradas, saídas, retiradas, vendas em dinheiro e estornos. Nada é apagado: erros se corrigem com estorno."
          action={csvHref ? <a href={csvHref} download={`caixa-${restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`} className="inline-flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm font-medium text-fg hover:bg-surface-2"><Download aria-hidden="true" className="size-4" />Baixar CSV</a> : undefined}
        />
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar por tipo">
          {(["ALL", ...MOVEMENT_KINDS] as const).map((k) => (
            <Button key={k} size="sm" variant={kindFilter === k ? "primary" : "secondary"} aria-pressed={kindFilter === k} onClick={() => setKindFilter(k)}>
              {k === "ALL" ? "Tudo" : KIND_LABELS[k]}
            </Button>
          ))}
        </div>
        {!movements ? (
          <Skeleton className="h-32" />
        ) : movements.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Nenhum lançamento neste período.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line" aria-label="Lançamentos">
            {movements.map((m) => (
              <li key={m.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={KIND_TONE[m.kind]}>{KIND_LABELS[m.kind]}</Badge>
                    {m.reversed ? <Badge tone="danger">Estornado</Badge> : null}
                    <span className="text-xs text-muted">{formatDateTime(m.created_at)} · {m.actor_name}</span>
                  </div>
                  <p className="mt-1 text-sm text-fg">
                    {m.kind === "SALE"
                      ? [m.order_number !== null ? `Pedido ${m.order_number}` : m.tab_label ? `Comanda ${m.tab_label}` : "Venda", m.tendered_cents !== null ? `recebido ${formatMoney(m.tendered_cents)}, troco ${formatMoney(m.change_cents ?? 0)}` : null].filter(Boolean).join(" · ")
                      : (m.reason ?? "Sem motivo informado")}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <p className={`text-base font-semibold tabular-nums ${m.direction === "IN" ? "text-accent-soft-fg" : "text-danger"}`}>
                    {m.direction === "IN" ? "+" : "−"}{formatMoney(m.amount_cents)}
                  </p>
                  {canApprove && REVERSIBLE.includes(m.kind) && !m.reversed ? (
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ reverse: m })}>Estornar</Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Turnos */}
      {sessions.length > 0 ? (
        <Card aria-labelledby="turnos-titulo">
          <CardHeader title={<span id="turnos-titulo">Turnos recentes</span>} />
          <ul className="flex flex-col divide-y divide-line">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-fg">{formatDateTime(s.opened_at)} → {s.closed_at ? formatDateTime(s.closed_at) : "em andamento"}</p>
                  <p className="text-xs text-muted">Aberto por {s.opened_by_name}{s.closed_by_name ? ` · fechado por ${s.closed_by_name}` : ""}{s.notes ? ` · ${s.notes}` : ""}</p>
                </div>
                <div className="text-right tabular-nums">
                  <p className="text-fg">Abertura {formatMoney(s.opening_cents)} · esperado {s.expected_cents !== null ? formatMoney(s.expected_cents) : "—"}</p>
                  {s.status === "CLOSED" && s.counted_cents !== null && s.difference_cents !== null ? (
                    <p className={s.difference_cents === 0 ? "text-accent-soft-fg" : s.difference_cents < 0 ? "text-danger" : "text-warning-soft-fg"}>
                      Contado {formatMoney(s.counted_cents)} · {s.difference_cents === 0 ? "confere" : s.difference_cents < 0 ? `falta ${formatMoney(-s.difference_cents)}` : `sobra ${formatMoney(s.difference_cents)}`}
                    </p>
                  ) : <Badge tone="info">Aberto</Badge>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Diálogos */}
      <OpenSessionDialog open={dialog === "open"} onClose={close} onSubmit={(v) => cash.openSession(supabase, restaurantId, v).then(() => reload())} />
      <CloseSessionDialog open={dialog === "close"} onClose={close} expectedCents={open?.expected_cents ?? 0} onSubmit={(counted, notes) => cash.closeSession(supabase, open?.id ?? "", counted, notes).then(() => reload())} />
      <MoneyReasonDialog open={dialog === "supply"} onClose={close} title="Entrada de dinheiro" description="Dinheiro que entrou no caixa fora das vendas (ex.: troco que o dono trouxe)." submitLabel="Registrar entrada" reasonLabel="Observação (opcional)" reasonRequired={false} onSubmit={(v, reason, key) => cash.recordMovement(supabase, restaurantId, "SUPPLY", v, reason || null, key).then(() => reload())} />
      <MoneyReasonDialog open={dialog === "expense"} onClose={close} title="Saída de dinheiro" description="Pagamento feito com dinheiro do caixa (ex.: compra de gelo, fornecedor)." submitLabel="Registrar saída" reasonLabel="Motivo" reasonHint="Obrigatório. Ex.: compra de gelo." reasonRequired onSubmit={(v, reason, key) => cash.recordMovement(supabase, restaurantId, "EXPENSE", v, reason, key).then(() => reload())} />
      <MoneyReasonDialog open={dialog === "request"} onClose={close} title="Pedir retirada" description="O gerente precisa aprovar para o dinheiro sair do caixa." submitLabel="Enviar pedido" reasonLabel="Motivo" reasonHint="Ex.: guardar no cofre." reasonRequired onSubmit={(v, reason, key) => cash.requestWithdrawal(supabase, restaurantId, v, reason, key).then(() => reload())} />
      <MoneyReasonDialog open={dialog === "direct"} onClose={close} title="Retirar dinheiro" description="Retirada feita por você, como gerente. Fica registrada com o seu nome." submitLabel="Registrar retirada" reasonLabel="Motivo" reasonHint="Ex.: depósito no banco." reasonRequired onSubmit={(v, reason, key) => cash.withdrawDirect(supabase, restaurantId, v, reason, key).then(() => reload())} />
      <ReasonDialog open={typeof dialog === "object" && dialog !== null && "reverse" in dialog} onClose={close} title="Estornar lançamento" description={typeof dialog === "object" && dialog !== null && "reverse" in dialog ? `${KIND_LABELS[dialog.reverse.kind]} de ${formatMoney(dialog.reverse.amount_cents)}. O lançamento original fica no histórico e entra um lançamento contrário.` : undefined} label="Motivo do estorno" required submitLabel="Estornar" onSubmit={(reason) => (typeof dialog === "object" && dialog !== null && "reverse" in dialog ? cash.reverseMovement(supabase, dialog.reverse.id, reason).then(() => reload()) : Promise.resolve())} />
      <ReasonDialog open={typeof dialog === "object" && dialog !== null && "reject" in dialog} onClose={close} title="Recusar retirada" label="Observação (opcional)" required={false} submitLabel="Recusar" onSubmit={(note) => (typeof dialog === "object" && dialog !== null && "reject" in dialog ? cash.decideWithdrawal(supabase, dialog.reject.id, "REJECT", note || null).then(() => reload()) : Promise.resolve())} />
      <FormDialog open={dialog === "calc"} title="Calculadora de troco" description="Só calcula; não registra nada no caixa." onClose={close}>
        <ChangeCalculator onClose={close} />
      </FormDialog>
      <p className="sr-only" aria-live="polite">{pending.length > 0 ? `${pending.length} retirada(s) aguardando o gerente` : ""}</p>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-card">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-fg">{value}</dd>
      {note ? <dd className="text-xs text-muted">{note}</dd> : null}
    </div>
  );
}
