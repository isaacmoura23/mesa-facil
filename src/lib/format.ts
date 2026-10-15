const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** Formata centavos (inteiro) como moeda BRL. */
export function formatCents(cents: number): string {
  return brl.format(cents / 100);
}

/**
 * Converte texto digitado ("12,50", "R$ 1.234,5", "12.5") em centavos inteiros.
 * Retorna null se vazio, negativo, malformado ou fora da faixa segura.
 */
export function parseToCents(input: string): number | null {
  const text = input.replace(/^\s*R\$\s*/i, "").trim();
  if (!text) return null;
  let integerPart: string;
  let fraction = "";
  let match: RegExpMatchArray | null;
  if ((match = text.match(/^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/))) {
    // Formato BR com milhar: 1.234,56
    integerPart = match[1].replace(/\./g, "");
    fraction = match[2] ?? "";
  } else if ((match = text.match(/^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/))) {
    // Formato US com milhar: 1,234.56
    integerPart = match[1].replace(/,/g, "");
    fraction = match[2] ?? "";
  } else if ((match = text.match(/^(\d+)(?:[.,](\d{1,2}))?$/))) {
    integerPart = match[1];
    fraction = match[2] ?? "";
  } else {
    return null;
  }
  const cents = Number(integerPart) * 100 + Number(fraction.padEnd(2, "0") || "0");
  return Number.isSafeInteger(cents) ? cents : null;
}
