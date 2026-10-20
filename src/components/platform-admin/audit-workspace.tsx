"use client";

import { useState, type FormEvent } from "react";
import { Download, History } from "lucide-react";
import { SelectField } from "@/components/menu-admin/fields";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { TextField } from "@/components/ui/input";
import { exportAuditCsvAction, loadAuditAction } from "@/modules/platform-admin/actions";
import { AUDIT_PREFIXES, describePlatformAudit, safeMetadataEntries } from "@/modules/platform-admin/audit-text";
import { auditFiltersSchema, fieldErrorsOf } from "@/modules/platform-admin/schemas";
import { formatDateTime } from "@/modules/team/audit";
import type { AuditEntry, AuditFilters, Cursor, RestaurantOption } from "@/modules/platform-admin/types";
import { LoadMore, usePagedList } from "./common";
import type { Initial } from "./support-workspace";

const NO_FILTERS: AuditFilters = { actor: "", prefix: "", restaurant: "", from: "", to: "" };

export function AuditWorkspace({ initial, restaurants }: { initial: Initial<AuditEntry>; restaurants: RestaurantOption[] }) {
  const list = usePagedList<AuditEntry>(initial.rows, initial.cursor, initial.error);
  const [draft, setDraft] = useState<AuditFilters>(NO_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(NO_FILTERS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const loader = (filters: AuditFilters) => (cursor: Cursor | null) => loadAuditAction(filters, cursor);

  function validate(filters: AuditFilters): boolean {
    const parsed = auditFiltersSchema.safeParse(filters);
    const next = parsed.success ? {} : fieldErrorsOf(parsed.error);
    if (parsed.success && filters.from && filters.to && filters.from > filters.to) {
      next.to = "A data inicial deve ser anterior ou igual à final.";
    }
    if (next.actor) next.actor = "Informe o identificador (UUID) do ator.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!validate(draft)) return;
    setApplied(draft);
    void list.reload(loader(draft));
  }

  function clear() {
    setDraft(NO_FILTERS);
    setApplied(NO_FILTERS);
    setErrors({});
    void list.reload(loader(NO_FILTERS));
  }

  async function exportCsv() {
    if (!validate(applied)) return;
    setExporting(true);
    setExportMessage(null);
    try {
      const result = await exportAuditCsvAction(applied);
      if (!result.ok) {
        setExportMessage({ tone: "danger", text: result.message });
        return;
      }
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `auditoria-plataforma-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExportMessage({
        tone: "success",
        text: `${result.count} ${result.count === 1 ? "linha exportada" : "linhas exportadas"}${result.truncated ? " (limitado a 5000)" : ""}.`,
      });
    } catch {
      setExportMessage({ tone: "danger", text: "Não foi possível exportar agora. Tente novamente em instantes." });
    } finally {
      setExporting(false);
    }
  }

  const filtered = Object.values(applied).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit} noValidate className="grid gap-3 rounded-card border border-line bg-surface p-4 sm:grid-cols-2 xl:grid-cols-3">
        <SelectField label="Tipo de ação" value={draft.prefix} onChange={(e) => setDraft((c) => ({ ...c, prefix: e.target.value }))}>
          {AUDIT_PREFIXES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </SelectField>
        {restaurants.length > 0 ? (
          <SelectField label="Restaurante" value={draft.restaurant} onChange={(e) => setDraft((c) => ({ ...c, restaurant: e.target.value }))}>
            <option value="">Todos</option>
            {restaurants.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </SelectField>
        ) : (
          <TextField
            label="Restaurante (UUID)"
            value={draft.restaurant}
            error={errors.restaurant}
            onChange={(e) => setDraft((c) => ({ ...c, restaurant: e.target.value.trim() }))}
          />
        )}
        <TextField
          label="Ator (UUID)"
          hint="Opcional. Identificador do usuário que fez a ação."
          value={draft.actor}
          error={errors.actor}
          autoComplete="off"
          onChange={(e) => setDraft((c) => ({ ...c, actor: e.target.value.trim() }))}
        />
        <TextField label="De" type="date" value={draft.from} error={errors.from} onChange={(e) => setDraft((c) => ({ ...c, from: e.target.value }))} />
        <TextField label="Até" type="date" value={draft.to} error={errors.to} onChange={(e) => setDraft((c) => ({ ...c, to: e.target.value }))} />
        <div className="flex flex-wrap items-end gap-2">
          <Button type="submit" loading={list.loading === "reload"}>
            Filtrar
          </Button>
          <Button variant="secondary" onClick={clear} disabled={list.loading !== null}>
            Limpar
          </Button>
          <Button variant="secondary" onClick={() => void exportCsv()} loading={exporting}>
            <Download aria-hidden="true" className="size-4" />
            Exportar CSV
          </Button>
        </div>
      </form>

      {exportMessage ? <Alert tone={exportMessage.tone}>{exportMessage.text}</Alert> : null}
      {list.error ? <Alert tone="danger">{list.error}</Alert> : null}

      <div aria-live="polite" aria-busy={list.loading !== null} className="flex flex-col gap-4">
        {list.rows.length === 0 && !list.error ? (
          <EmptyState
            icon={<History />}
            title={filtered ? "Nenhum registro neste filtro" : "Nenhum registro de auditoria ainda"}
            description={filtered ? "Amplie o período ou escolha outro tipo de ação." : "As ações da plataforma e dos restaurantes aparecem aqui."}
          />
        ) : (
          <ol className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {list.rows.map((row) => (
              <AuditItem key={row.id} row={row} />
            ))}
          </ol>
        )}
        <LoadMore hasMore={list.cursor !== null} loading={list.loading === "more"} empty={list.rows.length === 0} onClick={() => void list.more(loader(applied))} />
      </div>
    </div>
  );
}

function AuditItem({ row }: { row: AuditEntry }) {
  const { text, known } = describePlatformAudit(row.action, row.metadata);
  const entries = safeMetadataEntries(row.metadata);
  const actor = row.actorName?.trim() || (row.actorId ? "Usuário" : "Sistema");
  return (
    <li className="px-4 py-3">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4">
        <time dateTime={row.createdAt} className="w-32 shrink-0 text-xs tabular-nums text-muted">
          {formatDateTime(row.createdAt)}
        </time>
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm text-fg">
            <span className="font-medium">{actor}</span> - {text}
            {row.restaurantName ? <span className="text-muted"> ({row.restaurantName})</span> : null}
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
