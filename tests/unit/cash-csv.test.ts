import { describe, expect, it } from "vitest";
import { buildCashCsv } from "../../src/modules/cash/csv";
import type { MovementRow } from "../../src/modules/cash/types";

const base: MovementRow = {
  id: "1", session_id: null, kind: "SALE", direction: "IN", amount_cents: 3790, tendered_cents: 5000, change_cents: 1210,
  reason: null, payment_id: "p", reverses: null, created_at: "2026-10-30T15:00:00.000Z", created_by: "u",
  actor_name: "Maria", order_number: 12, tab_label: null, reversed: false,
};

describe("buildCashCsv", () => {
  it("monta cabeçalho e linhas com vírgula decimal e BOM", () => {
    const csv = buildCashCsv([base]);
    expect(csv.startsWith("﻿")).toBe(true);
    const [head, row] = csv.replace("﻿", "").trim().split("\r\n");
    expect(head).toContain('"Troco"');
    expect(row).toContain('"37,90"');
    expect(row).toContain('"50,00"');
    expect(row).toContain('"12,10"');
    expect(row).toContain('"Venda em dinheiro"');
    expect(row).toContain('"Pedido 12"');
    expect(row).toContain('"Maria"');
  });
  it("saída sem recebido/troco deixa vazio e marca estornado", () => {
    const csv = buildCashCsv([{ ...base, kind: "EXPENSE", direction: "OUT", amount_cents: 1500, tendered_cents: null, change_cents: null, reason: "gelo", payment_id: null, order_number: null, reversed: true }]);
    const row = csv.replace("﻿", "").trim().split("\r\n")[1]!;
    expect(row).toContain('"Saída"');
    expect(row).toContain('"15,00";"";""');
    expect(row).toContain('"Sim"');
  });
  it("neutraliza fórmula no motivo", () => {
    const csv = buildCashCsv([{ ...base, kind: "EXPENSE", direction: "OUT", reason: "=HYPERLINK(\"x\")", tendered_cents: null, change_cents: null, payment_id: null }]);
    expect(csv).toContain("\"'=HYPERLINK");
  });
});
