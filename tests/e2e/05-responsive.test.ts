import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import type { AccountKey } from "../fixtures/accounts";
import { BASE, SLUG, anonContext, launch, loggedContext, newPage, serverUp } from "./helpers";

const VIEWPORTS = [
  { name: "mobile 375", width: 375, height: 812 },
  { name: "tablet 768", width: 768, height: 1024 },
  { name: "desktop 1280", width: 1280, height: 800 },
] as const;

let browser: Browser;

beforeAll(async () => {
  if (!(await serverUp())) throw new Error(`Dev server fora do ar em ${BASE}`);
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

async function overflow(p: Page) {
  return p.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

async function noOverflow(p: Page, where: string) {
  await p.waitForLoadState("networkidle").catch(() => undefined);
  await p.waitForTimeout(600);
  const o = await overflow(p);
  expect(o.scrollWidth, `${where}: documentElement.scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`).toBeLessThanOrEqual(o.innerWidth);
  expect(o.bodyScrollWidth, `${where}: body.scrollWidth`).toBeLessThanOrEqual(o.innerWidth);
}

describe.each(VIEWPORTS)("E2E 5 - responsividade em $name", (vp) => {
  it("vitrine, produto e checkout sem overflow horizontal", async () => {
    const ctx = await anonContext(browser, { viewport: { width: vp.width, height: vp.height } });
    const p = await newPage(ctx);
    await p.goto(`${BASE}/r/${SLUG}`);
    await p.getByRole("link", { name: /X-Burger/ }).first().waitFor();
    await noOverflow(p, `vitrine @${vp.width}`);
    await p.getByRole("link", { name: /X-Burger/ }).first().click();
    await p.waitForURL(/\/produto\//);
    await p.getByRole("button", { name: /Adicionar ao carrinho/ }).waitFor();
    await noOverflow(p, `produto @${vp.width}`);
    await p.getByLabel(/Bacon/).check();
    await p.getByRole("button", { name: /Adicionar ao carrinho/ }).click();
    await p.getByRole("button", { name: /Ver carrinho/ }).click();
    await p.getByRole("link", { name: "Ir para o checkout" }).waitFor();
    await noOverflow(p, `carrinho @${vp.width}`);
    await p.getByRole("link", { name: "Ir para o checkout" }).click();
    await p.waitForURL(/\/checkout/);
    await p.getByRole("button", { name: /^Enviar pedido/ }).waitFor();
    await p.getByRole("radio", { name: /Entrega/ }).check();
    await noOverflow(p, `checkout entrega @${vp.width}`);
    await ctx.close();
  });

  const AREAS: Array<[AccountKey, string, string]> = [
    ["cashierA", `/operacao/${SLUG}/pedidos`, "pedidos"],
    ["kitchenA", `/operacao/${SLUG}/cozinha`, "cozinha"],
    ["waiterA", `/operacao/${SLUG}/mesas`, "mesas"],
    ["cashierA", `/operacao/${SLUG}/comandas`, "comandas"],
    ["cashierA", `/operacao/${SLUG}/historico`, "histórico"],
    ["ownerA", `/app/${SLUG}/dashboard`, "dashboard do dono"],
    ["ownerA", `/app/${SLUG}/pedidos`, "pedidos do dono"],
  ];
  it("painéis de operação e do dono sem overflow horizontal", async () => {
    for (const [key, path, label] of AREAS) {
      const ctx = await loggedContext(browser, key, { viewport: { width: vp.width, height: vp.height } });
      const p = await newPage(ctx);
      await p.goto(`${BASE}${path}`);
      await p.getByRole("main").waitFor({ timeout: 30_000 });
      await p.waitForURL(new RegExp(path.replace(/\//g, "\\/")), { timeout: 30_000 });
      await noOverflow(p, `${label} @${vp.width}`);
      await ctx.close();
    }
  });

  it("navegação: barra inferior (mobile/tablet) ou menu lateral (desktop) leva às outras telas", async () => {
    const ctx = await loggedContext(browser, "cashierA", { viewport: { width: vp.width, height: vp.height } });
    const p = await newPage(ctx);
    await p.goto(`${BASE}/operacao/${SLUG}/pedidos`);
    const bottom = p.locator("nav.fixed");
    const side = p.locator("aside nav");
    if (vp.width < 1024) {
      await bottom.waitFor({ state: "visible", timeout: 30_000 });
      expect(await side.isVisible()).toBe(false);
      await bottom.getByRole("link", { name: /Cozinha/ }).click();
      await p.waitForURL(/\/cozinha/);
      await p.getByRole("heading", { name: "Cozinha" }).waitFor();
      // menu "Mais" (gaveta), quando a barra não comporta todos os itens
      const more = bottom.getByRole("button");
      if (await more.count()) {
        await more.first().click();
        await p.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: /Histórico/ }).click();
        await p.waitForURL(/\/historico/);
      } else {
        await bottom.getByRole("link", { name: /Hist[óo]rico/ }).click();
        await p.waitForURL(/\/historico/);
      }
    } else {
      await side.waitFor({ state: "visible", timeout: 30_000 });
      expect(await bottom.isVisible()).toBe(false);
      await side.getByRole("link", { name: /Cozinha/ }).click();
      await p.waitForURL(/\/cozinha/);
      await side.getByRole("link", { name: /Hist[óo]rico/ }).click();
      await p.waitForURL(/\/historico/);
    }
    await noOverflow(p, `histórico após navegar @${vp.width}`);
    await ctx.close();
  });

  it("navegação do painel do dono (gaveta 'Menu' no mobile) funciona", async () => {
    const ctx = await loggedContext(browser, "ownerA", { viewport: { width: vp.width, height: vp.height } });
    const p = await newPage(ctx);
    await p.goto(`${BASE}/app/${SLUG}/dashboard`);
    if (vp.width < 1024) {
      const bottom = p.locator("nav.fixed");
      await bottom.waitFor({ state: "visible", timeout: 30_000 });
      await bottom.getByRole("button").first().click();
      await p.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: /Configurações/ }).click();
    } else {
      await p.locator("aside nav").getByRole("link", { name: /Configurações/ }).click();
    }
    await p.waitForURL(/\/configuracoes/, { timeout: 30_000 });
    await noOverflow(p, `configurações @${vp.width}`);
    await ctx.close();
  });
});
