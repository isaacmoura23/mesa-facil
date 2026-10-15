"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { HistoryDetail } from "./history-detail";
import { HistoryFiltersForm } from "./history-filters";
import {
  buildCsv,
  DEFAULT_HISTORY_FILTERS,
  EXPORT_MAX_ROWS,
  fetchAllForExport,
  filtersKey,
  type HistoryFilters,
} from "./history-model";
import { HistoryResults } from "./history-results";

type HistoryViewProps = {
  /** Resolvido no servidor pelo guard (nunca do slug do navegador). */
  restaurantId: string;
  restaurantName: string;
  restaurantSlug: string;
};

function downloadCsv(content: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function HistoryView({ restaurantId, restaurantName, restaurantSlug }: HistoryViewProps) {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);

  async function exportCsv() {
    setExporting(true);
    setExportNote(null);
    try {
      const { rows, truncated } = await fetchAllForExport(supabase, restaurantId, filters);
      if (rows.length === 0) {
        setExportNote({ tone: "warning", text: "Não há pedidos neste filtro para exportar." });
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      downloadCsv(buildCsv(rows), `pedidos-${restaurantSlug}-${stamp}.csv`);
      setExportNote(
        truncated
          ? { tone: "warning", text: `Exportados os ${EXPORT_MAX_ROWS} pedidos mais recentes do filtro. Restrinja o período para ver o restante.` }
          : { tone: "success", text: `${rows.length} pedidos exportados.` },
      );
    } catch {
      setExportNote({ tone: "danger", text: "Não foi possível exportar. Tente novamente." });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Histórico"
        description={`${restaurantName}. Consulta somente leitura de pedidos de todos os estados.`}
        actions={
          <Button variant="secondary" size="md" loading={exporting} onClick={() => void exportCsv()}>
            <Download aria-hidden="true" className="size-4" />
            Exportar CSV
          </Button>
        }
      />

      <HistoryFiltersForm applied={filters} onApply={setFilters} key={`form-${filtersKey(filters)}`} />

      <div role="status" aria-live="polite">
        {exportNote ? (
          <Alert tone={exportNote.tone} title="Exportação">
            {exportNote.text} O arquivo traz só número, data, modalidade, estado, total e forma de pagamento.
          </Alert>
        ) : null}
      </div>

      <HistoryResults
        key={`results-${filtersKey(filters)}`}
        restaurantId={restaurantId}
        filters={filters}
        onOpen={(row) => setSelectedId(row.id)}
      />

      <HistoryDetail restaurantId={restaurantId} orderId={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}
