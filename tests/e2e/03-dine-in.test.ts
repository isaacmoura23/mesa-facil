/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import {
  BASE, db, RID, SLUG, TAG, cleanupE2eData, launch, loggedContext, newPage, orderCard, serverUp, uniq,
} from "./helpers";

const LONG = { timeout: 45_000 };
const TABLE = "DEMO Mesa 4";
const LABEL = `${TAG} salao ${uniq()}`;
let browser: Browser;
let waiter: Page, cashier: Page, kitchen: Page, owner: Page;
let tabId = "";
let tableId = "";
let orderNumbers: number[] = [];

beforeAll(async () => {
  if (!(await serverUp())) throw new Error(`Dev server fora do ar em ${BASE}`);
  await cleanupE2eData();
  browser = await launch();
  waiter = await newPage(await loggedContext(browser, "waiterA"));
  const cashierCtx = await loggedContext(browser, "cashierA");
  // window.print() é um stub: registra a chamada e o HTML do documento térmico que estaria sendo impresso.
  await cashierCtx.addInitScript(() => {
    (window as any).__prints = [];
    window.print = () => {
      const doc = document.querySelector(".tp-print-only");
      (window as any).__prints.push({ text: (doc as HTMLElement | null)?.innerText ?? null, sheets: document.querySelectorAll(".tp-sheet").length });
    };
  });
  cashier = await newPage(cashierCtx);
  kitchen = await newPage(await loggedContext(browser, "kitchenA"));
  owner = await newPage(await loggedContext(browser, "ownerA"));
  await kitchen.goto(`${BASE}/operacao/${SLUG}/cozinha`);
  await kitchen.getByRole("heading", { name: "Cozinha" }).waitFor();
  await cashier.goto(`${BASE}/operacao/${SLUG}/pedidos`);
  await cashier.getByRole("tab", { name: /Novos/ }).waitFor();
  const { data } = await db().from("restaurant_tables").select("id").eq("restaurant_id", RID).eq("name", TABLE).single();
  tableId = data.id;
});

afterAll(async () => {
  await cleanupE2eData();
  await browser?.close();
});

async function addItem(p: Page, product: string, opts: { modifier?: string } = {}) {
  await p.getByRole("button", { name: "Adicionar itens" }).first().click();
  const dlg = p.getByRole("dialog", { name: "Adicionar itens" });
  await dlg.getByRole("button", { name: new RegExp(product) }).first().click();
  if (opts.modifier) await dlg.getByLabel(new RegExp(opts.modifier)).check();
  await dlg.getByRole("button", { name: /Adicionar ao pedido/ }).click();
  await dlg.getByRole("button", { name: "Enviar para a cozinha" }).click();
  await p.getByRole("dialog", { name: "Enviar pedido para a cozinha?" }).getByRole("button", { name: "Enviar pedido" }).click();
  await dlg.waitFor({ state: "hidden", timeout: 30_000 });
}

