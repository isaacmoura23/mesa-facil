import type { Tab } from "./types";

/** "Mesa 5", rótulo do balcão ou "Balcão". */
export function tabTitle(tab: Pick<Tab, "table_id" | "label">, tableName: string | null): string {
  if (tableName) return /mesa/i.test(tableName) ? tableName : `Mesa ${tableName}`;
  if (tab.table_id) return "Mesa removida";
  return tab.label?.trim() ? `Balcão: ${tab.label.trim()}` : "Balcão";
}

/** Rótulo extra (nome do cliente) quando a comanda é de mesa. */
export function tabSubtitle(tab: Pick<Tab, "table_id" | "label" | "guests">): string {
  const parts: string[] = [];
  if (tab.table_id && tab.label?.trim()) parts.push(tab.label.trim());
  if (tab.guests) parts.push(`${tab.guests} ${tab.guests === 1 ? "pessoa" : "pessoas"}`);
  return parts.join(", ");
}

/** "12 min", "1 h 05 min" (tempo aberto, sem o "há"). */
export function formatOpenFor(iso: string, now: number): string {
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return "";
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = String(minutes % 60).padStart(2, "0");
  return `${hours} h ${rest} min`;
}

export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
