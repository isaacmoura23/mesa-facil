import { describe, expect, it } from "vitest";
import {
  changeBreakdown,
  changeFor,
  expectedInDrawer,
  shortfallFor,
  tenderSuggestions,
} from "../../src/modules/cash/money";

describe("changeFor", () => {
  it("calcula o troco e some quando não cobre ou falta dado", () => {
    expect(changeFor(3790, 5000)).toBe(1210);
    expect(changeFor(3790, 3790)).toBe(0);
    expect(changeFor(3790, 3000)).toBeNull();
    expect(changeFor(null, 5000)).toBeNull();
    expect(changeFor(3790, null)).toBeNull();
    expect(changeFor(Number.NaN, 5000)).toBeNull();
  });
  it("informa quanto falta", () => {
    expect(shortfallFor(3790, 3000)).toBe(790);
    expect(shortfallFor(3790, 3790)).toBeNull();
    expect(shortfallFor(3790, 5000)).toBeNull();
  });
});

describe("tenderSuggestions", () => {
  it("valor exato + notas que cobrem a conta", () => {
    expect(tenderSuggestions(3790)).toEqual([3790, 5000, 10000, 20000]);
    expect(tenderSuggestions(1000)).toEqual([1000, 2000, 5000, 10000, 20000]);
    expect(tenderSuggestions(100)).toEqual([100, 1000, 2000, 5000, 10000]);
  });
  it("conta acima da maior nota sugere múltiplos de 50 e 100", () => {
    expect(tenderSuggestions(23450)).toEqual([23450, 25000, 30000]);
    expect(tenderSuggestions(25000)).toEqual([25000, 30000]);
  });
  it("sem sugestão para valor inválido", () => {
    expect(tenderSuggestions(0)).toEqual([]);
    expect(tenderSuggestions(-5)).toEqual([]);
    expect(tenderSuggestions(Number.NaN)).toEqual([]);
  });
});

describe("changeBreakdown", () => {
  it("quebra o troco em notas e moedas", () => {
    expect(changeBreakdown(1210)).toEqual([
      { value: 1000, count: 1 },
      { value: 200, count: 1 },
      { value: 10, count: 1 },
    ]);
    expect(changeBreakdown(4655)).toEqual([
      { value: 2000, count: 2 },
      { value: 500, count: 1 },
      { value: 100, count: 1 },
      { value: 50, count: 1 },
      { value: 5, count: 1 },
    ]);
  });
  it("some a soma das peças com o troco (até moedas de 5 centavos)", () => {
    for (const c of [5, 10, 35, 99, 100, 1234, 9995, 25005]) {
      const parts = changeBreakdown(c);
      const sum = parts.reduce((n, p) => n + p.value * p.count, 0);
      expect(sum).toBeLessThanOrEqual(c);
      expect(c - sum).toBeLessThan(5);
    }
    expect(changeBreakdown(0)).toEqual([]);
  });
});

describe("expectedInDrawer", () => {
  it("abertura + entradas - saídas", () => {
    expect(expectedInDrawer(5000, 8290, 5800)).toBe(7490);
    expect(expectedInDrawer(0, 0, 0)).toBe(0);
  });
});
