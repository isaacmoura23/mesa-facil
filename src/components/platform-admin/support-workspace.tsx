"use client";

import Link from "next/link";
import { useEffect, useId, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { LifeBuoy, ShieldCheck } from "lucide-react";
import { SelectField, TextAreaField } from "@/components/menu-admin/fields";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { closeSessionAction, loadSessionsAction, loadTicketsAction, updateTicketAction } from "@/modules/platform-admin/actions";
import { TICKET_STATUSES, fieldErrorsOf, ticketFormSchema } from "@/modules/platform-admin/schemas";
import { formatDateTime } from "@/modules/team/audit";
import type { Cursor, PageResult, SessionRow, TicketRow } from "@/modules/platform-admin/types";
import { LoadMore, TICKET_LABELS, TicketBadge, usePagedList } from "./common";

export type Initial<T> = { rows: T[]; cursor: Cursor | null; error: string | null };

type Props = {
  tickets: Initial<TicketRow>;
  sessions: Initial<SessionRow>;
  initialTab: "tickets" | "sessoes";
};

const TABS = [
  { key: "tickets", label: "Tickets" },
  { key: "sessoes", label: "Sessões de suporte" },
] as const;

export function SupportWorkspace({ tickets, sessions, initialTab }: Props) {
  const [tab, setTab] = useState<"tickets" | "sessoes">(initialTab);
  const baseId = useId();

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = tab === "tickets" ? "sessoes" : "tickets";
    setTab(next);
    document.getElementById(`${baseId}-${next}`)?.focus();
  }

  return (
    <div className="flex flex-col gap-6">
      <div role="tablist" aria-label="Seções do suporte" className="flex gap-1 border-b border-line">
        {TABS.map((item) => (
          <button
            key={item.key}
            id={`${baseId}-${item.key}`}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            aria-controls={`${baseId}-panel-${item.key}`}
            tabIndex={tab === item.key ? 0 : -1}
            onClick={() => setTab(item.key)}
            onKeyDown={onKeyDown}
            className={
              "-mb-px h-11 border-b-2 px-4 text-sm font-medium transition-colors " +
              (tab === item.key ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")
            }
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-panel-tickets`} aria-labelledby={`${baseId}-tickets`} hidden={tab !== "tickets"}>
        <TicketsPanel initial={tickets} />
      </div>
      <div role="tabpanel" id={`${baseId}-panel-sessoes`} aria-labelledby={`${baseId}-sessoes`} hidden={tab !== "sessoes"}>
        <SessionsPanel initial={sessions} />
      </div>
    </div>
  );
}

/* ----------------------------- Tickets ----------------------------- */

function TicketsPanel({ initial }: { initial: Initial<TicketRow> }) {
  const list = usePagedList<TicketRow>(initial.rows, initial.cursor, initial.error);
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const loader = (value: string) => (cursor: Cursor | null): Promise<PageResult<TicketRow>> => loadTicketsAction(value, cursor);

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-xs">
        <SelectField
          label="Estado do ticket"
          value={status}
          disabled={list.loading !== null}
          onChange={(event) => {
            setStatus(event.target.value);
            setOpenId(null);
            void list.reload(loader(event.target.value));
          }}
        >
          <option value="">Todos</option>
          {TICKET_STATUSES.map((value) => (
            <option key={value} value={value}>
              {TICKET_LABELS[value]}
            </option>
          ))}
        </SelectField>
      </div>
      {list.error ? <Alert tone="danger">{list.error}</Alert> : null}
      <div aria-live="polite" aria-busy={list.loading !== null} className="flex flex-col gap-4">
        {list.rows.length === 0 && !list.error ? (
          <EmptyState icon={<LifeBuoy />} title="Nenhum ticket neste filtro" description="Os tickets abertos pelos restaurantes aparecem aqui." />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {list.rows.map((ticket) => (
              <li key={ticket.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium text-fg">{ticket.subject}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {ticket.restaurantName ?? "Sem restaurante"}
                      {ticket.createdAt ? ` - aberto em ${formatDateTime(ticket.createdAt)}` : ""}
                    </p>
                    {ticket.body ? <p className="mt-2 line-clamp-3 whitespace-pre-line break-words text-sm text-muted">{ticket.body}</p> : null}
                                      </div>
                  <div className="flex items-center gap-2">
                    <TicketBadge status={ticket.status} />
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-expanded={openId === ticket.id}
                      onClick={() => setOpenId(openId === ticket.id ? null : ticket.id)}
                    >
                      Atualizar
                    </Button>
                  </div>
                </div>
                {openId === ticket.id ? (
                  <TicketForm
                    ticket={ticket}
                    onSaved={(next) => {
                      list.setRows(list.rows.map((item) => (item.id === next.id ? next : item)));
                      setOpenId(null);
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <LoadMore hasMore={list.cursor !== null} loading={list.loading === "more"} empty={list.rows.length === 0} onClick={() => void list.more(loader(status))} />
      </div>
    </div>
  );
}

function TicketForm({ ticket, onSaved }: { ticket: TicketRow; onSaved: (ticket: TicketRow) => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [status, setStatus] = useState<string>(ticket.status);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = { id: ticket.id, status, note };
    const parsed = ticketFormSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof updateTicketAction>>;
      try {
        result = await updateTicketAction(input as Parameters<typeof updateTicketAction>[0]);
      } catch {
        result = { ok: false, message: "Não foi possível salvar agora. Tente novamente em instantes." };
      }
      if (!result.ok) {
        setFormError(result.message);
        return;
      }
      toast({ title: result.message ?? "Ticket atualizado", tone: "success" });
      onSaved({ ...ticket, status: parsed.data.status });
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} noValidate className="mt-3 grid gap-3 rounded-control bg-surface-2 p-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <SelectField label="Novo estado" value={status} error={errors.status} onChange={(e) => setStatus(e.target.value)}>
        {TICKET_STATUSES.map((value) => (
          <option key={value} value={value}>
            {TICKET_LABELS[value]}
          </option>
        ))}
      </SelectField>
      <TextAreaField label="Nota interna" hint="Fica registrada apenas na auditoria da plataforma." rows={2} maxLength={1000} value={note} error={errors.note} onChange={(e) => setNote(e.target.value)} />
      {formError ? (
        <div className="sm:col-span-2">
          <Alert tone="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm:col-span-2 sm:flex sm:justify-end">
        <Button type="submit" loading={pending}>
          Salvar ticket
        </Button>
      </div>
    </form>
  );
}

/* ----------------------------- Sessões ----------------------------- */

/** Relógio do cliente. `null` no servidor e na hidratação (evita divergência de HTML). */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function sessionState(session: SessionRow, now: number | null): "active" | "ended" | "expired" {
  if (session.endedAt) return "ended";
  if (now === null) return session.active ? "active" : "expired";
  const expires = session.expiresAt ? new Date(session.expiresAt).getTime() : 0;
  return expires > now ? "active" : "expired";
}

function SessionsPanel({ initial }: { initial: Initial<SessionRow> }) {
  const router = useRouter();
  const { toast } = useToast();
  const list = usePagedList<SessionRow>(initial.rows, initial.cursor, initial.error);
  const [activeOnly, setActiveOnly] = useState(true);
  const [closing, setClosing] = useState<SessionRow | null>(null);
  const [pending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const now = useNow(1000);
  const loader = (value: boolean) => (cursor: Cursor | null): Promise<PageResult<SessionRow>> => loadSessionsAction(value, cursor);

  function close() {
    if (!closing) return;
    const target = closing;
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof closeSessionAction>>;
      try {
        result = await closeSessionAction(target.id);
      } catch {
        result = { ok: false, message: "Não foi possível encerrar agora. Tente novamente em instantes." };
      }
      setClosing(null);
      if (!result.ok) {
        setActionError(result.message);
        return;
      }
      setActionError(null);
      toast({ title: "Sessão encerrada", tone: "success" });
      void list.reload(loader(activeOnly));
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" title="Acesso auditado e visível ao restaurante">
        Sessões de suporte são somente leitura, duram no máximo 60 minutos e ficam registradas na auditoria do restaurante. Para abrir uma
        sessão, use a página do restaurante em Restaurantes.
      </Alert>
      <div className="flex gap-2" role="group" aria-label="Filtro de sessões">
        <Button
          size="sm"
          variant={activeOnly ? "primary" : "secondary"}
          aria-pressed={activeOnly}
          onClick={() => {
            setActiveOnly(true);
            void list.reload(loader(true));
          }}
        >
          Ativas
        </Button>
        <Button
          size="sm"
          variant={activeOnly ? "secondary" : "primary"}
          aria-pressed={!activeOnly}
          onClick={() => {
            setActiveOnly(false);
            void list.reload(loader(false));
          }}
        >
          Histórico
        </Button>
      </div>
      {list.error ? <Alert tone="danger">{list.error}</Alert> : null}
      {actionError ? <Alert tone="danger">{actionError}</Alert> : null}
      <div aria-live="polite" aria-busy={list.loading !== null} className="flex flex-col gap-4">
        {list.rows.length === 0 && !list.error ? (
          <EmptyState
            icon={<ShieldCheck />}
            title={activeOnly ? "Nenhuma sessão ativa" : "Nenhuma sessão registrada"}
            description="Ao abrir uma sessão, ela aparece aqui com a contagem regressiva."
          />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {list.rows.map((session) => {
              const state = sessionState(session, now);
              const remaining = session.expiresAt && now !== null ? new Date(session.expiresAt).getTime() - now : null;
              return (
                <li key={session.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-fg">{session.restaurantName}</p>
                    <p className="mt-0.5 break-words text-sm text-muted">{session.reason}</p>
                    <p className="mt-1 text-xs text-muted">
                      {session.adminName ?? "Administrador"}
                      {session.startedAt ? ` - iniciada em ${formatDateTime(session.startedAt)}` : ""}
                      {session.expiresAt ? ` - expira em ${formatDateTime(session.expiresAt)}` : ""}
                      {session.endedAt ? ` - encerrada em ${formatDateTime(session.endedAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {state === "active" ? (
                      <>
                        <Badge tone="accent">Ativa{remaining !== null ? ` - ${formatRemaining(remaining)}` : ""}</Badge>
                        <Link href={`/platform/support/${session.id}`} className={buttonStyles({ size: "sm", variant: "secondary" })}>
                          Abrir visão
                        </Link>
                        <Button size="sm" variant="danger" onClick={() => setClosing(session)}>
                          Encerrar sessão
                        </Button>
                      </>
                    ) : (
                      <Badge>{state === "ended" ? "Encerrada" : "Expirada"}</Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <LoadMore hasMore={list.cursor !== null} loading={list.loading === "more"} empty={list.rows.length === 0} onClick={() => void list.more(loader(activeOnly))} />
      </div>
      <ConfirmDialog
        open={closing !== null}
        title="Encerrar sessão de suporte?"
        description={`O acesso ao restaurante ${closing?.restaurantName ?? ""} será revogado imediatamente. O encerramento fica registrado na auditoria.`}
        confirmLabel="Encerrar sessão"
        tone="danger"
        pending={pending}
        onConfirm={close}
        onClose={() => setClosing(null)}
      />
    </div>
  );
}
