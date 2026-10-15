import { describe, expect, it } from "vitest";
import { formatCents, parseToCents } from "../../src/lib/format";

// Intl usa NBSP entre "R$" e o número; normaliza para comparar.
const brl = (cents: number) => formatCents(cents).replace(/ /g, " ");

describe("parseToCents — entradas válidas", () => {
  const ok: [string, number][] = [
    ["12,50", 1250],
    ["1.234,56", 123456],
    ["1234.5", 123450],
    ["R$ 0,99", 99],
    ["R$ 1.000", 100000],
    ["1.234.567,89", 123456789],
    ["1,234.56", 123456], // formato en-US
    ["0", 0],
    ["0,00", 0],
    ["0,5", 50],
    ["12,5", 1250], // 1 casa decimal
    ["00012,50", 1250],
    ["  25,90  ", 2590],
    ["99999,99", 9999999],
    ["1.234", 123400], // 3 dígitos após o separador = milhar, não decimal
    ["10.000", 1000000],
    ["10.000,5", 1000050],
  ];
  for (const [input, cents] of ok) it(`${JSON.stringify(input)} -> ${cents}`, () => expect(parseToCents(input)).toBe(cents));

  it("sempre devolve inteiro seguro e não negativo", () => {
    for (const [input] of ok) {
      const v = parseToCents(input)!;
      expect(Number.isSafeInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("parseToCents — formas que a versão ESTRITA (F-18) deixou de aceitar", () => {
  // Antes do F-18 o parser removia tudo que não fosse dígito/separador. Agora só aceita número bem formado; estas entradas
  // eram "toleradas" e passaram a null (o painel mostra erro de validação). Ver tests/FINDINGS.md (F-18, nota de UX).
  for (const input of ["1 000,50", "12,", "12.", ",50", ".5"]) {
    it(`${JSON.stringify(input)} -> null (estrito)`, () => expect(parseToCents(input)).toBeNull());
  }
});

describe("parseToCents — entradas inválidas => null", () => {
  for (const input of ["", "   ", "abc", "R$", "R$ ", "٣", "١٢", "💰", "NaN", "Infinity"]) {
    it(`${JSON.stringify(input)} -> null`, () => expect(parseToCents(input)).toBeNull());
  }

  it("valores enormes (fora do inteiro seguro) => null, nunca número impreciso", () => {
    expect(parseToCents("99999999999999999999")).toBeNull();
    expect(parseToCents("9007199254740993")).toBeNull();
    expect(parseToCents("9".repeat(400))).toBeNull();
    expect(parseToCents("9".repeat(400) + ",99")).toBeNull();
  });

  it("último valor seguro", () => {
    expect(parseToCents("90071992547409,91")).toBe(9007199254740991);
    expect(parseToCents("90071992547409,92")).toBeNull();
  });

  it("não lança com lixo (injeção, controle, strings gigantes)", () => {
    for (const s of ["'; drop table products;--", "\u0000", "\n12,50\n", "<script>", "12,50".repeat(10000), "\uD83D"]) {
      expect(() => parseToCents(s)).not.toThrow();
    }
  });
});

describe("parseToCents — contrato documentado: 'null se inválido ou NEGATIVO'", () => {
  // F-18 (corrigido em src/lib/format.ts): antes o sinal era descartado junto com os demais caracteres não numéricos.
  it("[F-18] '-5' deveria ser null", () => {
    expect(parseToCents("-5")).toBeNull();
  });
  it("[F-18] '-5,00' deveria ser null", () => {
    expect(parseToCents("-5,00")).toBeNull();
  });
  it("[F-18] entradas malformadas com mais de um separador decimal ('1.2.3', '12,50,30') deveriam ser null", () => {
    expect(parseToCents("1.2.3")).toBeNull();
    expect(parseToCents("12,50,30")).toBeNull();
  });
  it("[F-18] só separadores (',' / '.' / ',,') não têm número: deveriam ser null", () => {
    for (const s of [",", ".", ",,", ".."]) expect(parseToCents(s), s).toBeNull();
  });
  it("[F-18] notação científica não deveria virar valor ('1e5')", () => {
    expect(parseToCents("1e5")).toBeNull();
  });
});

describe("formatCents", () => {
  it("formata em BRL com milhar e vírgula", () => {
    expect(brl(0)).toBe("R$ 0,00");
    expect(brl(1)).toBe("R$ 0,01");
    expect(brl(99)).toBe("R$ 0,99");
    expect(brl(100)).toBe("R$ 1,00");
    expect(brl(2590)).toBe("R$ 25,90");
    expect(brl(123456)).toBe("R$ 1.234,56");
    expect(brl(9999999)).toBe("R$ 99.999,99");
    expect(brl(100000000)).toBe("R$ 1.000.000,00");
  });

  it("negativo mantém o sinal; valor enorme não perde dígitos", () => {
    expect(brl(-250)).toBe("-R$ 2,50");
    expect(brl(100_000_000_000_000)).toBe("R$ 1.000.000.000.000,00");
  });
});

describe("roundtrip formatCents -> parseToCents", () => {
  it("parse(format(c)) === c para fronteiras e uma varredura", () => {
    const samples = [0, 1, 9, 10, 99, 100, 101, 999, 1000, 1001, 99999, 100000, 123456, 999999, 1000000, 9999999, 100000000, 2147483647];
    for (let c = 0; c < 5000; c += 37) samples.push(c);
    for (let c = 0; c < 3_000_000; c += 99_991) samples.push(c);
    for (const c of samples) expect(parseToCents(formatCents(c)), `c=${c}`).toBe(c);
  });
});
