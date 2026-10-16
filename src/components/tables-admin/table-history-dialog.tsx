"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FormDialog } from "@/components/menu-admin/form-dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { loadTableHistoryAction } from "@/modules/tables-admin/actions";
import {
  TAB_STATUS_LABELS,
  TAB_STATUS_TONES,
  formatFullDateTime,
  formatMoney,
} from "@/modules/tables-admin/format";
import type { Result, TableHistoryEntry, TableRow } from "@/modules/tables-admin/types";

type Props = {
  slug: string;
  table: TableRow | null;
  onClose: () => void;
};

export function TableHistoryDialog({ slug, table, onClose }: Props) {
  return (
    <FormDialog
      open={table !== null}
      title={table ? `Histórico de ${table.name}` : "Histórico"}
      description="Últimas comandas desta mesa. Consulta somente leitura."
      onClose={onClose}
    >
      {table ? <HistoryBody slug={slug} table={table} onClose={onClose} /> : null}
    </FormDialog>
  );
}

function HistoryBody({ slug, table, onClose }: { slug: string; table: TableRow; onClose: () => void }) {
  const [state, setState] = useState<Result<TableHistoryEntry[]> | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTableHistoryAction(slug, table.id)
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch(() => {
        if (!cancelled) setState({ ok: false, message: "Não foi possível carregar o histórico." });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, table.id]);

  return (
    <div className="flex flex-col gap-4">
      {state === null ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Carregando histórico">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : !state.ok ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : state.data.length === 0 ? (
        <p className="rounded-control border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
          Esta mesa ainda não teve nenhuma comanda.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
          {state.data.map((entry) => (
            <li key={entry.id}>
              <Link
                href={`/app/${slug}/comandas/${entry.id}`}
                className="flex flex-col gap-1 px-4 py-3 text-sm hover:bg-surface-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex flex-col">
                  <span className="font-medium text-fg">
                    Aberta em {formatFullDateTime(entry.openedAt)}
                    {entry.label ? ` (${entry.label})` : ""}
                  </span>
                  <span className="text-muted">
                    {entry.closedAt ? `Encerrada em ${formatFullDateTime(entry.closedAt)}` : "Ainda em andamento"}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <Badge tone={TAB_STATUS_TONES[entry.status]}>{TAB_STATUS_LABELS[entry.status]}</Badge>
                  <span className="min-w-20 text-right font-medium tabular-nums text-fg">
                    {entry.totalCents === null ? "--" : formatMoney(entry.totalCents)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Fechar
        </Button>
      </div>
    </div>
  );
}
