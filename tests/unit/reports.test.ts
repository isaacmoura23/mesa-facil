/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { DEFAULT_REPORT, REPORTS, REPORT_GROUPS, REPORT_KEYS, isReportGroup, isReportKey } from "@/modules/reports/catalog";
import { buildReportCsv, centsToCsv, csvText } from "@/modules/reports/csv";
import {
  failureFrom,
  LOAD_ERROR,
  loadFailure,
  rpcErrorCode,
} from "@/modules/reports/errors";
import {
  fulfillmentLabel,
  formatCell,
  formatInt,
  formatPeriodLabel,
  formatPeriodShort,
  formatYmd,
  makeDateFormatters,
  numberOf,
  orderStatusLabel,
  paymentMethodLabel,
  textLabel,
} from "@/modules/reports/format";
import { parseReportFilters, reportQuery, reportResponseSchema, type ReportData } from "@/modules/reports/schemas";

describe("reports/catalog", () => {
  it("7 relatórios, 3 grupos, padrão válido; guards rejeitam herança de Object.prototype", () => {
    expect(REPORT_KEYS).toHaveLength(7);
    expect(REPORT_GROUPS.map((g) => g.value)).toEqual(["day", "week", "month"]);
    expect(isReportKey(DEFAULT_REPORT)).toBe(true);
    for (const k of REPORT_KEYS) expect(REPORTS[k].label.length).toBeGreaterThan(3);
    for (const bad of ["constructor", "toString", "", null, 1, "SALES_BY_PERIOD"]) expect(isReportKey(bad)).toBe(false);
    for (const bad of ["year", "", "DAY", null, "constructor"]) expect(isReportGroup(bad)).toBe(false);
    expect(REPORT_KEYS.filter((k) => REPORTS[k].grouped)).toEqual(["sales_by_period", "avg_ticket", "fees_discounts"]);
  });
});

