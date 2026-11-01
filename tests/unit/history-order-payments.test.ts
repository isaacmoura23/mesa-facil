import { describe, expect, it } from "vitest";
import { fetchOrderPayments } from "../../src/components/history/history-model";

type Rows = Record<string, unknown>[];
/** Cliente falso: devolve `payments` para a tabela payments e `profiles` para a de perfis. */
function fake(payments: Rows, profiles: Rows = [], error: string | null = null) {
  const chain = (rows: Rows, err: string | null) => {
    const q: Record<string, unknown> = {};
    for (const name of ["select", "eq", "order", "limit", "in"]) q[name] = () => q;
    q.then = (resolve: (v: unknown) => void) => resolve({ data: err ? null : rows, error: err ? { message: err } : null });
    return q;
  };
  return { from: (table: string) => chain(table === "payments" ? payments : profiles, table === "payments" ? error : null) } as unknown as Parameters<typeof fetchOrderPayments>[0];
}

const cash = { id: "p1", method: "CASH", amount_cents: 3500, status: "PAID", tendered_cents: 5000, recorded_by: "u1", paid_at: "2026-10-31T20:23:00Z", created_at: "2026-10-31T20:23:00Z" };

describe("pagamentos do pedido no histórico", () => {
  it("calcula o troco do dinheiro e traz quem recebeu", async () => {
    const [row] = await fetchOrderPayments(fake([cash], [{ id: "u1", full_name: "Qi Buxo - caixa" }]), "r", "o");
    expect(row).toMatchObject({ tendered_cents: 5000, changeCents: 1500, recordedByName: "Qi Buxo - caixa" });
  });

  it("sem valor recebido informado não inventa troco; outras formas também não têm", async () => {
    const rows = await fetchOrderPayments(
      fake([{ ...cash, tendered_cents: null }, { ...cash, id: "p2", method: "PIX", tendered_cents: null }]),
      "r",
      "o",
    );
    expect(rows.map((r) => r.changeCents)).toEqual([null, null]);
  });

  it("falha de leitura vira erro (a tela esconde a seção)", async () => {
    await expect(fetchOrderPayments(fake([], [], "permission denied"), "r", "o")).rejects.toThrow(/permission denied/);
  });
});
