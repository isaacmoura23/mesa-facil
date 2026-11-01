import { describe, expect, it, vi } from "vitest";
import { CounterSaleError, createCounterSale, parseCounterSaleError } from "../../src/modules/counter-sale/rpc";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const client = (rpc: Rpc) => ({ rpc }) as unknown as Parameters<typeof createCounterSale>[0];
const input = {
  restaurantId: "r1",
  items: [{ product_id: "p1", variant_id: null, quantity: 2, modifier_ids: [] }],
  tenderedCents: 2000,
  notes: null,
  idempotencyKey: "chave-da-tentativa",
};

describe("venda de balcão (cliente da RPC)", () => {
  it("envia os parâmetros certos e devolve total e troco", async () => {
    const rpc = vi.fn<Rpc>().mockResolvedValue({
      data: { ok: true, idempotent_replay: false, order: { id: "o1", order_number: 12, total_cents: 1400, payment_status: "PAID" }, change_cents: 600 },
      error: null,
    });
    const result = await createCounterSale(client(rpc), input);
    expect(result).toEqual({ orderId: "o1", orderNumber: 12, totalCents: 1400, changeCents: 600, replay: false });
    expect(rpc).toHaveBeenCalledWith("create_counter_sale", {
      p_restaurant: "r1",
      p_items: input.items,
      p_tendered_cents: 2000,
      p_notes: null,
      p_idempotency_key: "chave-da-tentativa",
    });
  });

  it("itens recusados pelo servidor viram um erro que pede para revisar o pedido", async () => {
    const rpc = vi.fn<Rpc>().mockResolvedValue({ data: { ok: false, errors: [{ code: "PRODUCT_UNAVAILABLE" }] }, error: null });
    await expect(createCounterSale(client(rpc), input)).rejects.toMatchObject({ code: "ITEMS_INVALID" });
  });

  it("traduz os erros do banco e nunca vaza o texto técnico", async () => {
    expect(parseCounterSaleError({ message: "INVALID_TENDERED: o valor recebido deve cobrir o total" }).message).toMatch(/cobrir o total/);
    expect(parseCounterSaleError({ message: "FORBIDDEN: sem permissão" }).code).toBe("FORBIDDEN");
    expect(parseCounterSaleError({ message: "permission denied for function create_counter_sale" }).code).toBe("FORBIDDEN");
    const unknown = parseCounterSaleError({ message: "connection terminated: select * from payments" });
    expect(unknown).toBeInstanceOf(CounterSaleError);
    expect(unknown.message).not.toMatch(/select|payments/);
  });

  it("resposta fora do contrato não é tratada como sucesso", async () => {
    const rpc = vi.fn<Rpc>().mockResolvedValue({ data: { ok: true }, error: null });
    await expect(createCounterSale(client(rpc), input)).rejects.toBeInstanceOf(CounterSaleError);
  });
});
