/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MEMBER_STATUS_LABEL,
  RESTAURANT_STATUS_LABEL,
  RESTAURANT_STATUS_TONE,
  SUBSCRIPTION_STATUS_LABEL,
  SUBSCRIPTION_STATUS_TONE,
  SUPPORT_READONLY_REASON,
  describePlatformAudit,
  roleLabel,
} from "@/modules/platform-restaurants/labels";
import { createRestaurantSchema, encodeCursor, idSchema, parseListParams, supportSessionSchema, suspendSchema } from "@/modules/platform-restaurants/schemas";
import { dashboardSchema, detailSchema, listPayloadSchema, listRowSchema } from "@/modules/platform-restaurants/types";

const enc = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const UUID = "a971dd7b-6eee-5ded-95d8-129db13f83c8";
const ok = { name: "Casa do Zé", slug: "casa-do-ze", ownerEmail: "dono@exemplo.com" };

describe("platform-restaurants/schemas: criar restaurante (mesmas regras do banco)", () => {
  // restaurants_slug_format: ^[a-z0-9]+(-[a-z0-9]+)*$ e 3..63; restaurants_name_len: 2..120 (após trim)
  const dbSlug = (s: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) && s.length >= 3 && s.length <= 63;

  it("slug: aceita/rejeita exatamente como o CHECK do banco (exceto a lista reservada)", () => {
    const cases = ["abc", "a-b", "a1b2", "x".repeat(63), "x".repeat(64), "ab", "-ab", "ab-", "a--b", "a_b", "a b", "áé", "ABC", "a.b", "", "---", "0-0", "a-b-c-d"];
    for (const raw of cases) {
      const expected = dbSlug(raw.trim().toLowerCase());
      const r = createRestaurantSchema.safeParse({ ...ok, slug: raw });
      expect(r.success, JSON.stringify(raw)).toBe(expected);
    }
  });

  it("normaliza: trim + minúsculas no slug e no e-mail; nome com trim", () => {
    const r = createRestaurantSchema.parse({ name: "  Casa  ", slug: "  CASA-Do-Ze ", ownerEmail: "  DONO@Exemplo.COM " });
    expect(r).toEqual({ name: "Casa", slug: "casa-do-ze", ownerEmail: "dono@exemplo.com" });
  });

  it("nome 2..120; e-mail com o mesmo regex do banco e <= 254", () => {
    expect(createRestaurantSchema.safeParse({ ...ok, name: "a" }).success).toBe(false);
    expect(createRestaurantSchema.safeParse({ ...ok, name: " a " }).success).toBe(false);
    expect(createRestaurantSchema.safeParse({ ...ok, name: "ab" }).success).toBe(true);
    expect(createRestaurantSchema.safeParse({ ...ok, name: "x".repeat(120) }).success).toBe(true);
    expect(createRestaurantSchema.safeParse({ ...ok, name: "x".repeat(121) }).success).toBe(false);
    for (const e of ["", "abc", "a@b", "a b@c.de", "@c.de", "a@@c.de", `${"x".repeat(250)}@a.bc`]) expect(createRestaurantSchema.safeParse({ ...ok, ownerEmail: e }).success, e.slice(0, 20)).toBe(false);
    expect(createRestaurantSchema.safeParse({ ...ok, ownerEmail: "a@b.c" }).success).toBe(true);
  });

  it("entradas hostis/tipos errados não lançam", () => {
    for (const v of [null, undefined, 5, "x", [], { name: {}, slug: [], ownerEmail: 1 }]) expect(() => createRestaurantSchema.safeParse(v)).not.toThrow();
    expect(createRestaurantSchema.safeParse({ name: "<script>alert(1)</script>", slug: "ok-slug", ownerEmail: "a@b.co" }).success).toBe(true);
  });

  it("documentado: o app NÃO conhece os slugs reservados (admin, platform, ...); o banco recusa com INVALID_SLUG", () => {
    expect(createRestaurantSchema.safeParse({ ...ok, slug: "admin" }).success).toBe(true);
    expect(createRestaurantSchema.safeParse({ ...ok, slug: "platform" }).success).toBe(true);
  });
});

