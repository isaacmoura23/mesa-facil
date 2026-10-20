import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { AccountKey } from "../fixtures/accounts";
import { BASE, SLUG, anonContext, launch, loggedContext, newPage, serverUp } from "./helpers";

let browser: Browser;
const ctxs = new Map<string, BrowserContext>();

async function pageFor(key: AccountKey | "anon"): Promise<Page> {
  let ctx = ctxs.get(key);
  if (!ctx) {
    ctx = key === "anon" ? await anonContext(browser) : await loggedContext(browser, key);
    ctxs.set(key, ctx);
  }
  return newPage(ctx);
}

/** O Next transmite o shell (loading) antes do redirect do servidor: aguarda a URL/estado final. */
async function visit(p: Page, path: string) {
  await p.goto(`${BASE}${path}`);
}

beforeAll(async () => {
  if (!(await serverUp())) throw new Error(`Dev server fora do ar em ${BASE}`);
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

describe("E2E 4 - controle de acesso no navegador", () => {
  it.each(["/operacao/demo-a/pedidos", `/app/${SLUG}/dashboard`, "/platform/dashboard"])(
    "sem login %s redireciona para /login preservando o destino",
    async (path) => {
      const p = await pageFor("anon");
      await visit(p, path);
      await p.waitForURL(/\/login\?next=/, { timeout: 30_000 });
      expect(decodeURIComponent(new URL(p.url()).searchParams.get("next")!)).toBe(path);
      await p.getByRole("button", { name: "Entrar" }).waitFor();
      await p.close();
    },
  );

  it("owner.a em /operacao é redirecionado para o painel /app (nunca opera)", async () => {
    const p = await pageFor("ownerA");
    await visit(p, `/operacao/${SLUG}/pedidos`);
    await p.waitForURL(new RegExp(`/app/${SLUG}/`), { timeout: 30_000 });
    expect(p.url()).not.toContain("/operacao");
    expect(await p.getByRole("button", { name: /^(Aceitar|Recusar|Iniciar preparo)$/ }).count()).toBe(0);
    await p.close();
  });

  it("cashier.a em /app é redirecionado para /operacao; em /platform recebe 404 sem dados", async () => {
    const p = await pageFor("cashierA");
    await visit(p, `/app/${SLUG}/dashboard`);
    await p.waitForURL(new RegExp(`/operacao/${SLUG}/`), { timeout: 30_000 });
    await visit(p, "/platform/dashboard");
    await p.getByText("Página não encontrada").waitFor({ timeout: 30_000 });
    expect(await p.getByText("Restaurantes por situação").count()).toBe(0);
    await visit(p, `/app/${SLUG}/equipe`);
    await p.waitForURL(new RegExp(`/operacao/${SLUG}/`), { timeout: 30_000 });
    await p.close();
  });

  it("superadmin em /platform vê o dashboard com ações de escrita", async () => {
    const p = await pageFor("superadmin");
    await visit(p, "/platform/dashboard");
    await p.getByText("Restaurantes por situação").waitFor({ timeout: 30_000 });
    await visit(p, "/platform/restaurants");
    await p.getByRole("button", { name: "Novo restaurante" }).waitFor();
    expect(await p.getByRole("button", { name: "Novo restaurante" }).isEnabled()).toBe(true);
    await p.close();
  });

  it("manager.a não vê Equipe no menu e é barrado em /app/equipe", async () => {
    const p = await pageFor("managerA");
    await visit(p, `/app/${SLUG}/dashboard`);
    await p.getByRole("link", { name: /Configurações/ }).first().waitFor({ timeout: 30_000 });
    expect(await p.getByRole("link", { name: /^Equipe/ }).count()).toBe(0);
    await visit(p, `/app/${SLUG}/equipe`);
    await p.waitForURL(/\/sem-acesso/, { timeout: 30_000 });
    await p.getByText("Você não tem permissão para esta área").waitFor();
    await p.close();
  });

  it("owner.a vê Equipe no menu (controle positivo)", async () => {
    const p = await pageFor("ownerA");
    await visit(p, `/app/${SLUG}/dashboard`);
    await p.getByRole("link", { name: /^Equipe/ }).first().waitFor({ timeout: 30_000 });
    await p.close();
  });

  it("support.* entra em /platform mas é somente leitura (sem criar restaurante/plano, sem salvar configurações)", async () => {
    const p = await pageFor("support");
    await visit(p, "/platform/dashboard");
    await p.getByText("Restaurantes por situação").waitFor({ timeout: 30_000 });
    await visit(p, "/platform/restaurants");
    await p.getByText(/somente leitura/i).first().waitFor();
    expect(await p.getByRole("button", { name: "Novo restaurante" }).isDisabled()).toBe(true);
    await visit(p, "/platform/plans");
    await p.getByText("Modo somente leitura").waitFor();
    expect(await p.getByRole("button", { name: /Novo plano|Editar o plano/ }).count()).toBe(0);
    await visit(p, "/platform/subscriptions");
    await p.getByText("Modo somente leitura").waitFor();
    expect(await p.getByRole("button", { name: /Alterar a assinatura/ }).count()).toBe(0);
    await visit(p, "/platform/settings");
    await p.getByText("Modo somente leitura").waitFor();
    expect(await p.getByRole("button", { name: "Salvar configurações" }).count()).toBe(0);
    for (const input of await p.locator("main input, main textarea").all()) {
      expect(await input.isDisabled() || (await input.getAttribute("readonly")) !== null).toBe(true);
    }
    await p.close();
  });

  it("usuário de outro restaurante recebe 404 em /operacao e /app de demo-a", async () => {
    const p = await pageFor("cashierB");
    await visit(p, `/operacao/${SLUG}/pedidos`);
    await p.getByText("Este restaurante ou página não existe, ou você não tem vínculo com ele.").waitFor({ timeout: 30_000 });
    expect(await p.getByText("DEMO Cliente A").count()).toBe(0);
    await visit(p, `/app/${SLUG}/dashboard`);
    await p.getByText("Este restaurante ou página não existe, ou você não tem vínculo com ele.").waitFor({ timeout: 30_000 });
    await p.close();
  });
});
