/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 3, módulos puros de src/modules/orders-server: schemas (entrada de pedido), messages (códigos -> PT-BR),
 * tracking (JSON de track_order -> modelo sem PII) e limits (5 pedidos criados / 10 min + teto de tentativas).
 */
import { describe, expect, it } from "vitest";
import { beginOrderAttempt, checkTrackRateLimit, getOrderLimiters, ATTEMPT_LIMIT, ORDER_LIMIT, ORDER_WINDOW_MS, TRACK_LIMIT, TRACK_WINDOW_MS } from "../../src/modules/orders-server/limits";
import { GENERIC_ORDER_ERROR, ORDER_ERROR_MESSAGES, orderErrorMessage } from "../../src/modules/orders-server/messages";
import {
  createOrderBodySchema,
  idempotencyKeySchema,
  IDEMPOTENCY_KEY_PATTERN,
  isPublicCode,
  MAX_ORDER_ITEMS,
  orderSubmissionSchema,
  PAYMENT_METHODS,
  phoneDigits,
  PUBLIC_CODE_PATTERN,
} from "../../src/modules/orders-server/schemas";
import { ORDER_STATUSES, parseTrackedOrder } from "../../src/modules/orders-server/tracking";
import { CART_ERROR_MESSAGES, GENERIC_CART_ERROR } from "../../src/modules/storefront/messages";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KEY = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const valid = (over: Record<string, unknown> = {}) => ({
  fulfillmentType: "PICKUP",
  items: [{ productId: U(1), quantity: 2 }],
  customer: { name: "Maria Souza", phone: "(11) 91234-5678" },
  payment: { method: "PIX" },
  ...over,
});
const issues = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`);

describe("idempotencyKeySchema", () => {
  it("aceita 16 a 100 caracteres [A-Za-z0-9_-] (UUID serve)", () => {
    for (const k of [KEY, "a".repeat(16), "A_b-C".repeat(20), "x".repeat(100), "0".repeat(16)]) {
      expect(idempotencyKeySchema.safeParse(k).success, k).toBe(true);
      expect(IDEMPOTENCY_KEY_PATTERN.test(k)).toBe(true);
    }
  });
  it("recusa curta, longa, espaço, unicode, símbolos e não-string", () => {
    for (const k of ["", "curta", "a".repeat(15), "a".repeat(101), `${KEY} `, "chavé-ção-1234567890", "a/b/c/d/e/f/g/h/i/j", "a.b.c.d.e.f.g.h.i.j", "emoji-😀-1234567890", "a\nb-1234567890123456"]) {
      expect(idempotencyKeySchema.safeParse(k).success, JSON.stringify(k)).toBe(false);
    }
    for (const k of [null, undefined, 123, {}, []]) expect(idempotencyKeySchema.safeParse(k).success).toBe(false);
  });
  it("o padrão do app é MAIS estrito que o do banco (16-100 [A-Za-z0-9_-] x 8-200 ASCII visível): nada que o app aceita é recusado pelo banco", () => {
    const db = /^[!-~]{8,200}$/;
    for (const k of [KEY, "a".repeat(16), "A_b-C".repeat(20), "x".repeat(100)]) expect(db.test(k)).toBe(true);
  });
});

describe("createOrderBodySchema / orderSubmissionSchema", () => {
  it("pedido mínimo válido; chave opcional no corpo (pode vir no header) e obrigatória na entrada final do serviço", () => {
    const body = createOrderBodySchema.safeParse(valid());
    expect(body.success, issues(body).join("; ")).toBe(true);
    expect(body.data!.items[0].modifierIds).toEqual([]); // default
    expect(orderSubmissionSchema.safeParse(valid()).success).toBe(false);
    expect(orderSubmissionSchema.safeParse(valid({ idempotencyKey: KEY })).success).toBe(true);
    expect(createOrderBodySchema.safeParse(valid({ idempotencyKey: "curta" })).success).toBe(false);
  });

  it("campos de preço/total forjados são DESCARTADOS (strip), nunca chegam ao serviço", () => {
    const r = createOrderBodySchema.safeParse(
      valid({ totalCents: 1, discountCents: 99999, items: [{ productId: U(1), quantity: 1, priceCents: 1, unitPriceCents: 1 }], payment: { method: "PIX", priceCents: 1 } }),
    );
    expect(r.success).toBe(true);
    const text = JSON.stringify(r.data);
    expect(text).not.toMatch(/totalCents|discountCents|priceCents|unitPriceCents/);
  });

  it("cliente: nome 2-80 (aparado), telefone BR válido, e-mail opcional/vazio ou válido", () => {
    const c = (customer: unknown) => createOrderBodySchema.safeParse(valid({ customer }));
    expect(c({ name: "  Ab  ", phone: "(11) 91234-5678" }).data?.customer.name).toBe("Ab");
    expect(c({ name: "A", phone: "(11) 91234-5678" }).success).toBe(false);
    expect(c({ name: "x".repeat(81), phone: "(11) 91234-5678" }).success).toBe(false);
    expect(c({ name: "x".repeat(80), phone: "(11) 91234-5678" }).success).toBe(true);
    for (const phone of ["", "123", "11912345678", "(11) 91234-5678", "(11) 3123-4567", "+55 (11) 91234-5678".slice(4)]) {
      const ok = c({ name: "Maria", phone }).success;
      expect(ok, phone).toBe(["11912345678", "(11) 91234-5678", "(11) 3123-4567", "(11) 91234-5678"].includes(phone));
    }
    for (const phone of ["(10) 91234-5678", "(11) 81234-5678", "(11) 1234-5678", "119123456789", "abc"]) expect(c({ name: "Maria", phone }).success, phone).toBe(false);
    expect(c({ name: "Maria", phone: "(11) 91234-5678", email: "" }).success).toBe(true);
    expect(c({ name: "Maria", phone: "(11) 91234-5678", email: null }).success).toBe(true);
    expect(c({ name: "Maria", phone: "(11) 91234-5678", email: "maria@example.com" }).success).toBe(true);
    for (const email of ["x", "a@b", "a b@c.com", `${"a".repeat(250)}@c.com`]) expect(c({ name: "Maria", phone: "(11) 91234-5678", email }).success, email).toBe(false);
  });

  it("itens: 1 a 50, quantidade inteira 1-99, uuids, observação <= 500, até 50 adicionais por item", () => {
    const it_ = (items: unknown) => createOrderBodySchema.safeParse(valid({ items }));
    expect(it_([]).success).toBe(false);
    expect(it_(Array.from({ length: MAX_ORDER_ITEMS }, () => ({ productId: U(1), quantity: 1 }))).success).toBe(true);
    expect(it_(Array.from({ length: MAX_ORDER_ITEMS + 1 }, () => ({ productId: U(1), quantity: 1 }))).success).toBe(false);
    for (const quantity of [0, -1, 100, 1.5, "2", null, NaN]) expect(it_([{ productId: U(1), quantity }]).success, String(quantity)).toBe(false);
    for (const quantity of [1, 99]) expect(it_([{ productId: U(1), quantity }]).success).toBe(true);
    for (const productId of ["x", "", null, 1, "00000000-0000-0000-0000-000000000000x"]) expect(it_([{ productId, quantity: 1 }]).success, String(productId)).toBe(false);
    expect(it_([{ productId: U(1), quantity: 1, variantId: "nao-uuid" }]).success).toBe(false);
    expect(it_([{ productId: U(1), quantity: 1, variantId: U(2), modifierIds: [U(3)] }]).success).toBe(true);
    expect(it_([{ productId: U(1), quantity: 1, modifierIds: Array.from({ length: 51 }, () => U(3)) }]).success).toBe(false);
    expect(it_([{ productId: U(1), quantity: 1, notes: "n".repeat(501) }]).success).toBe(false);
    expect(it_([{ productId: U(1), quantity: 1, notes: "n".repeat(500) }]).success).toBe(true);
  });

  it("DELIVERY exige endereço completo e zona; PICKUP/DINE_IN não; modalidade desconhecida é recusada", () => {
    const addr = { street: "Rua A", number: "1", neighborhood: "Centro", city: "SP" };
    expect(issues(createOrderBodySchema.safeParse(valid({ fulfillmentType: "DELIVERY" })))).toEqual(expect.arrayContaining(["address: Informe o endereço de entrega.", "deliveryZoneId: Escolha a região de entrega."]));
    expect(createOrderBodySchema.safeParse(valid({ fulfillmentType: "DELIVERY", address: addr, deliveryZoneId: U(9) })).success).toBe(true);
    expect(createOrderBodySchema.safeParse(valid({ fulfillmentType: "DELIVERY", address: { ...addr, street: "" }, deliveryZoneId: U(9) })).success).toBe(false);
    expect(createOrderBodySchema.safeParse(valid({ fulfillmentType: "DELIVERY", address: { ...addr, postalCode: "123" }, deliveryZoneId: U(9) })).success).toBe(false);
    expect(createOrderBodySchema.safeParse(valid({ fulfillmentType: "DELIVERY", address: { ...addr, postalCode: "01310-100" }, deliveryZoneId: U(9) })).success).toBe(true);
    for (const f of ["DINE_IN", "PICKUP"]) expect(createOrderBodySchema.safeParse(valid({ fulfillmentType: f })).success, f).toBe(true);
    for (const f of ["VOO", "delivery", "", null]) expect(createOrderBodySchema.safeParse(valid({ fulfillmentType: f })).success, String(f)).toBe(false);
  });

  it("pagamento: CASH/PIX/CARD; troco só em CASH (inteiro 1..100.000.000)", () => {
    expect([...PAYMENT_METHODS]).toEqual(["CASH", "PIX", "CARD"]);
    const p = (payment: unknown) => createOrderBodySchema.safeParse(valid({ payment }));
    for (const method of PAYMENT_METHODS) expect(p({ method }).success, method).toBe(true);
    for (const method of ["BTC", "cash", "", null, undefined]) expect(p({ method }).success, String(method)).toBe(false);
    expect(p({ method: "CASH", changeForCents: 10000 }).success).toBe(true);
    expect(p({ method: "CASH", changeForCents: null }).success).toBe(true);
    for (const changeForCents of [0, -1, 1.5, 100_000_001, "100"]) expect(p({ method: "CASH", changeForCents }).success, String(changeForCents)).toBe(false);
    expect(issues(p({ method: "PIX", changeForCents: 5000 }))).toContain("payment.changeForCents: Troco só se aplica a pagamento em dinheiro.");
    expect(p({ method: "CARD", changeForCents: 5000 }).success).toBe(false);
    expect(createOrderBodySchema.safeParse(valid({ payment: undefined })).success).toBe(false);
  });

  it("observações do pedido <= 500; corpo que não é objeto é recusado; chaves desconhecidas são ignoradas", () => {
    expect(createOrderBodySchema.safeParse(valid({ notes: "n".repeat(500) })).success).toBe(true);
    expect(createOrderBodySchema.safeParse(valid({ notes: "n".repeat(501) })).success).toBe(false);
    for (const v of [null, [], "x", 1, true, undefined]) expect(createOrderBodySchema.safeParse(v).success).toBe(false);
    const polluted = createOrderBodySchema.safeParse(JSON.parse('{"__proto__":{"polluted":true},"fulfillmentType":"PICKUP","items":[{"productId":"00000000-0000-4000-8000-000000000001","quantity":1}],"customer":{"name":"Maria","phone":"(11) 91234-5678"},"payment":{"method":"PIX"}}'));
    expect(polluted.success).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("phoneDigits / isPublicCode", () => {
  it("phoneDigits mantém só dígitos", () => {
    expect(phoneDigits("(11) 91234-5678")).toBe("11912345678");
    expect(phoneDigits("+55 11 91234-5678")).toBe("5511912345678");
    expect(phoneDigits("")).toBe("");
    expect(phoneDigits("abc")).toBe("");
  });
  it("isPublicCode: 3-40 caracteres [A-Za-z0-9-]", () => {
    for (const c of ["ABCDEFGH23456789", "abc", "A-B-C", "x".repeat(40)]) expect(isPublicCode(c), c).toBe(true);
    for (const c of ["ab", "x".repeat(41), "a b", "a/b", "..", "%00", "a_b", "😀😀😀", "", null, undefined, 123]) expect(isPublicCode(c), String(c)).toBe(false);
    expect(PUBLIC_CODE_PATTERN.test("ABCDEFGH23456789")).toBe(true);
  });
});

describe("messages: códigos de create_public_order -> PT-BR", () => {
  const DB_CODES = [
    // price_cart
    "RESTAURANT_UNAVAILABLE", "RESTAURANT_CLOSED", "FULFILLMENT_DISABLED", "PRODUCT_UNAVAILABLE", "MODIFIER_UNAVAILABLE", "MODIFIER_NOT_ALLOWED", "MODIFIER_GROUP_MIN", "MODIFIER_GROUP_MAX",
    "INVALID_QUANTITY", "BELOW_MINIMUM", "ZONE_REQUIRED", "ZONE_UNAVAILABLE", "EMPTY_CART", "VARIANT_REQUIRED", "VARIANT_UNAVAILABLE", "VARIANT_NOT_ALLOWED", "TOO_MANY_ITEMS", "TOO_MANY_MODIFIERS", "NOTES_TOO_LONG",
    // próprios (mig. 0114)
    "INVALID_IDEMPOTENCY_KEY", "INVALID_CUSTOMER", "INVALID_CUSTOMER_NAME", "INVALID_CUSTOMER_PHONE", "INVALID_CUSTOMER_EMAIL", "ADDRESS_REQUIRED", "ADDRESS_INCOMPLETE", "ADDRESS_INVALID",
    "INVALID_NOTES", "INVALID_PAYMENT_METHOD", "CHANGE_NOT_ALLOWED", "INVALID_CHANGE", "CHANGE_BELOW_TOTAL",
  ];
  it("todo código documentado na migração 0114 tem mensagem própria (não cai no texto genérico)", () => {
    for (const code of DB_CODES) {
      const m = orderErrorMessage(code);
      expect(m, code).not.toBe(GENERIC_CART_ERROR);
      expect(m.length, code).toBeGreaterThan(10);
    }
  });
  it("herda as mensagens do carrinho e acrescenta as de pedido; IDEMPOTENCY_CONFLICT existe", () => {
    for (const [code, msg] of Object.entries(CART_ERROR_MESSAGES)) expect(ORDER_ERROR_MESSAGES[code]).toBeTruthy();
    expect(orderErrorMessage("BELOW_MINIMUM")).toBe(CART_ERROR_MESSAGES.BELOW_MINIMUM);
    expect(orderErrorMessage("IDEMPOTENCY_CONFLICT")).toMatch(/outro conteúdo/);
  });
  it("código desconhecido, vazio ou herdado de Object.prototype NUNCA vira texto cru/função: mensagem genérica", () => {
    for (const code of ["UNKNOWN", "", "constructor", "toString", "__proto__", "hasOwnProperty", "relation \"orders\" does not exist", "23505"]) {
      const m = orderErrorMessage(code);
      expect(typeof m, code).toBe("string");
      expect(m, code).toBe(GENERIC_CART_ERROR);
    }
    expect(GENERIC_ORDER_ERROR).toMatch(/pedido/i);
  });
});

describe("tracking.parseTrackedOrder", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    restaurant: { name: "Pastelaria", slug: "la-pastelaria", timezone: "America/Sao_Paulo" },
    public_code: "ABCDEFGH23456789",
    order_number: 42,
    fulfillment_type: "DELIVERY",
    status: "PREPARING",
    status_message: null,
    payment_status: "UNPAID",
    payment_method: "CASH",
    items: [
      { name: "Pizza", variant_name: " G ", quantity: 2, unit_price_cents: 2000, modifiers_cents: 100, line_total_cents: 4200, notes: "  sem cebola ", modifiers: [{ name: "Borda", group_name: "Extras", price_delta_cents: 100, quantity: 1 }] },
    ],
    subtotal_cents: 4200,
    delivery_fee_cents: 500,
    discount_cents: 0,
    total_cents: 4700,
    neighborhood: "Centro",
    created_at: "2026-10-15T12:00:00+00:00",
    estimated_ready_at: "2026-10-15T12:30:00+00:00",
    status_history: [{ to_status: "RECEIVED", at: "2026-10-15T12:00:00Z" }, { to_status: "CONFIRMED", at: "2026-10-15T12:01:00Z" }],
    ...over,
  });

  it("converte para camelCase com tipos e aparas", () => {
    const o = parseTrackedOrder(raw())!;
    expect(o).toMatchObject({
      restaurantName: "Pastelaria",
      timezone: "America/Sao_Paulo",
      orderNumber: 42,
      fulfillmentType: "DELIVERY",
      status: "PREPARING",
      paymentStatus: "UNPAID",
      paymentMethod: "CASH",
      subtotalCents: 4200,
      deliveryFeeCents: 500,
      discountCents: 0,
      totalCents: 4700,
      neighborhood: "Centro",
      statusReason: null,
    });
    expect(o.items).toEqual([{ name: "Pizza", variantName: "G", quantity: 2, unitPriceCents: 2000, lineTotalCents: 4200, modifiers: [{ name: "Borda", priceDeltaCents: 100 }], notes: "sem cebola" }]);
    expect(o.statusHistory).toEqual([{ status: "RECEIVED", at: "2026-10-15T12:00:00Z" }, { status: "CONFIRMED", at: "2026-10-15T12:01:00Z" }]);
  });

  it("campos de PII/ids que o servidor jamais deveria mandar são DESCARTADOS do modelo (defesa em profundidade)", () => {
    const o = parseTrackedOrder(raw({ customer_phone: "11912345678", customer_email: "a@b.com", customer_name: "Fulano", delivery_address: { street: "Rua X" }, id: U(1), restaurant_id: U(2), idempotency_key: "k", notes: "segredo" }))!;
    const text = JSON.stringify(o);
    for (const secret of ["11912345678", "a@b.com", "Fulano", "Rua X", U(1), U(2), "segredo"]) expect(text, secret).not.toContain(secret);
    expect(Object.keys(o).sort()).toEqual(["createdAt", "deliveryFeeCents", "discountCents", "estimatedReadyAt", "fulfillmentType", "items", "neighborhood", "orderNumber", "paymentMethod", "paymentStatus", "restaurantName", "statusHistory", "statusReason", "status", "subtotalCents", "timezone", "totalCents"].sort());
  });

  it("formato inesperado => null (nunca lança): status/modalidade desconhecidos, order_number inválido, não-objeto", () => {
    for (const bad of [null, undefined, "x", 1, [], {}, raw({ status: "BANANA" }), raw({ fulfillment_type: "VOO" }), raw({ order_number: "abc" }), raw({ order_number: -1 })]) {
      expect(parseTrackedOrder(bad), JSON.stringify(bad)?.slice(0, 50)).toBeNull();
    }
    for (const status of ORDER_STATUSES) expect(parseTrackedOrder(raw({ status }))?.status).toBe(status);
  });

  it("itens/histórico inválidos são descartados um a um; valores ruins viram padrão seguro", () => {
    const o = parseTrackedOrder(raw({ items: [null, "x", { name: "ok", quantity: 1, unit_price_cents: -5, line_total_cents: 1e12, modifiers: "x" }], status_history: [{ to_status: "NOPE", at: "x" }, { to_status: "READY", at: "2026-10-15T12:10:00Z" }], payment_method: "BTC", payment_status: 5, neighborhood: "  ", status_message: "  " }))!;
    expect(o.items).toHaveLength(1);
    expect(o.items[0]).toMatchObject({ name: "ok", unitPriceCents: 0, lineTotalCents: 0, modifiers: [] });
    expect(o.statusHistory).toEqual([{ status: "READY", at: "2026-10-15T12:10:00Z" }]);
    expect(o.paymentMethod).toBeNull();
    expect(o.paymentStatus).toBe("UNPAID");
    expect(o.neighborhood).toBeNull();
    expect(o.statusReason).toBeNull();
    expect(parseTrackedOrder(raw({ status: "REJECTED", status_message: "Sem ingredientes" }))?.statusReason).toBe("Sem ingredientes");
    expect(parseTrackedOrder(raw({ restaurant: undefined }))?.restaurantName).toBe("");
  });

  it("order_number numérico em texto é aceito (coerção do bigint do Postgres)", () => {
    expect(parseTrackedOrder(raw({ order_number: "17" }))?.orderNumber).toBe(17);
  });
});

describe("limits: pedidos por IP + slug", () => {
  const uniqIp = () => `ip-${Math.random().toString(36).slice(2)}`;

  it("constantes do contrato: 5 pedidos / 10 min, teto de 30 tentativas, 60 consultas / min", () => {
    expect(ORDER_LIMIT).toBe(5);
    expect(ORDER_WINDOW_MS).toBe(600_000);
    expect(ATTEMPT_LIMIT).toBe(30);
    expect(TRACK_LIMIT).toBe(60);
    expect(TRACK_WINDOW_MS).toBe(60_000);
  });

  it("5 criados passam; o 6º é negado com Retry-After em segundos (1..600)", () => {
    const ip = uniqIp();
    for (let i = 0; i < 5; i++) {
      const a = beginOrderAttempt(ip, "demo-a");
      expect(a.allowed).toBe(true);
      if (a.allowed) a.finish(true);
    }
    const sixth = beginOrderAttempt(ip, "demo-a");
    expect(sixth.allowed).toBe(false);
    if (!sixth.allowed) {
      expect(Number.isInteger(sixth.retryAfterSeconds)).toBe(true);
      expect(sixth.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(sixth.retryAfterSeconds).toBeLessThanOrEqual(600);
    }
  });

  it("finish(false) (recusado, inválido ou replay) DEVOLVE a vaga; finish(true) não", () => {
    const ip = uniqIp();
    for (let i = 0; i < 20; i++) {
      const a = beginOrderAttempt(ip, "demo-a");
      if (!a.allowed) throw new Error(`bloqueado na tentativa ${i}`);
      a.finish(false);
    }
    // 20 tentativas devolvidas: ainda cabem 5 criados... mas o teto de abuso (30) conta as 20 anteriores
    for (let i = 0; i < 5; i++) {
      const a = beginOrderAttempt(ip, "demo-a");
      expect(a.allowed, `criado ${i}`).toBe(true);
      if (a.allowed) a.finish(true);
    }
    expect(beginOrderAttempt(ip, "demo-a").allowed).toBe(false);
  });

  it("teto de abuso: 30 tentativas (mesmo todas devolvidas) bloqueiam a 31ª", () => {
    const ip = uniqIp();
    for (let i = 0; i < ATTEMPT_LIMIT; i++) {
      const a = beginOrderAttempt(ip, "demo-a");
      expect(a.allowed, `tentativa ${i}`).toBe(true);
      if (a.allowed) a.finish(false);
    }
    expect(beginOrderAttempt(ip, "demo-a").allowed).toBe(false);
  });

  it("balde por IP+slug: outro slug e outro IP não são afetados; negar não consome", () => {
    const ip = uniqIp();
    for (let i = 0; i < 5; i++) {
      const a = beginOrderAttempt(ip, "loja-1");
      if (a.allowed) a.finish(true);
    }
    expect(beginOrderAttempt(ip, "loja-1").allowed).toBe(false);
    expect(beginOrderAttempt(ip, "loja-2").allowed).toBe(true);
    expect(beginOrderAttempt(uniqIp(), "loja-1").allowed).toBe(true);
  });

  it("checkTrackRateLimit: 60 por minuto por IP+slug; o 61º é negado; baldes de pedido e de consulta são independentes", () => {
    const ip = uniqIp();
    for (let i = 0; i < TRACK_LIMIT; i++) expect(checkTrackRateLimit(ip, "demo-a").allowed, `consulta ${i}`).toBe(true);
    const denied = checkTrackRateLimit(ip, "demo-a");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(beginOrderAttempt(ip, "demo-a").allowed).toBe(true);
  });

  it("o estado é um singleton por processo (globalThis): mesma instância entre chamadas", () => {
    expect(getOrderLimiters()).toBe(getOrderLimiters());
    expect(Object.keys(getOrderLimiters()).sort()).toEqual(["attempts", "orders", "track"]);
  });
});