describe("platform-restaurants/schemas: suspensão, sessão de suporte, id", () => {
  it("motivo 10..500 após trim", () => {
    expect(suspendSchema.safeParse({ reason: "123456789" }).success).toBe(false);
    expect(suspendSchema.safeParse({ reason: "  123456789  " }).success).toBe(false);
    expect(suspendSchema.safeParse({ reason: "1234567890" }).success).toBe(true);
    expect(suspendSchema.safeParse({ reason: "x".repeat(500) }).success).toBe(true);
    expect(suspendSchema.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
    expect(suspendSchema.safeParse({}).success).toBe(false);
  });

  it("sessão: justificativa 10..500 e duração só 15/30/60", () => {
    const base = { reason: "investigar chamado 123" };
    for (const m of [15, 30, 60]) expect(supportSessionSchema.safeParse({ ...base, minutes: m }).success).toBe(true);
    for (const m of [0, 1, 45, 61, "30", null, undefined, 30.5]) expect(supportSessionSchema.safeParse({ ...base, minutes: m }).success, String(m)).toBe(false);
    expect(supportSessionSchema.safeParse({ reason: "curto", minutes: 30 }).success).toBe(false);
  });

  it("idSchema exige UUID", () => {
    expect(idSchema.safeParse(UUID).success).toBe(true);
    for (const v of ["", "abc", "../x", `${UUID}x`, null, 5]) expect(idSchema.safeParse(v).success).toBe(false);
  });
});

describe("platform-restaurants/schemas: parâmetros da URL e cursor base64url", () => {
  it("ida e volta; é base64url (sem +, / ou =)", () => {
    const c = { t: "2026-04-01T00:00:00.000000Z", id: UUID };
    const raw = encodeCursor(c);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseListParams({ cursor: raw }).cursor).toEqual(c);
  });

  it("valores hostis no cursor => null (nunca lança); tamanho máximo 600", () => {
    const bad: (string | undefined)[] = [undefined, "", "%%%", "not base64!", enc("não é json"), enc("[]"), enc("null"), enc("5"), enc('"str"'), enc("true"), "a".repeat(601), enc({ x: "y".repeat(700) }), "\u0000", "=".repeat(10), enc("{")];
    for (const b of bad) expect(() => parseListParams({ cursor: b }), String(b).slice(0, 20)).not.toThrow();
    for (const b of bad) {
      const c = parseListParams({ cursor: b }).cursor;
      expect(c === null || (typeof c === "object" && !Array.isArray(c))).toBe(true);
    }
    expect(parseListParams({ cursor: enc("[]") }).cursor).toBeNull();
    expect(parseListParams({ cursor: enc("null") }).cursor).toBeNull();
    expect(parseListParams({ cursor: "a".repeat(601) }).cursor).toBeNull();
    // __proto__ no JSON vira chave própria, sem poluir o protótipo
    const polluted = parseListParams({ cursor: enc('{"__proto__":{"polluted":1},"t":"x"}') }).cursor as any;
    expect(({} as any).polluted).toBeUndefined();
    expect(polluted).not.toBeNull();
  });

  it("q é aparado e limitado a 80; status só os conhecidos; arrays usam o 1º valor", () => {
    expect(parseListParams({ q: `  ${"x".repeat(200)}  ` }).q).toHaveLength(80);
    expect(parseListParams({ q: ["a", "b"] }).q).toBe("a");
    for (const s of ["pending", "active", "suspended"]) expect(parseListParams({ status: s }).status).toBe(s);
    for (const s of ["ACTIVE", "trial", "", "__proto__", "constructor"]) expect(parseListParams({ status: s }).status).toBe("");
    expect(parseListParams({}).cursor).toBeNull();
  });
});

describe("platform-restaurants/labels", () => {
  it("rótulos e tons cobrem todos os estados do contrato", () => {
    expect(Object.keys(RESTAURANT_STATUS_LABEL).sort()).toEqual(["active", "pending", "suspended"]);
    expect(Object.keys(RESTAURANT_STATUS_TONE).sort()).toEqual(["active", "pending", "suspended"]);
    expect(Object.keys(SUBSCRIPTION_STATUS_LABEL).sort()).toEqual(["active", "cancelled", "past_due", "trial"]);
    expect(Object.keys(SUBSCRIPTION_STATUS_TONE).sort()).toEqual(["active", "cancelled", "past_due", "trial"]);
    expect(Object.keys(MEMBER_STATUS_LABEL).sort()).toEqual(["active", "invited", "revoked"]);
    expect(SUPPORT_READONLY_REASON).toMatch(/somente leitura/);
  });

  it("roleLabel: desconhecido devolve o texto, vazio => 'Sem papel', protótipo não vaza função", () => {
    expect(roleLabel(null)).toBe("Sem papel");
    expect(roleLabel("")).toBe("Sem papel");
    expect(roleLabel("zz-papel")).toBe("zz-papel");
    expect(roleLabel("owner")).not.toBe("owner");
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(typeof roleLabel(k)).toBe("string");
  });

  it("describePlatformAudit usa os nomes REAIS de metadata do banco (status_to) e limita o motivo", () => {
    expect(describePlatformAudit("platform.restaurant_status_changed", { status_from: "active", status_to: "suspended", reason: "fraude confirmada" })).toBe("Restaurante suspenso. Motivo: fraude confirmada");
    expect(describePlatformAudit("platform.restaurant_status_changed", { status_to: "active" })).toBe("Restaurante reativado");
    expect(describePlatformAudit("platform.restaurant_status_changed", {})).toBe("Situação do restaurante alterada");
    expect(describePlatformAudit("platform.restaurant_status_changed", { status_to: "suspended", reason: "r".repeat(500) })!.length).toBeLessThan(260);
    expect(describePlatformAudit("support.session_opened", { reason: "  ver pedido  " })).toBe("Sessão de suporte aberta. Justificativa: ver pedido");
    expect(describePlatformAudit("support.session_opened", { reason: 5 })).toBe("Sessão de suporte aberta");
    expect(describePlatformAudit("platform.restaurant_created", {})).toBe("Restaurante criado pela plataforma");
    expect(describePlatformAudit("qualquer.coisa", {})).toBeNull();
    expect(describePlatformAudit("constructor", {})).toBeNull();
  });
});

