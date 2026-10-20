/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Helpers dos testes E2E com navegador real (playwright-core). Um navegador por arquivo, um CONTEXTO isolado por
 * papel (cookies/sessão próprios). Dados efêmeros usam o prefixo "zz-e2e" e são apagados via service role.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ACCOUNTS, DEMO_RESTAURANTS, TEST_PASSWORD, type AccountKey } from "../fixtures/accounts";
import { admin } from "../helpers/clients";

/** Cliente service role sem tipos de linha (as tabelas não têm tipos gerados nos testes). */
export const db = (): any => admin();

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
export const SLUG = DEMO_RESTAURANTS.a.slug;
export const RID = DEMO_RESTAURANTS.a.id;
export const TAG = "zz-e2e";
export const ARTIFACTS = path.resolve(__dirname, ".artifacts");
const STATE_DIR = path.resolve(__dirname, "../../node_modules/.cache/e2e-state");

function findChromium(): string | undefined {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  const root = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.HOME ?? "", ".cache"), "ms-playwright");
  try {
    const dirs = fs.readdirSync(root).sort().reverse();
    for (const prefix of ["chromium_headless_shell-", "chromium-"]) {
      for (const d of dirs.filter((x) => x.startsWith(prefix))) {
        for (const sub of fs.readdirSync(path.join(root, d))) {
          for (const exe of ["chrome-headless-shell.exe", "chrome.exe", "chrome-headless-shell", "chrome"]) {
            const f = path.join(root, d, sub, exe);
            if (fs.existsSync(f)) return f;
          }
        }
      }
    }
  } catch {
    /* usa o canal padrão */
  }
  return undefined;
}

const livePages = new Set<Page>();

export async function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: findChromium(), headless: true });
}

export async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/r/${SLUG}`, { signal: AbortSignal.timeout(8000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

export async function newPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(60_000);
  livePages.add(page);
  page.on("close", () => livePages.delete(page));
  return page;
}

export async function saveFailureShots(name: string) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  let i = 0;
  for (const p of livePages) {
    try {
      await p.screenshot({ path: path.join(ARTIFACTS, `${name.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}-${i++}.png`) });
    } catch {
      /* página fechada */
    }
  }
}

/** Contexto anônimo (cliente sem login). */
export async function anonContext(browser: Browser, opts: Parameters<Browser["newContext"]>[0] = {}) {
  // O limite de pedidos (5 / 10 min, em memória) é por IP: cada cliente simulado usa um IP de teste próprio (198.18.0.0/15).
  const ip = `198.18.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  return browser.newContext({
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    extraHTTPHeaders: { "x-forwarded-for": ip },
    ...opts,
  });
}

/** Contexto logado como a conta (login real pela tela /login; estado em cache por 30 min p/ respeitar o rate limit do Auth). */
export async function loggedContext(browser: Browser, key: AccountKey, opts: Parameters<Browser["newContext"]>[0] = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, `${key}.json`);
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 30 * 60_000;
  const base = { locale: "pt-BR", timezoneId: "America/Sao_Paulo", ...opts };
  if (fresh) {
    const ctx = await browser.newContext({ ...base, storageState: file });
    const page = await newPage(ctx);
    const resp = await page.goto(`${BASE}/login`);
    // Logado, /login redireciona para fora; senão o estado caducou.
    if (!/\/login/.test(page.url()) && resp) {
      await page.close();
      return ctx;
    }
    await ctx.close();
  }
  const ctx = await browser.newContext(base);
  const page = await newPage(ctx);
  await page.goto(`${BASE}/login`);
  await page.getByLabel("E-mail").fill(ACCOUNTS[key].email);
  await page.getByLabel("Senha", { exact: false }).first().fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 60_000 });
  await ctx.storageState({ path: file });
  await page.close();
  return ctx;
}

export const money = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/ /g, " ");

/** Pedidos/comandas efêmeros do E2E (cliente `zz-e2e ...`) apagados via service role. */
export async function cleanupE2eData() {
  const a = db();
  const { data: orders } = await a.from("orders").select("id").eq("restaurant_id", RID).ilike("customer_name", `${TAG}%`);
  const ids = (orders ?? []).map((o: any) => o.id);
  const { data: tabs } = await a.from("tabs").select("id,table_id").eq("restaurant_id", RID).ilike("label", `${TAG}%`);
  const tabIds = (tabs ?? []).map((t: any) => t.id);
  if (tabIds.length) {
    const { data: tabOrders } = await a.from("orders").select("id").in("tab_id", tabIds);
    ids.push(...(tabOrders ?? []).map((o: any) => o.id));
  }
  if (ids.length) {
    await a.from("print_jobs").delete().in("order_id", ids);
    await a.from("payments").delete().in("order_id", ids);
  }
  if (tabIds.length) {
    await a.from("print_jobs").delete().in("tab_id", tabIds);
    await a.from("payments").delete().in("tab_id", tabIds);
  }
  if (ids.length) {
    await a.from("order_status_history").delete().in("order_id", ids);
    await a.from("orders").delete().in("id", [...new Set(ids)]);
  }
  if (tabIds.length) await a.from("tabs").delete().in("id", tabIds);
  // Mesas usadas: volta a AVAILABLE (o seed também restaura).
  for (const t of tabs ?? []) {
    if (t.table_id) await a.from("restaurant_tables").update({ status: "AVAILABLE" }).eq("id", t.table_id);
  }
  await a.from("customers").delete().eq("restaurant_id", RID).ilike("name", `${TAG}%`);
}

