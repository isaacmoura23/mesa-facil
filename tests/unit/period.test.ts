import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEZONE, MAX_PERIOD_DAYS, PERIOD_PRESETS, isPeriodPreset, resolvePeriod } from "@/lib/period";
import { describePeriod, firstParam, periodFromParams, periodQuery } from "@/modules/dashboard/period-params";
import { formatAxisCents, longDay, niceScale, shortDay } from "@/modules/dashboard/chart-math";
import {
  CSV_MAX_ROWS,
  EMPTY_ORDER_FILTERS,
  csvCell,
  decodeCursor,
  encodeCursor,
  formatCsvDateTime,
  formatDateTimeTz,
  formatTimeTz,
  hasActiveFilters,
  ordersQuery,
  parseOrderFilters,
} from "@/modules/dashboard/orders";
import { PAYMENT_METHOD_NAMES, metricsSchema, paymentMethodName } from "@/modules/dashboard/types";

const at = (iso: string) => new Date(iso);
const p = (o: Parameters<typeof resolvePeriod>[0]) => resolvePeriod(o);

describe("lib/period: presets e fusos", () => {
  it("lista de presets e type guard", () => {
    expect(PERIOD_PRESETS.map((x) => x.value)).toEqual(["today", "yesterday", "7d", "30d", "month", "custom"]);
    expect(isPeriodPreset("today")).toBe(true);
    for (const bad of ["", "TODAY", "constructor", null, undefined, 7, {}]) expect(isPeriodPreset(bad)).toBe(false);
  });

  it("São Paulo: 'hoje' vai da meia-noite local (03:00Z) à seguinte, mesmo com o UTC já no dia seguinte", () => {
    const r = p({ preset: "today", timezone: "America/Sao_Paulo", now: at("2026-03-10T02:00:00Z") }); // 23:00 de 09/03 em SP
    expect(r).toMatchObject({ preset: "today", fromDate: "2026-03-09", toDate: "2026-03-09", fellBack: false, timezone: "America/Sao_Paulo" });
    expect(r.fromIso).toBe("2026-03-09T03:00:00.000Z");
    expect(r.toIso).toBe("2026-03-10T03:00:00.000Z");
  });

  it("Tokyo (UTC+9) no mesmo instante já está no dia seguinte", () => {
    const r = p({ preset: "today", timezone: "Asia/Tokyo", now: at("2026-03-10T02:00:00Z") });
    expect(r.fromDate).toBe("2026-03-10");
    expect(r.fromIso).toBe("2026-03-09T15:00:00.000Z");
    expect(r.toIso).toBe("2026-03-10T15:00:00.000Z");
  });

  it("ontem, 7d, 30d e month (janela [from, to) sempre termina na meia-noite local seguinte a hoje)", () => {
    const now = at("2026-03-15T15:00:00Z");
    const tz = "America/Sao_Paulo";
    const y = p({ preset: "yesterday", timezone: tz, now });
    expect([y.fromDate, y.toDate]).toEqual(["2026-03-14", "2026-03-14"]);
    expect(y.toIso).toBe("2026-03-15T03:00:00.000Z");
    const d7 = p({ preset: "7d", timezone: tz, now });
    expect([d7.fromDate, d7.toDate]).toEqual(["2026-03-09", "2026-03-15"]);
    expect(d7.toIso).toBe("2026-03-16T03:00:00.000Z");
    expect((d7.to.getTime() - d7.from.getTime()) / 864e5).toBe(7);
    const d30 = p({ preset: "30d", timezone: tz, now });
    expect([d30.fromDate, d30.toDate]).toEqual(["2026-02-14", "2026-03-15"]);
    const m = p({ preset: "month", timezone: tz, now });
    expect([m.fromDate, m.toDate]).toEqual(["2026-03-01", "2026-03-15"]);
    expect(m.fromIso).toBe("2026-03-01T03:00:00.000Z");
    const jan = p({ preset: "7d", timezone: tz, now: at("2026-01-03T15:00:00Z") });
    expect(jan.fromDate).toBe("2025-12-28");
  });

  it("dias de horário de verão em Nova York têm 23 h e 25 h", () => {
    const tz = "America/New_York";
    const spring = p({ preset: "today", timezone: tz, now: at("2026-03-08T18:00:00Z") });
    expect(spring.fromIso).toBe("2026-03-08T05:00:00.000Z");
    expect(spring.toIso).toBe("2026-03-09T04:00:00.000Z");
    expect((spring.to.getTime() - spring.from.getTime()) / 36e5).toBe(23);
    const fall = p({ preset: "today", timezone: tz, now: at("2026-11-01T18:00:00Z") });
    expect(fall.fromIso).toBe("2026-11-01T04:00:00.000Z");
    expect(fall.toIso).toBe("2026-11-02T05:00:00.000Z");
    expect((fall.to.getTime() - fall.from.getTime()) / 36e5).toBe(25);
    const week = p({ preset: "7d", timezone: tz, now: at("2026-03-10T12:00:00Z") });
    expect(week.fromDate).toBe("2026-03-04");
    expect(week.fromIso).toBe("2026-03-04T05:00:00.000Z");
  });

  it("preset desconhecido ou ausente cai em 7 dias SEM marcar fellBack; fuso inválido/vazio usa São Paulo", () => {
    for (const preset of [undefined, null, "", "bogus", "constructor", "TODAY"]) {
      const r = p({ preset, timezone: "America/Sao_Paulo", now: at("2026-03-15T15:00:00Z") });
      expect(r.preset).toBe("7d");
      expect(r.fellBack).toBe(false);
    }
    for (const tz of ["Mars/Olympus", "", "   ", null, undefined, "'; drop table x; --"]) {
      expect(p({ preset: "today", timezone: tz, now: at("2026-03-15T15:00:00Z") }).timezone).toBe(DEFAULT_TIMEZONE);
    }
    expect(p({ preset: "today", timezone: " Asia/Tokyo ", now: at("2026-03-15T15:00:00Z") }).timezone).toBe("Asia/Tokyo");
  });
});

