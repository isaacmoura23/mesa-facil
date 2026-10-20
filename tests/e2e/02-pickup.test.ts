import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import {
  BASE, db, RID, SLUG, TAG, anonContext, cleanupE2eData, launch, loggedContext, newPage, orderCard, placeOrder, serverUp, uniq,
} from "./helpers";

const LONG = { timeout: 45_000 };
let browser: Browser;
let tracker: Page, cashier: Page, kitchen: Page, manager: Page;
const orders: Record<string, { number: number }> = {};

beforeAll(async () => {
  if (!(await serverUp())) throw new Error(`Dev server fora do ar em ${BASE}`);
  browser = await launch();
  tracker = await newPage(await anonContext(browser));
  cashier = await newPage(await loggedContext(browser, "cashierA"));
  kitchen = await newPage(await loggedContext(browser, "kitchenA"));
  manager = await newPage(await loggedContext(browser, "managerA"));
  await cashier.goto(`${BASE}/operacao/${SLUG}/pedidos`);
  await cashier.getByRole("tab", { name: /Novos/ }).waitFor();
  await kitchen.goto(`${BASE}/operacao/${SLUG}/cozinha`);
  await kitchen.getByRole("heading", { name: "Cozinha" }).waitFor();
  await manager.goto(`${BASE}/operacao/${SLUG}/pedidos`);
  await manager.getByRole("tab", { name: /Novos/ }).waitFor();
});

afterAll(async () => {
  await cleanupE2eData();
  await browser?.close();
});

const headline = (p: Page, text: string | RegExp) => p.getByText(text).first().waitFor(LONG);
async function confirmReason(p: Page, reason: string) {
  const dialog = p.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /Motivo/ }).fill(reason);
  await dialog.getByRole("button").last().click();
}

describe("E2E 2 - PICKUP (retirada)", () => {
  it("fluxo completo: aceita, cozinha prepara e marca pronto, caixa conclui (Retirado) sem endereço", async () => {
    const name = `${TAG} retirada ${uniq()}`;
    orders.ok = await placeOrder(tracker, { fulfillment: "PICKUP", name, payment: "PIX" });
    const { data } = await db().from("orders").select("fulfillment_type,delivery_address,delivery_fee_cents,payment_method_intent").eq("restaurant_id", RID).eq("order_number", orders.ok.number).single();
    expect(data).toMatchObject({ fulfillment_type: "PICKUP", delivery_fee_cents: 0, payment_method_intent: "PIX" });
    expect(data.delivery_address).toBeNull();
    await headline(tracker, "Pedido enviado. Aguardando a confirmação do restaurante.");
    const card = orderCard(cashier, orders.ok.number);
    await card.waitFor(LONG);
    await card.getByRole("button", { name: "Aceitar" }).click();
    await headline(tracker, "O restaurante confirmou seu pedido.");
    await orderCard(kitchen, orders.ok.number).getByRole("button", { name: "Iniciar preparo" }).click();
    await headline(tracker, "Seu pedido está sendo preparado.");
    await orderCard(kitchen, orders.ok.number).getByRole("button", { name: "Marcar pronto" }).click();
    await headline(tracker, "Seu pedido está pronto. Pode retirar!");
    await orderCard(cashier, orders.ok.number).getByRole("button", { name: "Retirado" }).click();
    await headline(tracker, "Pedido retirado. Bom apetite!");
  });

  it("recusa com motivo: o motivo aparece no acompanhamento do cliente", async () => {
    const t2 = await newPage(await anonContext(browser));
    orders.rej = await placeOrder(t2, { fulfillment: "PICKUP", name: `${TAG} recusa ${uniq()}`, payment: "CASH" });
    const card = orderCard(cashier, orders.rej.number);
    await card.waitFor(LONG);
    await card.getByRole("button", { name: "Recusar" }).click();
    await confirmReason(cashier, "Sem estoque de bacon (e2e)");
    await t2.getByText("Motivo informado pelo restaurante: Sem estoque de bacon (e2e)").waitFor(LONG);
    const { data } = await db().from("orders").select("status,status_reason").eq("restaurant_id", RID).eq("order_number", orders.rej.number).single();
    expect(data).toMatchObject({ status: "REJECTED", status_reason: "Sem estoque de bacon (e2e)" });
  });

  it("recusa sem motivo é barrada pela interface", async () => {
    const t3 = await newPage(await anonContext(browser));
    const o = await placeOrder(t3, { fulfillment: "PICKUP", name: `${TAG} recusa-vazia ${uniq()}`, payment: "CASH" });
    const card = orderCard(cashier, o.number);
    await card.waitFor(LONG);
    await card.getByRole("button", { name: "Recusar" }).click();
    await cashier.getByRole("dialog").getByRole("button").last().click();
    await cashier.getByText("Informe o motivo para continuar.").waitFor();
    const { data } = await db().from("orders").select("status").eq("restaurant_id", RID).eq("order_number", o.number).single();
    expect(data.status).toBe("RECEIVED");
    await cashier.getByRole("dialog").getByRole("button", { name: "Voltar" }).click();
  });

  it("cancelamento com motivo pelo gerente (pedido já aceito) aparece no acompanhamento", async () => {
    const t4 = await newPage(await anonContext(browser));
    orders.can = await placeOrder(t4, { fulfillment: "PICKUP", name: `${TAG} cancela ${uniq()}`, payment: "CARD" });
    const card = orderCard(cashier, orders.can.number);
    await card.waitFor(LONG);
    await card.getByRole("button", { name: "Aceitar" }).click();
    await headline(t4, "O restaurante confirmou seu pedido.");
    const mcard = orderCard(manager, orders.can.number);
    await mcard.waitFor(LONG);
    await mcard.getByRole("button", { name: new RegExp(`Abrir detalhes do pedido ${orders.can.number},`) }).click();
    await manager.getByRole("dialog").getByRole("button", { name: /Cancelar pedido/ }).click();
    await confirmReason(manager, "Cliente desistiu (e2e)");
    await t4.getByText("Motivo informado pelo restaurante: Cliente desistiu (e2e)").waitFor(LONG);
    const { data } = await db().from("orders").select("status,status_reason").eq("restaurant_id", RID).eq("order_number", orders.can.number).single();
    expect(data).toMatchObject({ status: "CANCELLED", status_reason: "Cliente desistiu (e2e)" });
  });
});
