/**
 * Entrada de valores em reais ("12", "12,5", "1.234,50") convertida para centavos
 * sem passar por ponto flutuante. Devolve null quando o texto não é um valor válido.
 */
export function parseMoneyToCents(input: string): number | null {
  const text = input.trim().replace(/^R\$\s*/i, "");
  if (!text) return null;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const reais = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return reais * 100 + fraction;
}

/** Centavos -> texto editável ("12,50"), sem símbolo de moeda. */
export function centsToInput(cents: number): string {
  const safe = Math.max(0, Math.trunc(cents));
  const reais = Math.floor(safe / 100);
  const rest = String(safe % 100).padStart(2, "0");
  return `${reais},${rest}`;
}