describe("lib/period: personalizado", () => {
  const base = { preset: "custom", timezone: "America/Sao_Paulo", now: at("2026-03-15T15:00:00Z") } as const;

  it("válido: datas inclusivas, to exclusivo na meia-noite seguinte", () => {
    const r = p({ ...base, from: "2026-02-01", to: "2026-02-28" });
    expect(r).toMatchObject({ preset: "custom", fellBack: false, fromDate: "2026-02-01", toDate: "2026-02-28", label: "Personalizado" });
    expect(r.fromIso).toBe("2026-02-01T03:00:00.000Z");
    expect(r.toIso).toBe("2026-03-01T03:00:00.000Z");
    const one = p({ ...base, from: "2026-02-10", to: "2026-02-10" });
    expect((one.to.getTime() - one.from.getTime()) / 864e5).toBe(1);
  });

  it("366 dias é o máximo; 367, from>to e datas impossíveis caem em 7 dias com fellBack", () => {
    expect(p({ ...base, from: "2026-01-01", to: "2027-01-01" }).fellBack).toBe(false);
    expect(MAX_PERIOD_DAYS).toBe(366);
    const cases: [string | null | undefined, string | null | undefined][] = [
      ["2026-01-01", "2027-01-02"],
      ["2026-03-10", "2026-03-09"],
      ["2026-02-30", "2026-03-05"],
      ["2026-02-01", "2026-02-30"],
      ["2025-02-29", "2025-03-05"],
      ["2026-13-01", "2026-13-02"],
      ["2026-00-10", "2026-01-10"],
      ["2026-1-1", "2026-1-2"],
      ["01/02/2026", "05/02/2026"],
      ["2026-02-01", null],
      [null, "2026-02-01"],
      [undefined, undefined],
      ["", ""],
      ["2026-02-01T00:00:00Z", "2026-02-02"],
      ["  2026-02-01", "2026-02-02"],
      ["9999-99-99", "0000-00-00"],
    ];
    for (const [from, to] of cases) {
      const r = p({ ...base, from, to });
      expect(r.fellBack, `${from}..${to}`).toBe(true);
      expect(r.preset).toBe("7d");
      expect(r.toDate).toBe("2026-03-15");
    }
    expect(p({ ...base, from: "2024-02-29", to: "2024-03-01" }).fellBack).toBe(false);
  });
});

describe("dashboard/period-params", () => {
  it("firstParam, periodFromParams, periodQuery e describePeriod", () => {
    expect(firstParam(["a", "b"])).toBe("a");
    expect(firstParam(undefined)).toBeUndefined();
    const now = at("2026-03-15T15:00:00Z");
    const r = periodFromParams({ preset: ["custom", "x"], from: "2026-03-01", to: ["2026-03-05"] }, "America/Sao_Paulo", "7d");
    expect(r).toMatchObject({ preset: "custom", fromDate: "2026-03-01", toDate: "2026-03-05" });
    expect(periodFromParams({}, "America/Sao_Paulo", "30d").preset).toBe("30d");
    expect(periodFromParams({ preset: "lixo" }, null, "today").preset).toBe("7d");
    expect(periodQuery(r)).toEqual({ preset: "custom", from: "2026-03-01", to: "2026-03-05" });
    expect(periodQuery(p({ preset: "month", now }))).toEqual({ preset: "month" });
    expect(describePeriod(r)).toBe("Personalizado (01/03/2026 a 05/03/2026)");
    expect(describePeriod(p({ preset: "today", timezone: "America/Sao_Paulo", now }))).toBe("Hoje (15/03/2026)");
  });
});

