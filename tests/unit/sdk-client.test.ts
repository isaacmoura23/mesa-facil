import { describe, expect, it, vi } from "vitest";
import { createStorefrontClient, StorefrontApiError } from "../../sdk/src/index";
import type { FetchLike, QuoteInput } from "../../sdk/src/index";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const make = (fetchImpl: FetchLike, extra: { timeoutMs?: number } = {}) =>
  createStorefrontClient({
    baseUrl: "https://app.example.com/",
    slug: "la-pastelaria",
    fetch: fetchImpl,
    ...extra,
  });

const U = "00000000-0000-4000-8000-000000000004";
const input: QuoteInput = {
  fulfillmentType: "PICKUP",
  items: [{ productId: U, variantId: null, quantity: 2, modifierIds: [] }],
};

async function failure(promise: Promise<unknown>): Promise<StorefrontApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StorefrontApiError);
    return error as StorefrontApiError;
  }
  throw new Error("era esperado falhar");
}

describe("createStorefrontClient", () => {
  it("getMenu: GET na URL v1 (sem barra dupla), só Accept, devolve data", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => json({ data: { isOpenNow: true, categories: [] } }));
    const menu = await make(fetchMock).getMenu();
    expect(menu).toEqual({ isOpenNow: true, categories: [] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/public/v1/restaurants/la-pastelaria/menu");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ Accept: "application/json" });
    expect(init?.body).toBeUndefined();
  });

  it("quoteCart: POST JSON com o corpo do carrinho", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => json({ data: { ok: true, errors: [], items: [] } }));
    const quote = await make(fetchMock).quoteCart(input);
    expect(quote.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/public/v1/restaurants/la-pastelaria/cart/quote");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("codifica o slug na URL", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => json({ data: {} }));
    await createStorefrontClient({ baseUrl: "https://a.com", slug: "a/b c", fetch: fetchMock }).getMenu();
    expect(fetchMock.mock.calls[0][0]).toBe("https://a.com/api/public/v1/restaurants/a%2Fb%20c/menu");
  });

  it("valida baseUrl e slug", () => {
    expect(() => createStorefrontClient({ baseUrl: "", slug: "x" })).toThrow();
    expect(() => createStorefrontClient({ baseUrl: "https://a.com", slug: " " })).toThrow();
  });

  it("erro HTTP vira StorefrontApiError {code,status,message}", async () => {
    const error = await failure(
      make(async () =>
        json({ error: { code: "restaurant_not_found", message: "Restaurante não encontrado." } }, { status: 404 }),
      ).getMenu(),
    );
    expect(error).toMatchObject({
      name: "StorefrontApiError",
      code: "restaurant_not_found",
      status: 404,
      message: "Restaurante não encontrado.",
    });
  });

  it("429 expõe retryAfterSeconds; 400 expõe details", async () => {
    const limited = await failure(
      make(async () =>
        json({ error: { code: "rate_limited", message: "Muitas requisições." } }, { status: 429, headers: { "Retry-After": "42" } }),
      ).quoteCart(input),
    );
    expect(limited).toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: 42 });

    const invalid = await failure(
      make(async () =>
        json({ error: { code: "invalid_request", message: "x", details: [{ path: "items.0.quantity", message: "ruim" }] } }, { status: 400 }),
      ).quoteCart(input),
    );
    expect(invalid.details).toEqual([{ path: "items.0.quantity", message: "ruim" }]);
  });

  it("falha de rede (ex.: CORS bloqueado) => network_error status 0", async () => {
    const error = await failure(
      make(async () => {
        throw new TypeError("Failed to fetch");
      }).getMenu(),
    );
    expect(error).toMatchObject({ code: "network_error", status: 0 });
  });

  it("resposta que não é JSON => invalid_response (200) ou internal_error (erro HTTP)", async () => {
    const ok = await failure(make(async () => new Response("<html>", { status: 200 })).getMenu());
    expect(ok).toMatchObject({ code: "invalid_response", status: 200 });
    const bad = await failure(make(async () => new Response("<html>", { status: 502 })).getMenu());
    expect(bad).toMatchObject({ code: "internal_error", status: 502 });
    const noData = await failure(make(async () => json({ foo: 1 })).getMenu());
    expect(noData.code).toBe("invalid_response");
  });

  it("timeout via AbortController => code timeout", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const error = await failure(make(hang, { timeoutMs: 20 }).getMenu());
    expect(error).toMatchObject({ code: "timeout", status: 0 });
  });

  it("cancelamento pelo chamador => code aborted", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const controller = new AbortController();
    const promise = make(hang).getMenu({ signal: controller.signal });
    controller.abort();
    expect(await failure(promise)).toMatchObject({ code: "aborted", status: 0 });
  });
});
