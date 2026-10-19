"use client";

import { useRef, useState, type FormEvent } from "react";
import { History } from "lucide-react";
import { SelectField } from "@/components/menu-admin/fields";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { TextField } from "@/components/ui/input";
import { loadAuditLogsAction } from "@/modules/team/actions";
import { AUDIT_CATEGORIES, describeAudit, formatDateTime, safeMetadataEntries } from "@/modules/team/audit";
import type { AuditCursor, AuditFilters, AuditPage, AuditRow } from "@/modules/team/types";

type ActivityPanelProps = {
  slug: string;
  initial: { ok: true; page: AuditPage } | { ok: false; message: string };
};

const NO_FILTERS: AuditFilters = { category: "", from: "", to: "" };

export function ActivityPanel({ slug, initial }: ActivityPanelProps) {
  const [draft, setDraft] = useState<AuditFilters>(NO_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(NO_FILTERS);
  const [rows, setRows] = useState<AuditRow[]>(initial.ok ? initial.page.rows : []);
  const [cursor, setCursor] = useState<AuditCursor | null>(initial.ok ? initial.page.next_cursor : null);
  const [error, setError] = useState<string | null>(initial.ok ? null : initial.message);
  const [loading, setLoading] = useState<"filter" | "more" | null>(null);
  const [rangeError, setRangeError] = useState<string | undefined>();
  const requestId = useRef(0);

  async function load(filters: AuditFilters, before: AuditCursor | null) {
    const id = ++requestId.current;
    setLoading(before ? "more" : "filter");
    setError(null);
    let result: Awaited<ReturnType<typeof loadAuditLogsAction>>;
    try {
      result = await loadAuditLogsAction(slug, filters, before);
    } catch {
      result = { ok: false, message: "Não foi possível carregar o histórico agora. Tente novamente em instantes." };
    }
    if (id !== requestId.current) return;
    setLoading(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRows((current) => (before ? [...current, ...result.page.rows] : result.page.rows));
    setCursor(result.page.next_cursor);
    setApplied(filters);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) {
      setRangeError("A data inicial deve ser anterior ou igual à final.");
      return;
    }
    setRangeError(undefined);
    void load(draft, null);
  }

  function clear() {
    setDraft(NO_FILTERS);
    setRangeError(undefined);
    void load(NO_FILTERS, null);
  }

  const filtered = applied.category !== "" || applied.from !== "" || applied.to !== "";

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={submit}
        noValidate
        className="grid grid-cols-2 gap-3 rounded-card border border-line bg-surface p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end"
      >
        <div className="col-span-2 lg:col-span-1">
          <SelectField
            label="Tipo de atividade"
            value={draft.category}
            onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
          >
            {AUDIT_CATEGORIES.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </SelectField>
        </div>
        <TextField
          label="De"
          type="date"
          value={draft.from}
          onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
        />
        <TextField
          label="Até"
          type="date"
          value={draft.to}
          error={rangeError}
          onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
        />
        <div className="col-span-2 flex gap-2 lg:col-span-1">
          <Button type="submit" loading={loading === "filter"}>
            Filtrar
          </Button>
          <Button variant="secondary" onClick={clear} disabled={loading !== null}>
            Limpar
          </Button>
        </div>
      </form>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div aria-live="polite" aria-busy={loading !== null}>
        {rows.length === 0 && !error ? (
          <EmptyState
            icon={<History />}
            title={filtered ? "Nenhuma atividade neste filtro" : "Nenhuma atividade registrada ainda"}
            description={
              filtered
                ? "Tente ampliar o período ou escolher outro tipo."
                : "Convites, mudanças de função, pagamentos e outras ações da equipe aparecem aqui."
            }
          />
        ) : (
          <ol className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {rows.map((row) => (
              <ActivityItem key={row.id} row={row} />
            ))}
          </ol>
        )}
      </div>

      {cursor ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => void load(applied, cursor)} loading={loading === "more"}>
            Carregar mais
          </Button>
        </div>
      ) : rows.length > 0 ? (
        <p className="text-center text-sm text-muted">Fim do histórico.</p>
      ) : null}
    </div>
  );
}

function ActivityItem({ row }: { row: AuditRow }) {
  const { text, known } = describeAudit(row.action, row.metadata);
  const entries = safeMetadataEntries(row.metadata);
  const actor = row.actor_name?.trim() || (row.actor_id ? "Usuário" : "Sistema");
  return (
    <li className="px-4 py-3">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4">
        <time dateTime={row.created_at} className="w-32 shrink-0 text-xs tabular-nums text-muted">
          {formatDateTime(row.created_at)}
        </time>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-fg">
            <span className="font-medium">{actor}</span> - {text}
          </p>
          {!known ? (
            <p className="mt-0.5 text-xs text-muted">
              Código: <code className="break-all font-mono">{row.action}</code>
            </p>
          ) : null}
          {entries.length > 0 ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs font-medium text-muted hover:text-fg">Detalhes</summary>
              <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                {entries.map((entry) => (
                  <div key={entry.key} className="contents">
                    <dt className="text-muted">{entry.key}</dt>
                    <dd className="break-words text-fg">{entry.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </div>
      </div>
    </li>
  );
}