/** Depuração: escreve direto no stderr (o vitest engole console.log de testes que passam). */
export function say(...a: unknown[]) {
  fs.writeSync(2, "\n" + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
}
export async function controls(page: Page, scope = "body") {
  return page.evaluate((s) =>
    [...document.querySelector(s)!.querySelectorAll("input,select,button,textarea,a[href]")]
      .map((e: any) => `${e.tagName}:${e.type ?? ""}:${e.getAttribute("href") ?? ""}:${(e.getAttribute("aria-label") || e.innerText || e.id || "").slice(0, 50).replace(/\n/g, " ")}`)
      .join("\n"), scope);
}

export const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export type PlaceOpts = {
  fulfillment: "DELIVERY" | "PICKUP" | "DINE_IN";
  name: string;
  payment?: "CASH" | "PIX" | "CARD";
  changeFor?: string;
  /** Adiciona o adicional "Bacon" do X-Burger (padrão: sim). */
  withModifier?: boolean;
};

/** Vitrine -> produto -> carrinho -> checkout preenchido. Devolve o botão de envio. */
export async function fillCheckout(page: Page, o: PlaceOpts) {
  await page.goto(`${BASE}/r/${SLUG}`);
  await page.getByRole("link", { name: /X-Burger/ }).first().click();
  await page.waitForURL(/\/produto\//);
  if (o.withModifier !== false) await page.getByLabel(/Bacon/).check();
  await page.getByRole("button", { name: /Adicionar ao carrinho/ }).click();
  await page.getByRole("button", { name: /Ver carrinho/ }).click();
  await page.getByRole("link", { name: "Ir para o checkout" }).click();
  await page.waitForURL(/\/checkout/);
  const labels = { DELIVERY: "Entrega", PICKUP: "Retirada", DINE_IN: "Consumo no local" } as const;
  await page.getByRole("radio", { name: new RegExp(labels[o.fulfillment]) }).check();
  await page.getByLabel("Nome", { exact: false }).first().fill(o.name);
  await page.getByLabel("Telefone com DDD").fill("11987654321");
  if (o.fulfillment === "DELIVERY") {
    const zone = page.getByLabel("Região de entrega");
    const opt = await zone.locator("option").nth(1).getAttribute("value");
    await zone.selectOption(opt!);
    await page.getByLabel("CEP").fill("01310100");
    await page.getByLabel("Rua").fill("Rua E2E");
    await page.locator(`input[id$="-number"]`).fill("42");
    await page.getByLabel("Bairro").fill("Centro");
    await page.getByLabel("Cidade").fill("Sao Paulo");
  }
  const pay = o.payment ?? "CASH";
  await page.locator(`input[id$="-payment-${pay}"]`).check();
  if (pay === "CASH" && o.changeFor) await page.getByLabel(/Precisa de troco/).fill(o.changeFor);
  // espera a cotação (o botão ganha o total)
  const submit = page.getByRole("button", { name: /^Enviar pedido \(R\$/ });
  await submit.waitFor();
  return submit;
}

/** Cria o pedido pela vitrine e devolve o número lido da página de acompanhamento. */
export async function placeOrder(page: Page, o: PlaceOpts): Promise<{ number: number; url: string }> {
  const submit = await fillCheckout(page, o);
  await submit.click();
  await page.waitForURL(/\/pedido\//, { timeout: 60_000 });
  const h1 = await page.getByRole("heading", { level: 1 }).innerText();
  return { number: Number(/(\d+)/.exec(h1)![1]), url: page.url() };
}

/** Cartão de pedido no quadro de operação (caixa) / cozinha pelo número. */
export function orderCard(page: Page, n: number) {
  return page.locator("li").filter({ has: page.getByText(`#${n}`, { exact: true }) });
}

export async function stampNoReload(page: Page) {
  await page.evaluate(() => ((window as any).__e2eStamp = 1));
}
export async function assertNoReload(page: Page) {
  return page.evaluate(() => (window as any).__e2eStamp === 1);
}