describe("reports/csv", () => {
  const data = (over: Partial<ReportData> = {}): ReportData => ({
    report: "x",
    columns: [
      { key: "name", label: "Produto", type: "text" },
      { key: "quantity", label: "Quantidade", type: "integer" },
      { key: "sales_cents", label: "Faturamento", type: "cents" },
    ],
    rows: [],
    totals: {},
    truncated: false,
    ...over,
  });

  it("centsToCsv: vírgula decimal, inteiro, negativo, arredonda", () => {
    expect(centsToCsv(0)).toBe("0,00");
    expect(centsToCsv(5)).toBe("0,05");
    expect(centsToCsv(123456)).toBe("1234,56");
    expect(centsToCsv(-250)).toBe("-2,50");
    expect(centsToCsv(10_000_000_00)).toBe("10000000,00");
    expect(centsToCsv(99.6)).toBe("1,00");
  });

  it("csvText: mitiga fórmula em = + - @ (também depois de tab/CR/espaços), escapa aspas, achata quebras", () => {
    for (const v of ["=cmd|' /C calc'!A0", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "  =1", "\n=1"]) expect(csvText(v), JSON.stringify(v)).toMatch(/^"'[=+\-@]/);
    expect(csvText("normal")).toBe('"normal"');
    expect(csvText('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvText("linha1\r\nlinha2\tx")).toBe('"linha1 linha2 x"');
    expect(csvText("a;b")).toBe('"a;b"');
    expect(csvText("")).toBe('""');
  });

  it("buildReportCsv: BOM UTF-8, separador ';', CRLF, números entre aspas com vírgula decimal, linha de total e aviso", () => {
    const csv = buildReportCsv(
      data({
        rows: [
          { name: "Pizza", quantity: 3, sales_cents: 9050 },
          { name: "=1+1", quantity: 1, sales_cents: 100 },
          { name: null, quantity: null, sales_cents: null },
        ],
        totals: { quantity: 4, sales_cents: 9150 },
        truncated: true,
      }),
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe('"Produto";"Quantidade";"Faturamento"');
    expect(lines[1]).toBe('"Pizza";"3";"90,50"');
    expect(lines[2]).toBe('"\'=1+1";"1";"1,00"');
    expect(lines[3]).toBe('"";"";""');
    expect(lines[4]).toBe('"Total";"4";"91,50"');
    expect(lines[5]).toBe('"Aviso: resultado limitado a 5000 linhas."');
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toMatch(/\d\.\d\d"/);
  });

  it("sem totais não há linha de total; rótulos e valores traduzidos; motivo truncado em 80; datas dd/mm/aaaa", () => {
    const csv = buildReportCsv({
      report: "cancellations",
      columns: [
        { key: "period", label: "Período", type: "date" },
        { key: "status", label: "Situação", type: "text" },
        { key: "type", label: "Tipo", type: "text" },
        { key: "method", label: "Forma", type: "text" },
        { key: "reason", label: "Motivo", type: "text" },
      ],
      rows: [{ period: "2026-03-09", status: "CANCELLED", type: "DINE_IN", method: "PIX", reason: "z".repeat(200) }],
      totals: {},
      truncated: false,
    });
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`"09/03/2026";"Cancelado";"Consumo no local";"Pix";"${"z".repeat(80)}"`);
  });

  it("injeção por texto de coluna que parece rótulo ('constructor') não vaza função", () => {
    const csv = buildReportCsv({ report: "x", columns: [{ key: "method", label: "Forma", type: "text" }], rows: [{ method: "constructor" }], totals: {}, truncated: false });
    expect(csv).toContain('"constructor"');
  });
});

describe("reports/format", () => {
  it("datas, rótulos de bucket (dia, semana, mês) e inteiros pt-BR", () => {
    expect(formatYmd("2026-03-09")).toBe("09/03/2026");
    expect(formatYmd("lixo")).toBe("lixo");
    expect(formatPeriodLabel("2026-03-09", "day")).toBe("09/03/2026");
    expect(formatPeriodLabel("2026-03-09", "week")).toBe("09/03 a 15/03/2026");
    expect(formatPeriodLabel("2026-12-28", "week")).toBe("28/12 a 03/01/2027");
    expect(formatPeriodLabel("2026-03-01", "month")).toBe("mar/2026");
    expect(formatPeriodShort("2026-03-01", "month")).toBe("mar/26");
    expect(formatPeriodShort("2026-03-09", "day")).toBe("09/03");
    expect(formatInt(1234567)).toBe("1.234.567");
  });

  it("rótulos: códigos conhecidos traduzidos, desconhecidos e herdados ficam como estão", () => {
    expect(fulfillmentLabel("DELIVERY")).toBe("Entrega");
    expect(orderStatusLabel("OUT_FOR_DELIVERY")).toBe("Em entrega");
    expect(paymentMethodLabel("CREDIT")).toBe("Cartão de crédito");
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(fulfillmentLabel(k)).toBe(k);
      expect(orderStatusLabel(k)).toBe(k);
      expect(paymentMethodLabel(k)).toBe(k);
    }
    expect(textLabel("reason", "X")).toBe("X");
  });

  it("formatCell e numberOf tolerantes", () => {
    const col = (type: any, key = "k") => ({ key, label: "L", type });
    expect(formatCell(col("cents"), 12345, "day")).toMatch(/123,45/);
    expect(formatCell(col("cents"), "abc", "day")).toBe("-");
    expect(formatCell(col("integer"), 1500, "day")).toBe("1.500");
    expect(formatCell(col("text"), null, "day")).toBe("-");
    expect(formatCell(col("text"), "", "day")).toBe("-");
    expect(formatCell(col("date"), "2026-03-01", "month")).toBe("mar/2026");
    expect(numberOf(5)).toBe(5);
    for (const v of [undefined, null, "5", NaN, Infinity]) expect(numberOf(v as any)).toBe(0);
  });

  it("makeDateFormatters: fuso do restaurante, inválido não quebra, data inválida => '-'", () => {
    const f = makeDateFormatters("America/Sao_Paulo");
    expect(f.dateTime("2026-03-10T02:30:00Z")).toMatch(/09\/03\/2026,? 23:30/);
    expect(f.date("2026-03-10T02:30:00Z")).toBe("09/03/2026");
    expect(f.date(null)).toBe("-");
    expect(f.dateTime("lixo")).toBe("-");
    expect(() => makeDateFormatters("Mars/Olympus").date("2026-03-10T02:30:00Z")).not.toThrow();
  });
});

describe("reports/errors", () => {
  it("rpcErrorCode extrai 'CODIGO:' do início; failureFrom nunca expõe o texto do banco", () => {
    expect(rpcErrorCode("INVALID_PERIOD: período inválido")).toBe("INVALID_PERIOD");
    expect(rpcErrorCode("  FORBIDDEN: x")).toBe("FORBIDDEN");
    for (const bad of ["invalid: x", "algo INVALID_PERIOD: x", "", null, undefined, "42501"]) expect(rpcErrorCode(bad)).toBeNull();
    expect(failureFrom({ message: "FORBIDDEN: requer permissão reports.view" })).toEqual({ ok: false, code: "FORBIDDEN", message: "Você não tem permissão para ver estes dados." });
    const unknown = failureFrom({ message: "XYZ_ERRO: select * from secret_table" });
    expect(unknown.message).toBe(LOAD_ERROR);
    expect(unknown.message).not.toContain("secret_table");
    expect(failureFrom({ message: "connection refused 10.0.0.5" }).code).toBeNull();
    expect(failureFrom({}).message).toBe(LOAD_ERROR);
    expect(loadFailure()).toEqual({ ok: false, code: null, message: LOAD_ERROR });
    for (const code of ["INVALID_CURSOR", "CUSTOMER_NOT_FOUND", "INVALID_REPORT", "INVALID_GROUP", "RESTAURANT_NOT_FOUND", "UNAUTHENTICATED"]) {
      expect(failureFrom({ message: `${code}: x` }).message).not.toBe(LOAD_ERROR);
    }
  });
});

describe("reports/schemas", () => {
  it("resposta: totals nulo vira {}, tipo de coluna desconhecido vira text, truncated inválido vira false", () => {
    const r = reportResponseSchema.parse({ report: "x", columns: [{ key: "a", label: "A", type: "banana" }], rows: [{ a: 1 }], totals: null, truncated: "sim" });
    expect(r.totals).toEqual({});
    expect(r.columns[0].type).toBe("text");
    expect(r.truncated).toBe(false);
    expect(reportResponseSchema.safeParse({ report: "x", columns: [], rows: [{ a: { b: 1 } }] }).success).toBe(false);
    expect(reportResponseSchema.safeParse({ columns: [], rows: [] }).success).toBe(false);
  });

  it("parseReportFilters: valores inválidos caem no padrão com aviso; relatório sem grupo ignora group", () => {
    const tz = "America/Sao_Paulo";
    const ok = parseReportFilters({ report: "avg_ticket", group: "week", preset: "30d" }, tz);
    expect(ok).toMatchObject({ report: "avg_ticket", group: "week", warnings: [] });
    expect(ok.period.preset).toBe("30d");
    const flat = parseReportFilters({ report: "top_products", group: "month" }, tz);
    expect(flat.group).toBe("day");
    const bad = parseReportFilters({ report: "nope", group: "year", preset: "lixo" }, tz);
    expect(bad.report).toBe(DEFAULT_REPORT);
    expect(bad.group).toBe("day");
    expect(bad.warnings).toHaveLength(3);
    const fell = parseReportFilters({ preset: "custom", from: "2026-02-30", to: "2026-03-01" }, tz);
    expect(fell.period.fellBack).toBe(true);
    expect(fell.warnings.join(" ")).toMatch(/366 dias/);
    expect(parseReportFilters({ report: ["top_products", "x"] }, tz).report).toBe("top_products");
    expect(parseReportFilters({ report: "constructor" }, tz).report).toBe(DEFAULT_REPORT);
  });

  it("reportQuery: canônica (custom leva from/to; group só quando agrupa e não é day)", () => {
    const tz = "America/Sao_Paulo";
    const f = parseReportFilters({ report: "sales_by_period", group: "month", preset: "custom", from: "2026-01-01", to: "2026-03-01" }, tz);
    expect(reportQuery(f)).toBe("report=sales_by_period&preset=custom&from=2026-01-01&to=2026-03-01&group=month");
    expect(reportQuery(f, { report: "top_products" })).toBe("report=top_products&preset=custom&from=2026-01-01&to=2026-03-01");
    expect(reportQuery(parseReportFilters({}, tz))).toBe("report=sales_by_period&preset=7d");
  });
});
