import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Request } from "playwright-core";
import {
  BASE, db, RID, SLUG, TAG, anonContext, cleanupE2eData, fillCheckout, launch, loggedContext, newPage, serverUp, uniq,
} from "./helpers";

let browser: Browser;

beforeAll(async () => {
  if (!(await serverUp())) throw new Error(`Dev server fora do ar em ${BASE}`);
  await cleanupE2eData();
  browser = await launch();
});
afterAll(async () => {
  await cleanupE2eData();
  await browser?.close();
});

describe("E2E 6 - idempotência e duplo clique", () => {
  it("duplo clique (mesmo tick) em 'Enviar pedido' cria um único pedido", async () => {
    const page = await newPage(await anonContext(browser));
    const name = `${TAG} duplo ${uniq()}`;
    const submit = await fillCheckout(page, { fulfillment: "PICKUP", name, payment: "PIX" });
    const handle = await submit.elementHandle();
    await page.evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    }, handle);
    await page.waitForURL(/\/pedido\//, { timeout: 60_000 });
    await page.waitForTimeout(1500);
    const { data } = await db().from("orders").select("id").eq("restaurant_id", RID).eq("customer_name", name);
    expect(data).toHaveLength(1);
  });

  it("dois cliques rápidos (dblclick real) criam um único pedido", async () => {
    const page = await newPage(await anonContext(browser));
    const name = `${TAG} dblclick ${uniq()}`;
    const submit = await fillCheckout(page, { fulfillment: "PICKUP", name, payment: "CASH" });
    await submit.dblclick().catch(() => undefined); // o 2º clique pode cair na página já navegada
    await page.waitForURL(/\/pedido\//, { timeout: 60_000 });
    await page.waitForTimeout(1500);
    const { data } = await db().from("orders").select("id").eq("restaurant_id", RID).eq("customer_name", name);
    expect(data).toHaveLength(1);
  });

  it("lançamento de salão: duplo clique na confirmação e replay da mesma chave criam um único pedido", async () => {
    const label = `${TAG} idem ${uniq()}`;
    const waiter = await newPage(await loggedContext(browser, "waiterA"));
    const calls: Request[] = [];
    waiter.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/rpc/create_staff_order")) calls.push(r);
    });
    await waiter.goto(`${BASE}/operacao/${SLUG}/mesas`);
    const card = waiter.locator("li").filter({ has: waiter.getByRole("heading", { name: "DEMO Mesa 5" }) }).first();
    await card.getByRole("button", { name: "Abrir comanda" }).click();
    await waiter.getByLabel("Nome do cliente (opcional)").fill(label);
    await waiter.getByRole("dialog").getByRole("button", { name: "Abrir comanda" }).click();
    await waiter.waitForURL(/comandas\//);
    const tabId = waiter.url().split("/").pop()!;

    await waiter.getByRole("button", { name: "Adicionar itens" }).first().click();
    const dlg = waiter.getByRole("dialog", { name: "Adicionar itens" });
    await dlg.getByRole("button", { name: /Refrigerante/ }).first().click();
    await dlg.getByRole("button", { name: /Adicionar ao pedido/ }).click();
    await dlg.getByRole("button", { name: "Enviar para a cozinha" }).click();
    const confirmBtn = waiter.getByRole("dialog", { name: "Enviar pedido para a cozinha?" }).getByRole("button", { name: "Enviar pedido" });
    const handle = await confirmBtn.elementHandle();
    await waiter.evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    }, handle);
    await dlg.waitFor({ state: "hidden", timeout: 30_000 });
    await waiter.waitForTimeout(1000);
    const { data } = await db().from("orders").select("id").eq("tab_id", tabId);
    expect(data, "duplo clique").toHaveLength(1);

    // Replay do MESMO corpo (mesma chave de idempotência) pelo contexto autenticado do navegador.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const req = calls[0];
    const status = await waiter.evaluate(
      async ({ url, headers, body }) => {
        const r = await fetch(url, { method: "POST", headers, body });
        return { status: r.status, text: await r.text() };
      },
      { url: req.url(), headers: await req.allHeaders(), body: req.postData() },
    );
    expect(status.status).toBeLessThan(300);
    expect(status.text).toMatch(/idempotent_replay/);
    const { data: after } = await db().from("orders").select("id").eq("tab_id", tabId);
    expect(after, "replay").toHaveLength(1);
  });
});