describe("platform-restaurants/types: schemas das respostas reais do banco", () => {
  it("dashboardSchema aceita a resposta do banco (e chaves extras) e zera ausentes/nulos; número em texto é coagido", () => {
    const full = { restaurants: { total: 5, pending: 1, active: 3, suspended: 1, new_30d: 5 }, subscriptions: { active: 2, trial: 1, past_due: 1, cancelled: 2 }, mrr_cents: 18334, orders_30d: 6, tickets_open: 2, tickets_in_progress: 1, support_sessions_active: 1 };
    expect(dashboardSchema.parse(full)).toMatchObject({ mrr_cents: 18334, restaurants: { total: 5 } });
    const sparse = dashboardSchema.parse({ restaurants: {}, subscriptions: {}, mrr_cents: null });
    expect(sparse.mrr_cents).toBe(0);
    expect(sparse.restaurants.total).toBe(0);
    expect(dashboardSchema.parse({ ...full, mrr_cents: "12" }).mrr_cents).toBe(12);
    expect(dashboardSchema.safeParse({}).success).toBe(false);
    expect(dashboardSchema.safeParse(null).success).toBe(false);
  });

  it("listPayloadSchema: linha do banco; status desconhecido é rejeitado; cursor nulo/ausente => null", () => {
    const row = { id: UUID, slug: "a-b", name: "A", status: "active", created_at: "2026-01-01T00:00:00Z", plan_name: null, subscription_status: "trial", members_count: 3, owner_name: null, owner_email: "d@e.co" };
    expect(listRowSchema.parse(row)).toEqual(row);
    expect(listPayloadSchema.parse({ rows: [row] }).next_cursor).toBeNull();
    expect(listPayloadSchema.parse({ rows: [row], next_cursor: { t: "x", id: UUID } }).next_cursor).toEqual({ t: "x", id: UUID });
    expect(listPayloadSchema.safeParse({ rows: [{ ...row, status: "deleted" }] }).success).toBe(false);
    expect(listPayloadSchema.safeParse({ rows: [{ ...row, id: "" }] }).success).toBe(false);
    expect(listPayloadSchema.safeParse({ rows: "x" }).success).toBe(false);
  });

  it("detailSchema: resposta de platform_get_restaurant (assinatura usa current_period_end; equipe sem telefone)", () => {
    const d = detailSchema.parse({
      restaurant: { id: UUID, slug: "a-b", name: "A", status: "suspended", created_at: "2026-01-01T00:00:00Z", owner_name: "Dono", owner_email: "d@e.co", timezone: "America/Sao_Paulo" },
      subscription: { plan_code: "basico", plan_name: "Básico", price_cents: 9900, status: "trial", current_period_end: "2026-02-01T00:00:00Z", trial_ends_at: "2026-02-01T00:00:00Z", limits: { max_members: 5 } },
      team: [{ membership_id: UUID, role: "owner", status: "active", full_name: "Dono", created_at: "x" }],
      audit: [{ id: UUID, created_at: "2026-01-01T00:00:00Z", action: "platform.restaurant_status_changed", actor_id: UUID, metadata: { status_to: "suspended" } }],
    });
    expect(d.subscription).toMatchObject({ plan_name: "Básico", price_cents: 9900, status: "trial", period_end: "2026-02-01T00:00:00Z" });
    expect(d.team[0]).toEqual({ role: "owner", status: "active", name: "Dono", email: null });
    expect(d.audit[0].actor_name).toBeNull();
    const bare = detailSchema.parse({ restaurant: { id: UUID, slug: "a-b", name: "A", status: "active" }, subscription: null, team: null, audit: null });
    expect(bare).toMatchObject({ subscription: null, team: [], audit: [] });
    expect(detailSchema.safeParse({ restaurant: { id: UUID, slug: "a", name: "A", status: "pending " } }).success).toBe(false);
  });
});
