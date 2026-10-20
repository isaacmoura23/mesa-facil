import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  BASE, db, RID, SLUG, TAG, anonContext, assertNoReload, cleanupE2eData, launch, loggedContext, newPage, orderCard,
  placeOrder, serverUp, stampNoReload, uniq,
} from "./helpers";

const LONG = { timeout: 45_000 };
let browser: Browser;
let cust: BrowserContext, cashierCtx: BrowserContext, kitchenCtx: BrowserContext, ownerCtx: BrowserContext;
let tracker: Page, cashier: Page, kitchen: Page, owner: Page;
let order: { number: number; url: string };
const NAME = `${TAG} entrega ${uniq()}`;

beforeAll(async () => {
  if (!(await serverUp())) throw new Error(`Dev server fora do ar em ${BASE}`);
  browser = await launch();
  cust = await anonContext(browser);
  cashierCtx = await loggedContext(browser, "cashierA");
  kitchenCtx = await loggedContext(browser, "kitchenA");
  ownerCtx = await loggedContext(browser, "ownerA");
  cashier = await newPage(cashierCtx);
  kitchen = await newPage(kitchenCtx);
  owner = await newPage(ownerCtx);
  tracker = await newPage(cust);
  await cashier.goto(`${BASE}/operacao/${SLUG}/pedidos`);
  await cashier.getByRole("tab", { name: /Novos/ }).waitFor();
  await stampNoReload(cashier);
  await kitchen.goto(`${BASE}/operacao/${SLUG}/cozinha`);
  await kitchen.getByRole("heading", { name: "Cozinha" }).waitFor();
  await stampNoReload(kitchen);
});

afterAll(async () => {
  await cleanupE2eData();
  await browser?.close();
});

const headline = (p: Page, text: string | RegExp) => p.getByText(text).first().waitFor(LONG);

describe("E2E 1 - DELIVERY ponta a ponta", () => {
  it("cliente sem login faz o pedido (adicional, endereço, região, dinheiro com troco)", async () => {
    order = await placeOrder(tracker, { fulfillment: "DELIVERY", name: NAME, payment: "CASH", changeFor: "100" });
    expect(order.number).toBeGreaterThan(0);
    await headline(tracker, "Pedido enviado. Aguardando a confirmação do restaurante.");
    const { data } = await db().from("orders").select("*").eq("restaurant_id", RID).eq("order_number", order.number).single();
    expect(data).toMatchObject({ fulfillment_type: "DELIVERY", status: "RECEIVED", payment_method_intent: "CASH", change_for_cents: 10000 });
    expect(data.delivery_address).toMatchObject({ street: "Rua E2E" });
  });

  it("caixa vê o pedido surgir sem recarregar (Realtime) e aceita", async () => {
    const card = orderCard(cashier, order.number);
    await card.waitFor(LONG);
    expect(await assertNoReload(cashier)).toBe(true);
    await card.getByRole("button", { name: "Aceitar" }).click();
    await orderCard(cashier, order.number).getByRole("button", { name: "Iniciar preparo" }).waitFor(LONG);
    await headline(tracker, "O restaurante confirmou seu pedido.");
  });

  it("cozinha vê o pedido em Novos, inicia preparo e marca pronto", async () => {
    const card = orderCard(kitchen, order.number);
    await card.waitFor(LONG);
    expect(await assertNoReload(kitchen)).toBe(true);
    await card.getByRole("button", { name: "Iniciar preparo" }).click();
    await orderCard(kitchen, order.number).getByRole("button", { name: "Marcar pronto" }).waitFor(LONG);
    await headline(tracker, "Seu pedido está sendo preparado.");
    await orderCard(kitchen, order.number).getByRole("button", { name: "Marcar pronto" }).click();
    await headline(tracker, /Seu pedido está pronto/);
  });

  it("caixa avança até Saiu para entrega e Entregue; acompanhamento reflete cada estado", async () => {
    const card = orderCard(cashier, order.number);
    await card.getByRole("button", { name: "Saiu para entrega" }).waitFor(LONG);
    await card.getByRole("button", { name: "Saiu para entrega" }).click();
    await headline(tracker, "Seu pedido saiu para entrega.");
    await orderCard(cashier, order.number).getByRole("button", { name: "Entregue" }).click();
    await headline(tracker, "Pedido entregue. Bom apetite!");
    const { data } = await db().from("orders").select("status").eq("restaurant_id", RID).eq("order_number", order.number).single();
    expect(data.status).toBe("COMPLETED");
  });

  it("owner.a vê o pedido SOMENTE LEITURA em /app/pedidos, no detalhe e no dashboard", async () => {
    await owner.goto(`${BASE}/app/${SLUG}/pedidos?preset=today`);
    await owner.getByText(NAME).first().waitFor(LONG);
    const ops = ["Aceitar", "Recusar", "Iniciar preparo", "Marcar pronto", "Saiu para entrega", "Entregue", "Concluir", "Cancelar", "Imprimir"];
    for (const op of ops) {
      expect(await owner.getByRole("button", { name: new RegExp(op) }).count(), `botão ${op}`).toBe(0);
    }
    const { data } = await db().from("orders").select("id").eq("restaurant_id", RID).eq("order_number", order.number).single();
    await owner.goto(`${BASE}/app/${SLUG}/pedidos/${data.id}`);
    await owner.getByText(NAME).first().waitFor(LONG);
    for (const op of ops) {
      expect(await owner.getByRole("button", { name: new RegExp(op) }).count(), `detalhe ${op}`).toBe(0);
    }
    await owner.goto(`${BASE}/app/${SLUG}/dashboard`);
    await owner.getByRole("heading", { level: 1 }).waitFor();
    const text = await owner.locator("main").innerText();
    expect(text).toMatch(/Pedidos/);
    expect(text).not.toMatch(/Aceitar|Recusar/);
  });
});