describe("dashboard/chart-math", () => {
  it("niceScale: máximo redondo, 5 marcas, sem NaN para 0/negativo/NaN", () => {
    expect(niceScale(0)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    for (const bad of [-5, NaN]) expect(niceScale(bad).max).toBe(4);
    expect(niceScale(10)).toEqual({ max: 10, ticks: [0, 2.5, 5, 7.5, 10] });
    for (const v of [1, 7, 99, 100, 101, 12345, 987654, 1e9]) {
      const s = niceScale(v);
      expect(s.max).toBeGreaterThanOrEqual(v);
      expect(s.ticks).toHaveLength(5);
      expect(s.ticks[4]).toBe(s.max);
      expect(s.max / v).toBeLessThan(2.6);
    }
  });

  it("formatAxisCents e rótulos de dia", () => {
    expect(formatAxisCents(0)).toBe("R$ 0");
    expect(formatAxisCents(25000)).toBe("R$ 250");
    expect(formatAxisCents(120000)).toBe("R$ 1,2 mil");
    expect(formatAxisCents(300000000)).toBe("R$ 3 mi");
    expect(shortDay("2026-10-16")).toBe("16/10");
    expect(longDay("2026-10-16")).toBe("sex, 16 out 2026");
    expect(shortDay("lixo")).toBe("lixo");
    expect(longDay("")).toBe("");
  });
});

describe("dashboard/orders: filtros, cursor e CSV", () => {
  it("parseOrderFilters: enums válidos, número só com dígitos (sem zeros à esquerda, máx. 9)", () => {
    expect(parseOrderFilters({})).toEqual(EMPTY_ORDER_FILTERS);
    expect(parseOrderFilters({ fulfillment: "DELIVERY", status: ["READY", "x"], number: "#00012abc" })).toEqual({ fulfillment: "DELIVERY", status: "READY", number: "12" });
    expect(parseOrderFilters({ fulfillment: "drone", status: "constructor", number: "1234567890123" }).number).toBe("123456789");
    expect(parseOrderFilters({ number: "000" }).number).toBe("0");
    expect(parseOrderFilters({ number: "' or 1=1" }).number).toBe("11");
    expect(hasActiveFilters(EMPTY_ORDER_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_ORDER_FILTERS, number: "1" })).toBe(true);
  });

  it("ordersQuery junta período, filtros e extras (ignora extras nulos)", () => {
    const per = p({ preset: "custom", from: "2026-03-01", to: "2026-03-05", timezone: "America/Sao_Paulo" });
    const qs = new URLSearchParams(ordersQuery(per, { fulfillment: "PICKUP", status: "ALL", number: "7" }, { cursor: "abc", page: null }));
    expect(Object.fromEntries(qs)).toEqual({ preset: "custom", from: "2026-03-01", to: "2026-03-05", fulfillment: "PICKUP", number: "7", cursor: "abc" });
  });

  it("cursor: ida e volta; adulterado/hostil => null", () => {
    const c = { t: "2026-03-10T12:00:00.123456+00:00", id: "00000000-0000-4000-8000-000000000001" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    const enc = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
    const bad: (string | undefined)[] = [
      undefined,
      "",
      "%%%",
      "não-base64!",
      enc("not json"),
      enc([]),
      enc(null),
      enc({}),
      enc({ t: c.t }),
      enc({ id: c.id }),
      enc({ t: "ontem", id: c.id }),
      enc({ t: c.t, id: "x" }),
      enc({ t: 1, id: c.id }),
      enc({ t: c.t + "; drop", id: c.id }),
      enc({ t: "2026-03-10", id: c.id }),
    ];
    for (const b of bad) expect(decodeCursor(b), String(b)).toBeNull();
    expect(CSV_MAX_ROWS).toBe(5000);
  });

  it("csvCell neutraliza fórmulas (=,+,-,@,tab,CR) e escapa aspas, ; e quebras de linha", () => {
    for (const v of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\t=1", "\r=1"]) expect(csvCell(v).replace(/^"/, "").startsWith("'"), JSON.stringify(v)).toBe(true);
    expect(csvCell("normal")).toBe("normal");
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });

  it("formatadores no fuso do restaurante (inválido cai em São Paulo; data inválida => '--')", () => {
    const iso = "2026-03-10T02:30:00Z";
    expect(formatDateTimeTz(iso, "America/Sao_Paulo")).toBe("09/03/2026 23:30");
    expect(formatDateTimeTz(iso, "Asia/Tokyo")).toBe("10/03/2026 11:30");
    expect(formatDateTimeTz(iso, "Mars/Olympus")).toBe("09/03/2026 23:30");
    expect(formatTimeTz(iso, "America/Sao_Paulo")).toBe("23:30");
    expect(formatCsvDateTime("2026-03-10T03:00:00Z", "America/Sao_Paulo")).toBe("10/03/2026 00:00:00");
    expect(formatDateTimeTz("lixo", "America/Sao_Paulo")).toBe("--");
  });

  it("types: métodos de pagamento e schema das métricas", () => {
    expect(paymentMethodName("PIX")).toBe("Pix");
    expect(paymentMethodName("XYZ")).toBe("Outra forma");
    expect(Object.keys(PAYMENT_METHOD_NAMES)).toContain("CREDIT");
    expect(metricsSchema.safeParse({}).success).toBe(false);
  });

  it("F-48: paymentMethodName('constructor') devolve uma FUNÇÃO (Object.prototype) em vez de 'Outra forma' (mesma classe de F-19/F-39)", () => {
    for (const k of ["constructor", "toString", "__proto__"]) expect(paymentMethodName(k)).toBe("Outra forma");
  });
});
