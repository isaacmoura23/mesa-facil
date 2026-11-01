import { centsToCsv, csvText } from "@/modules/reports/csv";
import { formatDateTime } from "@/modules/operations/format";
import { KIND_LABELS, type MovementRow } from "./types";

/** CSV do histórico do caixa: separador ";", BOM UTF-8, vírgula decimal (Excel pt-BR), sem fórmulas injetadas. */
export function buildCashCsv(rows: readonly MovementRow[]): string {
  const num = (value: number | null) => (value === null ? '""' : `"${centsToCsv(value)}"`);
  const header = ["Data e hora", "Tipo", "Sentido", "Valor", "Recebido", "Troco", "Motivo", "Pedido ou comanda", "Quem lançou", "Estornado"]
    .map(csvText)
    .join(";");
  const lines = rows.map((row) => {
    const ref = row.order_number !== null ? `Pedido ${row.order_number}` : (row.tab_label ?? "");
    return [
      csvText(formatDateTime(row.created_at)),
      csvText(KIND_LABELS[row.kind]),
      csvText(row.direction === "IN" ? "Entrada" : "Saída"),
      num(row.amount_cents),
      num(row.tendered_cents),
      num(row.change_cents),
      csvText(row.reason ?? ""),
      csvText(ref),
      csvText(row.actor_name),
      csvText(row.reversed ? "Sim" : ""),
    ].join(";");
  });
  return `﻿${[header, ...lines].join("\r\n")}\r\n`;
}
