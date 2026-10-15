import { describe, expect, it } from "vitest";
import { formatCents, formatLowestPrice, isOpenNow, lowestPrice } from "../../sdk/src/index";
import type { Variant } from "../../sdk/src/index";

// Intl usa NBSP entre "R$" e o valor.
const norm = (s: string) => s.replace(/ /g, " ");

const v = (priceCents: number, isAvailable = true): Variant => ({
  id: String(priceCents),
  name: "v",
  priceCents,
  isAvailable,
  isDefault: false,
});

describe("formatCents", () => {
  it("formata em BRL pt-BR", () => {
    expect(norm(formatCents(1250))).toBe("R$ 12,50");
    expect(norm(formatCents(0))).toBe("R$ 0,00");
    expect(norm(formatCents(123456))).toBe("R$ 1.234,56");
  });
  it("aceita locale/moeda", () => {
    expect(norm(formatCents(1250, { locale: "en-US", currency: "USD" }))).toBe("$12.50");
  });
});

describe("lowestPrice", () => {
  it("sem variantes usa priceCents e não é 'a partir de'", () => {
    expect(lowestPrice({ priceCents: 1000, variants: [] })).toEqual({ cents: 1000, isFrom: false });
  });
  it("com variantes de preços diferentes: menor disponível e isFrom", () => {
    expect(lowestPrice({ priceCents: 1800, variants: [v(2800), v(1800), v(900, false)] })).toEqual({
      cents: 1800,
      isFrom: true,
    });
  });
  it("variantes com o mesmo preço: sem 'a partir de'", () => {
    expect(lowestPrice({ priceCents: 1500, variants: [v(1500), v(1500)] })).toEqual({ cents: 1500, isFrom: false });
  });
  it("nenhuma variante disponível: considera todas", () => {
    expect(lowestPrice({ priceCents: 0, variants: [v(2000, false), v(1500, false)] })).toEqual({
      cents: 1500,
      isFrom: true,
    });
  });
  it("formatLowestPrice monta o texto", () => {
    expect(norm(formatLowestPrice({ priceCents: 1800, variants: [v(1800), v(2800)] }))).toBe("a partir de R$ 18,00");
    expect(norm(formatLowestPrice({ priceCents: 1800, variants: [] }))).toBe("R$ 18,00");
  });
});

describe("isOpenNow", () => {
  it("usa o campo do servidor", () => {
    expect(isOpenNow({ isOpenNow: true })).toBe(true);
    expect(isOpenNow({ isOpenNow: false })).toBe(false);
  });
});
