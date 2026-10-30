/** Notas comuns do real (em centavos), usadas nos botões rápidos de "valor recebido". */
export const BANKNOTES_CENTS = [1000, 2000, 5000, 10000, 20000] as const;

/** Troco a devolver (nunca negativo). Null quando falta informação ou o valor recebido não cobre a conta. */
export function changeFor(dueCents: number | null, tenderedCents: number | null): number | null {
  if (dueCents === null || tenderedCents === null) return null;
  if (!Number.isFinite(dueCents) || !Number.isFinite(tenderedCents)) return null;
  if (dueCents < 0 || tenderedCents < dueCents) return null;
  return tenderedCents - dueCents;
}

/** Falta receber (positivo) quando o valor recebido não cobre a conta. */
export function shortfallFor(dueCents: number | null, tenderedCents: number | null): number | null {
  if (dueCents === null || tenderedCents === null) return null;
  return tenderedCents < dueCents ? dueCents - tenderedCents : null;
}

/**
 * Sugestões de "valor recebido" para a conta: o valor exato e as notas que cobrem a conta
 * (a menor nota que cobre e as maiores), sem repetir, até `max` opções, em ordem crescente.
 * Ex.: conta de R$ 37,90 -> exato, R$ 50, R$ 100, R$ 200.
 */
export function tenderSuggestions(dueCents: number, max = 5): number[] {
  if (!Number.isFinite(dueCents) || dueCents <= 0) return [];
  const out = new Set<number>([dueCents]);
  for (const note of BANKNOTES_CENTS) if (note >= dueCents) out.add(note);
  // conta acima da maior nota: sugere o próximo múltiplo de R$ 50 e de R$ 100
  if (dueCents > BANKNOTES_CENTS[BANKNOTES_CENTS.length - 1]) {
    out.add(Math.ceil(dueCents / 5000) * 5000);
    out.add(Math.ceil(dueCents / 10000) * 10000);
  }
  return [...out].sort((a, b) => a - b).slice(0, max);
}

/**
 * Como devolver o troco com as notas e moedas comuns (guloso). Devolve só o que sobra em cada valor.
 * Ex.: R$ 12,10 -> 1x R$ 10, 1x R$ 2, 1x R$ 0,10.
 */
export const DENOMINATIONS_CENTS = [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 25, 10, 5] as const;

export function changeBreakdown(changeCents: number): { value: number; count: number }[] {
  if (!Number.isFinite(changeCents) || changeCents <= 0) return [];
  let rest = Math.floor(changeCents);
  const out: { value: number; count: number }[] = [];
  for (const value of DENOMINATIONS_CENTS) {
    const count = Math.floor(rest / value);
    if (count > 0) {
      out.push({ value, count });
      rest -= count * value;
    }
  }
  return out;
}

/**
 * Dinheiro esperado na gaveta: abertura + entradas - saídas. O troco já está embutido
 * (recebido - troco = valor da venda), por isso não entra na conta.
 */
export function expectedInDrawer(openingCents: number, inCents: number, outCents: number): number {
  return openingCents + inCents - outCents;
}