describe("E2E 3 - DINE_IN (salão, comanda, pagamento, conta)", () => {
  it("garçom abre a comanda na mesa (mesa vai a Ocupada)", async () => {
    await waiter.goto(`${BASE}/operacao/${SLUG}/mesas`);
    const card = waiter.locator("li").filter({ has: waiter.getByRole("heading", { name: TABLE }) }).first();
    await card.getByRole("button", { name: "Abrir comanda" }).click();
    await waiter.getByLabel("Nome do cliente (opcional)").fill(LABEL);
    await waiter.getByLabel("Número de pessoas (opcional)").fill("2");
    await waiter.getByRole("dialog").getByRole("button", { name: "Abrir comanda" }).click();
    await waiter.waitForURL(/comandas\//);
    tabId = waiter.url().split("/").pop()!;
    await waiter.getByRole("heading", { name: new RegExp(TABLE) }).first().waitFor();
    const { data: tab } = await db().from("tabs").select("status,table_id,label").eq("id", tabId).single();
    expect(tab).toMatchObject({ status: "OPEN", table_id: tableId, label: LABEL });
    const { data: t } = await db().from("restaurant_tables").select("status").eq("id", tableId).single();
    expect(t.status).toBe("OCCUPIED");
  });

  it("garçom lança 2 pedidos de salão; a cozinha os recebe sem recarregar", async () => {
    await addItem(waiter, "X-Burger", { modifier: "Bacon" });
    await addItem(waiter, "Refrigerante");
    const { data } = await db().from("orders").select("order_number,status,fulfillment_type,source,total_cents,table_label").eq("tab_id", tabId).order("order_number");
    expect(data).toHaveLength(2);
    for (const o of data) expect(o).toMatchObject({ fulfillment_type: "DINE_IN", source: "STAFF" });
    expect(data.map((o: any) => o.total_cents).sort((a: number, b: number) => a - b)).toEqual([600, 3000]);
    orderNumbers = data.map((o: any) => o.order_number);
    for (const n of orderNumbers) await orderCard(kitchen, n).waitFor(LONG);
  });

  it("cozinha prepara e marca pronto os dois; caixa marca Servido", async () => {
    for (const n of orderNumbers) {
      const card = orderCard(kitchen, n);
      const start = card.getByRole("button", { name: "Iniciar preparo" });
      if (await start.count()) await start.click();
      await orderCard(kitchen, n).getByRole("button", { name: "Marcar pronto" }).click();
    }
    for (const n of orderNumbers) {
      await orderCard(cashier, n).getByRole("button", { name: "Servido" }).click();
    }
    await expect
      .poll(async () => (await db().from("orders").select("status").eq("tab_id", tabId)).data!.map((o: any) => o.status).join(), { timeout: 30_000 })
      .toBe("COMPLETED,COMPLETED");
  });

  it("caixa registra pagamentos parciais (dinheiro com troco e Pix)", async () => {
    await cashier.goto(`${BASE}/operacao/${SLUG}/comandas/${tabId}`);
    await cashier.getByRole("heading", { name: "Registrar pagamento" }).waitFor(LONG).catch(() => undefined);
    const form = cashier.getByRole("form", { name: "Registrar pagamento" });
    await form.waitFor(LONG);
    await form.locator("label").filter({ hasText: "Dinheiro" }).first().click();
    await form.getByLabel("Valor (R$)").fill("20,00");
    await form.getByLabel("Valor recebido (R$)").fill("50,00");
    await form.getByText(/Troco a devolver:\s*R\$\s*30,00/).waitFor();
    await form.getByRole("button", { name: /Registrar R\$\s*20,00/ }).click();
    await cashier.getByText("Nenhum pagamento registrado nesta comanda.").waitFor({ state: "hidden", timeout: 30_000 });
    await form.locator("label").filter({ hasText: "Pix" }).first().click();
    await form.getByLabel("Valor (R$)").fill("6,00");
    await form.getByRole("button", { name: /Registrar R\$\s*6,00/ }).click();
    await expect
      .poll(async () => (await db().from("payments").select("id").eq("tab_id", tabId)).data?.length, { timeout: 30_000 })
      .toBe(2);
    const { data } = await db().from("payments").select("method,amount_cents,status").eq("tab_id", tabId).order("amount_cents");
    expect(data).toMatchObject([{ method: "PIX", amount_cents: 600, status: "PAID" }, { method: "CASH", amount_cents: 2000, status: "PAID" }]);
  });

  it("fechar com saldo é bloqueado/exige justificativa; conta parcial vira job DISPATCHED (nunca PRINTED)", async () => {
    const close = cashier.getByRole("button", { name: "Fechar comanda" }).first();
    await expect(close.isDisabled()).resolves.toBe(true);
    await cashier.getByRole("button", { name: "Fechar com saldo em aberto" }).click();
    const dlg = cashier.getByRole("dialog");
    await dlg.getByRole("textbox", { name: /Justificativa/ }).fill("x");
    await expect(dlg.getByRole("button", { name: "Fechar mesmo assim" }).isDisabled()).resolves.toBe(true); // justificativa curta demais
    expect((await db().from("tabs").select("status").eq("id", tabId).single()).data!.status).toBe("OPEN");
    await dlg.getByRole("button", { name: "Voltar" }).click();

    await cashier.getByRole("button", { name: "Conta parcial" }).click();
    await cashier.getByRole("dialog").getByRole("button", { name: /Enviar para impressão/ }).click();
    await expect
      .poll(async () => (await db().from("print_jobs").select("status,document_type").eq("tab_id", tabId)).data?.map((j: any) => `${j.document_type}:${j.status}`).join(), { timeout: 30_000 })
      .toBe("PARTIAL_BILL:DISPATCHED");
    const prints = await cashier.evaluate(() => (window as any).__prints);
    expect(prints).toHaveLength(1);
    expect(prints[0].sheets).toBeGreaterThan(0);
    expect(prints[0].text).toMatch(/DEMO Restaurante A/);
    expect(prints[0].text).toMatch(/Conta parcial|CONTA PARCIAL/i);
    await cashier.getByText(/diálogo de impressão|enviado|aberto/i).first().waitFor().catch(() => undefined);
    await cashier.getByRole("dialog").getByRole("button", { name: "Fechar" }).first().click();
  });

  it("caixa paga o restante e fecha a comanda; mesa vai a Em limpeza e é liberada", async () => {
    const form = cashier.getByRole("form", { name: "Registrar pagamento" });
    await form.locator("label").filter({ hasText: "Débito" }).first().click();
    await form.getByRole("button", { name: /Registrar R\$\s*10,00/ }).click();
    await expect
      .poll(async () => (await db().from("payments").select("amount_cents").eq("tab_id", tabId)).data?.length, { timeout: 30_000 })
      .toBe(3);
    await cashier.getByRole("button", { name: "Fechar comanda" }).first().click();
    await cashier.getByRole("dialog").getByRole("button", { name: "Fechar comanda" }).click();
    await expect
      .poll(async () => (await db().from("tabs").select("status").eq("id", tabId).single()).data!.status, { timeout: 30_000 })
      .toBe("CLOSED");
    expect((await db().from("restaurant_tables").select("status").eq("id", tableId).single()).data!.status).toBe("CLEANING");

    await cashier.goto(`${BASE}/operacao/${SLUG}/mesas`);
    const card = cashier.locator("li").filter({ has: cashier.getByRole("heading", { name: TABLE }) }).first();
    await card.getByText("Em limpeza").first().waitFor(LONG);
    await card.getByRole("button", { name: "Liberar mesa" }).click();
    await expect
      .poll(async () => (await db().from("restaurant_tables").select("status").eq("id", tableId).single()).data!.status, { timeout: 30_000 })
      .toBe("AVAILABLE");
  });

  it("conta final impressa após o fechamento: documento térmico renderiza e o job fica DISPATCHED", async () => {
    await cashier.goto(`${BASE}/operacao/${SLUG}/comandas/${tabId}`);
    await cashier.getByRole("button", { name: "Conta final" }).click();
    await cashier.getByRole("dialog").getByRole("button", { name: /Enviar para impressão/ }).click();
    await expect
      .poll(async () => (await db().from("print_jobs").select("status").eq("tab_id", tabId).eq("document_type", "FINAL_BILL")).data?.map((j: any) => j.status).join(), { timeout: 30_000 })
      .toBe("DISPATCHED");
    const prints = await cashier.evaluate(() => (window as any).__prints);
    expect(prints.length).toBeGreaterThanOrEqual(1);
    expect(prints.at(-1).text).toMatch(/DEMO Restaurante A/);
    const { data: jobs } = await db().from("print_jobs").select("status,printed_at").eq("tab_id", tabId);
    expect(jobs!.every((j: any) => j.status !== "PRINTED" && j.printed_at === null)).toBe(true);
  });

  it("owner.a vê a comanda SOMENTE LEITURA em /app/comandas", async () => {
    await owner.goto(`${BASE}/app/${SLUG}/comandas`);
    await owner.getByText(LABEL).first().waitFor(LONG);
    await owner.goto(`${BASE}/app/${SLUG}/comandas/${tabId}`);
    await owner.getByText(LABEL).first().waitFor(LONG);
    for (const op of ["Registrar", "Fechar comanda", "Cancelar comanda", "Adicionar itens", "Conta parcial", "Conta final", "Liberar"]) {
      expect(await owner.getByRole("button", { name: new RegExp(op) }).count(), op).toBe(0);
    }
  });
});
