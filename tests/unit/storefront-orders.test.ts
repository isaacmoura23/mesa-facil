 
/**
 * Fase 3, vitrine padrão: src/modules/storefront/order-checkout.ts (pagamento declarado, chave de idempotência por tentativa,
 * pedidos recentes) e order-status.ts (textos do acompanhamento). Módulos puros; sessionStorage/localStorage são simulados.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  changeForCents,
  clearCheckoutKey,
  EMPTY_PAYMENT_FORM,
  fingerprint,
  getCheckoutKey,
  idempotencyStorageKey,
  MAX_RECENT_ORDERS,
  paymentFormSchema,
  PAYMENT_HINTS,
  readRecentOrders,
  RECENT_ORDERS_KEY,
  rememberOrder,
} from "../../src/modules/storefront/order-checkout";
import { formatClock, formatDateTime, PAYMENT_STATUS_LABELS, statusHeadline, TERMINAL_STATUSES, timelineSteps } from "../../src/modules/storefront/order-status";
import { ORDER_STATUSES } from "../../src/modules/orders-server/tracking";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}
let session: MemoryStorage;
let local: MemoryStorage;

beforeEach(() => {
  session = new MemoryStorage();
  local = new MemoryStorage();
  vi.stubGlobal("window", { sessionStorage: session, localStorage: local });
});
afterEach(() => vi.unstubAllGlobals());

const KEY_RE = /^[A-Za-z0-9_-]{16,100}$/;

describe("paymentFormSchema / changeForCents", () => {
  it("método obrigatório (CASH, PIX, CARD); troco opcional só em dinheiro", () => {
    expect(paymentFormSchema.safeParse({ method: "PIX", changeFor: "" }).success).toBe(true);
    expect(paymentFormSchema.safeParse({ method: "CARD", changeFor: "" }).success).toBe(true);
    expect(paymentFormSchema.safeParse({ method: "CASH", changeFor: "" }).success).toBe(true);
    const bad = paymentFormSchema.safeParse(EMPTY_PAYMENT_FORM);
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0].message).toBe("Escolha como vai pagar.");
    expect(paymentFormSchema.safeParse({ method: "BTC", changeFor: "" }).success).toBe(false);
  });
  it("troco: aceita 100 / 100,00 / R$ 1.234,56; recusa zero, negativo, lixo e > R$ 1.000.000,00", () => {
    for (const v of ["100", "100,00", "R$ 100", "1.234,56", "0,01"]) expect(paymentFormSchema.safeParse({ method: "CASH", changeFor: v }).success, v).toBe(true);
    for (const v of ["0", "0,00", "-5", "abc", "1e5", "1.2.3", "10000000,00", "100000,001"]) {
      const r = paymentFormSchema.safeParse({ method: "CASH", changeFor: v });
      expect(r.success, v).toBe(false);
      expect(r.error!.issues[0].path).toEqual(["changeFor"]);
    }
    expect(paymentFormSchema.safeParse({ method: "CASH", changeFor: "x".repeat(21) }).success).toBe(false);
    // troco digitado e depois trocado para PIX/CARD é ignorado pelo formulário (o servidor é quem recusa troco fora de CASH)
    expect(paymentFormSchema.safeParse({ method: "PIX", changeFor: "abc" }).success).toBe(true);
  });
  it("changeForCents converte e zera fora de dinheiro", () => {
    expect(changeForCents({ method: "CASH", changeFor: "100,50" })).toBe(10050);
    expect(changeForCents({ method: "CASH", changeFor: "  " })).toBeNull();
    expect(changeForCents({ method: "CASH", changeFor: "" })).toBeNull();
    expect(changeForCents({ method: "PIX", changeFor: "100" })).toBeNull();
    expect(changeForCents({ method: "CARD", changeFor: "100" })).toBeNull();
    expect(changeForCents({ method: "", changeFor: "100" })).toBeNull();
    expect(changeForCents({ method: "CASH", changeFor: "lixo" })).toBeNull();
  });
  it("não existe pagamento online: as dicas dizem que se paga na entrega/retirada", () => {
    expect(Object.keys(PAYMENT_HINTS).sort()).toEqual(["CARD", "CASH", "PIX"]);
    for (const hint of Object.values(PAYMENT_HINTS)) expect(hint).toMatch(/ao receber ou retirar/);
  });
});

describe("fingerprint", () => {
  it("é determinístico, curto e muda com qualquer alteração do conteúdo", () => {
    const a = { items: [{ id: 1, q: 2 }], payment: "PIX" };
    expect(fingerprint(a)).toBe(fingerprint({ items: [{ id: 1, q: 2 }], payment: "PIX" }));
    expect(fingerprint(a)).not.toBe(fingerprint({ items: [{ id: 1, q: 3 }], payment: "PIX" }));
    expect(fingerprint(a)).not.toBe(fingerprint({ items: [{ id: 1, q: 2 }], payment: "CASH" }));
    expect(fingerprint(a)).toMatch(/^[0-9a-z]{1,8}$/);
    expect(fingerprint("")).toMatch(/^[0-9a-z]+$/);
  });
});

describe("getCheckoutKey / clearCheckoutKey (idempotência por tentativa)", () => {
  it("gera chave aceita pelo servidor e a REUTILIZA enquanto o conteúdo for o mesmo (duplo clique, retry, reload)", () => {
    const k1 = getCheckoutKey("demo-a", "h1");
    expect(k1).toMatch(KEY_RE);
    expect(getCheckoutKey("demo-a", "h1")).toBe(k1);
    expect(getCheckoutKey("demo-a", "h1")).toBe(k1);
    expect(JSON.parse(session.getItem(idempotencyStorageKey("demo-a"))!)).toEqual({ key: k1, hash: "h1" });
  });
  it("conteúdo diferente => chave nova (um pedido alterado não pode herdar o replay do antigo)", () => {
    const k1 = getCheckoutKey("demo-a", "h1");
    const k2 = getCheckoutKey("demo-a", "h2");
    expect(k2).not.toBe(k1);
    expect(k2).toMatch(KEY_RE);
    expect(getCheckoutKey("demo-a", "h2")).toBe(k2);
  });
  it("uma chave por restaurante; clearCheckoutKey descarta só a do slug", () => {
    const a = getCheckoutKey("loja-a", "h");
    const b = getCheckoutKey("loja-b", "h");
    expect(a).not.toBe(b);
    clearCheckoutKey("loja-a");
    expect(session.getItem(idempotencyStorageKey("loja-a"))).toBeNull();
    expect(getCheckoutKey("loja-b", "h")).toBe(b);
    expect(getCheckoutKey("loja-a", "h")).not.toBe(a);
  });
  it("storage corrompido ou com chave inválida (adulterada) é ignorado e substituído por uma chave válida", () => {
    for (const raw of ["{", "null", "[]", JSON.stringify({ key: "curta", hash: "h" }), JSON.stringify({ key: "x".repeat(101), hash: "h" }), JSON.stringify({ key: "chave com espaço 123456", hash: "h" }), JSON.stringify({ key: 123, hash: "h" })]) {
      session.setItem(idempotencyStorageKey("demo-a"), raw);
      const k = getCheckoutKey("demo-a", "h");
      expect(k, raw).toMatch(KEY_RE);
      if (raw !== "{") expect(JSON.parse(session.getItem(idempotencyStorageKey("demo-a"))!).key).toBe(k);
    }
  });
  it("[F-32 documentado] JSON corrompido no sessionStorage: a chave devolvida é válida mas NÃO é persistida, então cada chamada gera uma chave nova (um duplo clique nesse estado cria 2 pedidos)", () => {
    session.setItem(idempotencyStorageKey("demo-a"), "{");
    const a = getCheckoutKey("demo-a", "h");
    const b = getCheckoutKey("demo-a", "h");
    expect(a).toMatch(KEY_RE);
    expect(b).not.toBe(a);
  });
  it("sem sessionStorage (bloqueado/privado) continua devolvendo chave válida, sem lançar", () => {
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem() {
          throw new Error("SecurityError");
        },
        setItem() {
          throw new Error("SecurityError");
        },
        removeItem() {
          throw new Error("SecurityError");
        },
      },
    });
    expect(getCheckoutKey("demo-a", "h")).toMatch(KEY_RE);
    expect(() => clearCheckoutKey("demo-a")).not.toThrow();
    vi.stubGlobal("window", undefined); // SSR
    expect(getCheckoutKey("demo-a", "h")).toMatch(KEY_RE);
    expect(() => clearCheckoutKey("demo-a")).not.toThrow();
  });
  it("chaves geradas não colidem (1.000 chaves distintas)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(getCheckoutKey("demo-a", `hash-${i}`));
    expect(seen.size).toBe(1000);
  });
});

describe("pedidos recentes (localStorage)", () => {
  const entry = (n: number, slug = "demo-a") => ({ slug, publicCode: `CODE${String(n).padStart(8, "0")}`, orderNumber: n, at: `2026-10-15T12:0${n % 10}:00Z` });

  it("guarda no máximo 5, o mais novo primeiro, sem duplicar o mesmo código", () => {
    for (let i = 1; i <= 7; i++) rememberOrder(entry(i));
    const list = readRecentOrders();
    expect(list).toHaveLength(MAX_RECENT_ORDERS);
    expect(list.map((o) => o.orderNumber)).toEqual([7, 6, 5, 4, 3]);
    rememberOrder(entry(4));
    expect(readRecentOrders().map((o) => o.orderNumber)).toEqual([4, 7, 6, 5, 3]);
  });
  it("conteúdo corrompido ou adulterado => lista vazia (nunca lança); códigos fora do padrão invalidam tudo", () => {
    for (const raw of ["{", "null", "{}", JSON.stringify([{ slug: "a", publicCode: "x", orderNumber: 1, at: "t" }]), JSON.stringify([{ slug: "a", publicCode: "<script>alert(1)</script>", orderNumber: 1, at: "t" }]), JSON.stringify("x")]) {
      local.setItem(RECENT_ORDERS_KEY, raw);
      expect(readRecentOrders(), raw).toEqual([]);
    }
    expect(readRecentOrders.bind(null)).not.toThrow();
  });
  it("orderNumber inválido vira null (aproveita o resto); lista maior que 5 é cortada na leitura", () => {
    local.setItem(RECENT_ORDERS_KEY, JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ ...entry(i + 1), orderNumber: i === 0 ? "abc" : i + 1 }))));
    const list = readRecentOrders();
    expect(list).toHaveLength(5);
    expect(list[0].orderNumber).toBeNull();
  });
  it("storage indisponível: rememberOrder não lança e readRecentOrders devolve []", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem() {
          throw new Error("denied");
        },
        setItem() {
          throw new Error("denied");
        },
      },
    });
    expect(() => rememberOrder(entry(1))).not.toThrow();
    expect(readRecentOrders()).toEqual([]);
    vi.stubGlobal("window", undefined);
    expect(() => rememberOrder(entry(1))).not.toThrow();
    expect(readRecentOrders()).toEqual([]);
  });
});

describe("order-status (acompanhamento)", () => {
  it("timelineSteps: entrega tem OUT_FOR_DELIVERY; retirada e local não; rótulos por modalidade", () => {
    expect(timelineSteps("DELIVERY").map((s) => s.status)).toEqual(["RECEIVED", "CONFIRMED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "COMPLETED"]);
    expect(timelineSteps("PICKUP").map((s) => s.status)).toEqual(["RECEIVED", "CONFIRMED", "PREPARING", "READY", "COMPLETED"]);
    expect(timelineSteps("DINE_IN").map((s) => s.status)).toEqual(["RECEIVED", "CONFIRMED", "PREPARING", "READY", "COMPLETED"]);
    expect(timelineSteps("PICKUP").at(-2)!.label).toBe("Pronto para retirada");
    expect(timelineSteps("PICKUP").at(-1)!.label).toBe("Retirado");
    expect(timelineSteps("DELIVERY").at(-1)!.label).toBe("Entregue");
    expect(timelineSteps("DINE_IN").at(-1)!.label).toBe("Concluído");
  });
  it("as etapas seguem as transições do banco (nenhuma etapa fora do caminho feliz)", () => {
    const happy: Record<string, string[]> = {
      DELIVERY: ["RECEIVED", "CONFIRMED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "COMPLETED"],
      PICKUP: ["RECEIVED", "CONFIRMED", "PREPARING", "READY", "COMPLETED"],
      DINE_IN: ["RECEIVED", "CONFIRMED", "PREPARING", "READY", "COMPLETED"],
    };
    for (const f of ["DELIVERY", "PICKUP", "DINE_IN"] as const) expect(timelineSteps(f).map((s) => s.status)).toEqual(happy[f]);
  });
  it("statusHeadline: texto para TODOS os status e modalidades; recusa/cancelamento distintos", () => {
    for (const f of ["DELIVERY", "PICKUP", "DINE_IN"] as const) {
      for (const s of ORDER_STATUSES) {
        const h = statusHeadline(s, f);
        expect(typeof h, `${s}/${f}`).toBe("string");
        expect(h.length).toBeGreaterThan(10);
      }
    }
    expect(statusHeadline("READY", "PICKUP")).toMatch(/retirar/);
    expect(statusHeadline("READY", "DELIVERY")).toMatch(/entregador/);
    expect(statusHeadline("COMPLETED", "DELIVERY")).toMatch(/entregue/);
    expect(statusHeadline("COMPLETED", "PICKUP")).toMatch(/retirado/);
    expect(statusHeadline("REJECTED", "PICKUP")).not.toBe(statusHeadline("CANCELLED", "PICKUP"));
  });
  it("TERMINAL_STATUSES = COMPLETED, CANCELLED, REJECTED", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["CANCELLED", "COMPLETED", "REJECTED"]);
  });
  it("PAYMENT_STATUS_LABELS: UNPAID = 'A pagar' (nada é cobrado online)", () => {
    expect(PAYMENT_STATUS_LABELS.UNPAID).toBe("A pagar");
    expect(PAYMENT_STATUS_LABELS.PAID).toBe("Pago");
  });
  it("formatClock/formatDateTime: fuso do restaurante, ISO inválido => '' e fuso inválido não lança", () => {
    const iso = "2026-10-15T15:30:00Z"; // 12:30 em São Paulo (UTC-3)
    expect(formatClock(iso, "America/Sao_Paulo")).toBe("12:30");
    expect(formatClock(iso, "UTC")).toBe("15:30");
    expect(formatDateTime(iso, "America/Sao_Paulo")).toMatch(/^15\/10,? 12:30$/);
    for (const bad of ["", "nao-data", "2026-13-45"]) {
      expect(formatClock(bad, "America/Sao_Paulo"), bad).toBe("");
      expect(formatDateTime(bad, null), bad).toBe("");
    }
    expect(() => formatClock(iso, "Fuso/Invalido")).not.toThrow();
    expect(formatClock(iso, "Fuso/Invalido")).toMatch(/^\d{2}:\d{2}$/);
    expect(formatDateTime(iso, "Fuso/Invalido")).toMatch(/^\d{2}\/\d{2}/);
    expect(formatClock(iso, null)).toMatch(/^\d{2}:\d{2}$/);
  });
});
