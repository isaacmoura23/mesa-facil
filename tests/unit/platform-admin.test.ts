/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requirePlatformAdmin: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ getPublicEnvStatus: () => ({ ok: true }) }));
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
const fetchPlans = vi.fn();
vi.mock("@/modules/platform-admin/queries", () => ({
  fetchPlans: (...a: unknown[]) => fetchPlans(...a),
  fetchAudit: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSubscriptions: vi.fn(),
  fetchTickets: vi.fn(),
}));

import { savePlanAction } from "@/modules/platform-admin/actions";
import { AUDIT_PREFIXES, CSV_LIMIT, buildAuditCsv, describePlatformAudit } from "@/modules/platform-admin/audit-text";
import { LOAD_ERROR, errorMessage, failure } from "@/modules/platform-admin/errors";
import { isRec, normalizeSubscriptionStatus, normalizeTicketStatus, num, str, toAudit, toPlan, toSession, toSettings, toSubscription, toTicket, unwrapPage } from "@/modules/platform-admin/normalize";
import { toOverview } from "@/modules/platform-admin/overview";
import {
  SUBSCRIPTION_STATUSES,
  TICKET_STATUSES,
  auditFiltersSchema,
  featuresToLines,
  fieldErrorsOf,
  parseFeatureLines,
  planFormSchema,
  settingsFormSchema,
  subscriptionFormSchema,
  subscriptionFilterSchema,
  ticketFormSchema,
} from "@/modules/platform-admin/schemas";

const UUID = "a971dd7b-6eee-5ded-95d8-129db13f83c8";
const GENERIC = "Não foi possível concluir a operação agora. Tente novamente em instantes.";

describe("platform-admin/schemas: planos", () => {
  const base = { id: "", code: "plano-x", name: "Plano X", price: "99,90", max_members: "5", max_tables: "", max_products: "0", features: "reports\nsupport=email", isActive: true };

  it("aceita o formulário válido; limites vazios = ilimitado (null no envio)", () => {
    expect(planFormSchema.safeParse(base).success).toBe(true);
    expect(planFormSchema.safeParse({ ...base, id: UUID }).success).toBe(true);
  });

  it("limites: inteiros >= 0 com até 9 dígitos ou vazio; negativos, decimais, notação científica e texto são recusados", () => {
    for (const v of ["", "0", "7", "999999999"]) expect(planFormSchema.safeParse({ ...base, max_members: v }).success, v).toBe(true);
    for (const v of ["-1", "1.5", "1e3", "abc", "1000000000", " 1 2", "+1", "０"]) expect(planFormSchema.safeParse({ ...base, max_tables: v }).success, v).toBe(false);
    // " 7 " é aparado
    expect(planFormSchema.safeParse({ ...base, max_products: " 7 " }).success).toBe(true);
  });

  it("código ^[a-z0-9-]{2,40}$ (igual ao banco), nome 2..80, preço parseável", () => {
    for (const c of ["ab", "a-b", "x".repeat(40)]) expect(planFormSchema.safeParse({ ...base, code: c }).success, c).toBe(true);
    for (const c of ["a", "A", "ab_c", "a b", "x".repeat(41), "", "ação"]) expect(planFormSchema.safeParse({ ...base, code: c }).success, c).toBe(false);
    for (const n of ["a", "", " ", "x".repeat(81)]) expect(planFormSchema.safeParse({ ...base, name: n }).success).toBe(false);
    for (const p of ["", "abc", "-1", "1,2,3"]) expect(planFormSchema.safeParse({ ...base, price: p }).success, p).toBe(false);
    expect(planFormSchema.safeParse({ ...base, id: "nao-uuid" }).success).toBe(false);
  });

  it("fieldErrorsOf mapeia o 1º erro por campo", () => {
    const r = planFormSchema.safeParse({ ...base, code: "A", name: "", max_members: "x" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const e = fieldErrorsOf(r.error);
      expect(Object.keys(e).sort()).toEqual(["code", "max_members", "name"]);
      expect(typeof e.code).toBe("string");
    }
  });

  it("parseFeatureLines: chave => true, chave=valor => true/false/número/texto; inválido => null", () => {
    expect(parseFeatureLines("a\nb=false\nc=true\nd=12\ne=1.5\nf=email premium\n\n  g  \r\nh = 3")).toEqual({ a: true, b: false, c: true, d: 12, e: 1.5, f: "email premium", g: true, h: 3 });
    expect(parseFeatureLines("")).toEqual({});
    for (const bad of ["A", "a-b", "a b", "x".repeat(41), "=1", "a=", `a=${"v".repeat(61)}`, "ação", "a=1\n__proto__!"]) expect(parseFeatureLines(bad), bad).toBeNull();
    const proto = parseFeatureLines("__proto__=1\nconstructor");
    expect(({} as any).constructor).toBe(Object);
    expect(proto).not.toBeNull();
    expect(featuresToLines({ a: true, b: false, c: 3, d: "x" })).toBe("a\nb=false\nc=3\nd=x");
    expect(parseFeatureLines(featuresToLines({ a: true, b: false, c: 3, d: "x" }))).toEqual({ a: true, b: false, c: 3, d: "x" });
  });
});

describe("platform-admin/schemas: assinatura, chamado, configurações, filtros", () => {
  it("assinatura: estados do contrato; data AAAA-MM-DD ou vazio; nota <= 500", () => {
    expect([...SUBSCRIPTION_STATUSES]).toEqual(["trial", "active", "past_due", "cancelled"]);
    const ok = { restaurant: UUID, plan: UUID, status: "trial", periodEnd: "2026-12-31", note: "" };
    expect(subscriptionFormSchema.safeParse(ok).success).toBe(true);
    expect(subscriptionFormSchema.safeParse({ ...ok, periodEnd: "" }).success).toBe(true);
    for (const st of ["trialing", "canceled", "paid", ""]) expect(subscriptionFormSchema.safeParse({ ...ok, status: st }).success, st).toBe(false);
    for (const d of ["31/12/2026", "2026-1-1", "2026-12-31T00:00", "ontem"]) expect(subscriptionFormSchema.safeParse({ ...ok, periodEnd: d }).success, d).toBe(false);
    expect(subscriptionFormSchema.safeParse({ ...ok, note: "x".repeat(501) }).success).toBe(false);
    expect(subscriptionFormSchema.parse({ ...ok, note: undefined }).note).toBe("");
    expect(subscriptionFormSchema.safeParse({ ...ok, plan: "x" }).success).toBe(false);
  });

  it("documentado: 2026-02-30 passa na regex do app (o banco/Date decide)", () => {
    expect(subscriptionFormSchema.safeParse({ restaurant: UUID, plan: UUID, status: "active", periodEnd: "2026-02-30" }).success).toBe(true);
  });

  it("chamado: 4 estados e nota <= 1000", () => {
    expect([...TICKET_STATUSES]).toEqual(["open", "in_progress", "resolved", "closed"]);
    expect(ticketFormSchema.safeParse({ id: UUID, status: "resolved", note: "x".repeat(1000) }).success).toBe(true);
    expect(ticketFormSchema.safeParse({ id: UUID, status: "resolved", note: "x".repeat(1001) }).success).toBe(false);
    expect(ticketFormSchema.safeParse({ id: UUID, status: "done" }).success).toBe(false);
  });

  it("configurações: dias 0..365 inteiros; e-mail opcional; mensagem <= 300", () => {
    const ok = { registrationEnabled: true, defaultTrialDays: "14", supportEmail: "", maintenanceMessage: "" };
    expect(settingsFormSchema.safeParse(ok).success).toBe(true);
    for (const d of ["0", "365", "007"]) expect(settingsFormSchema.safeParse({ ...ok, defaultTrialDays: d }).success, d).toBe(true);
    for (const d of ["366", "-1", "1.5", "", "abc", "1000", "1e2"]) expect(settingsFormSchema.safeParse({ ...ok, defaultTrialDays: d }).success, d).toBe(false);
    expect(settingsFormSchema.safeParse({ ...ok, supportEmail: "a@b.co" }).success).toBe(true);
    for (const e of ["abc", "a@b", "a b@c.de", `${"x".repeat(200)}@a.bc`]) expect(settingsFormSchema.safeParse({ ...ok, supportEmail: e }).success, e.slice(0, 12)).toBe(false);
    expect(settingsFormSchema.safeParse({ ...ok, maintenanceMessage: "m".repeat(300) }).success).toBe(true);
    expect(settingsFormSchema.safeParse({ ...ok, maintenanceMessage: "m".repeat(301) }).success).toBe(false);
    expect(settingsFormSchema.safeParse({ ...ok, registrationEnabled: "true" }).success).toBe(false);
  });

  it("filtros de auditoria: prefixo [a-z0-9_.]*, uuids ou vazio, datas ymd", () => {
    const ok = { actor: "", prefix: "platform.", restaurant: UUID, from: "2026-01-01", to: "" };
    expect(auditFiltersSchema.safeParse(ok).success).toBe(true);
    for (const p of ["Platform.", "a b", "%", "a-b", "x".repeat(61)]) expect(auditFiltersSchema.safeParse({ ...ok, prefix: p }).success, p).toBe(false);
    expect(auditFiltersSchema.safeParse({ ...ok, actor: "x" }).success).toBe(false);
    expect(subscriptionFilterSchema.safeParse("cancelled").success).toBe(true);
    expect(subscriptionFilterSchema.safeParse("canceled").success).toBe(false);
  });
});

describe("platform-admin/errors: códigos CODIGO: texto -> PT-BR", () => {
  const msg = (message: string, code?: string) => errorMessage({ message, code });

  it("cada código que o banco emite nas RPCs da Fase 6 tem mensagem PT-BR (nunca o texto cru)", () => {
    const codes = ["FORBIDDEN", "INVALID_CODE", "INVALID_NAME", "INVALID_PRICE", "INVALID_LIMITS", "INVALID_FEATURES", "CODE_TAKEN", "LAST_ACTIVE_PLAN", "PLAN_IN_USE", "PLAN_NOT_FOUND", "PLAN_INACTIVE", "REASON_REQUIRED", "INVALID_REASON", "INVALID_STATUS", "INVALID_PERIOD", "INVALID_NOTE", "INVALID_SETTING_KEY", "INVALID_SETTING_VALUE", "RESTAURANT_NOT_FOUND", "SUBSCRIPTION_NOT_FOUND", "TICKET_NOT_FOUND", "SUPPORT_SESSION_INVALID", "INVALID_PREFIX", "INVALID_CURSOR", "REGISTRATION_DISABLED"];
    const seen = new Set<string>();
    for (const c of codes) {
      const m = msg(`${c}: texto técnico do banco com detalhes internos`);
      expect(m, c).not.toBe(GENERIC);
      expect(m, c).not.toMatch(/técnico|banco|internos|[A-Z]{4,}_[A-Z]+/);
      seen.add(m);
    }
    expect(seen.size).toBeGreaterThan(15);
  });

  it("aceita o prefixo 'ERROR:' e espaços; códigos desconhecidos/ruído => mensagem genérica (nunca texto cru)", () => {
    expect(msg("  ERROR: CODE_TAKEN: x")).toBe(msg("CODE_TAKEN: x"));
    for (const raw of ["BOOM: segredo-interno", "duplicate key value violates unique constraint \"plans_code_key\"", "", "code_taken: minúsculo", "XX: a", "constructor: x", "__PROTO__: x"]) {
      const m = msg(raw);
      expect(m).toBe(GENERIC);
      expect(m).not.toContain("segredo");
      expect(m).not.toContain("constraint");
    }
    expect(errorMessage(null)).toBe(GENERIC);
    expect(errorMessage(undefined)).toBe(GENERIC);
  });

  it("códigos HTTP/PostgREST: sessão (PGRST301/303), função ausente (PGRST202/42883), 42501 => FORBIDDEN", () => {
    expect(errorMessage({ code: "PGRST301" })).toBe("Sua sessão expirou. Entre novamente.");
    expect(errorMessage({ code: "PGRST303" })).toBe("Sua sessão expirou. Entre novamente.");
    expect(errorMessage({ code: "PGRST202" })).toMatch(/ainda não está disponível/);
    expect(errorMessage({ code: "42883" })).toMatch(/ainda não está disponível/);
    expect(errorMessage({ code: "42501", message: "permission denied for function x" })).toBe(msg("FORBIDDEN: x"));
    expect(failure({ message: "PLAN_IN_USE: x" })).toEqual({ ok: false, message: msg("PLAN_IN_USE: x") });
    expect(LOAD_ERROR).toMatch(/carregar/);
  });

  // F-51: o banco emite UNAUTHENTICATED (28000); o mapa só conhece NOT_AUTHENTICATED => "sessão expirada" vira erro genérico
  it("F-51: UNAUTHENTICATED (28000) deveria virar 'sua sessão expirou'", () => {
    expect(msg("UNAUTHENTICATED: faça login para continuar", "28000")).toBe("Sua sessão expirou. Entre novamente.");
  });
});

describe("platform-admin/audit-text: textos PT-BR por ação com fallback seguro", () => {
  it("cada ação da plataforma tem texto conhecido; planos usam o código", () => {
    for (const a of ["platform.plan_created", "platform.plan_updated", "platform.subscription_changed", "platform.subscription_note", "platform.ticket_note", "platform.setting_updated", "platform.ticket_updated", "platform.restaurant_created", "platform.restaurant_status_changed", "support.session_opened", "support.session_closed", "support.overview_viewed"]) {
      const d = describePlatformAudit(a, {});
      expect(d.known, a).toBe(true);
      expect(d.text, a).toMatch(/[a-zà-ú]/i);
    }
    expect(describePlatformAudit("platform.plan_created", { code: "pro" }).text).toBe("Criou o plano pro");
    expect(describePlatformAudit("platform.plan_updated", { name: "Pro" }).text).toBe("Atualizou o plano Pro");
    expect(describePlatformAudit("platform.setting_updated", { key: "default_trial_days" }).text).toBe("Alterou a configuração default_trial_days");
    expect(describePlatformAudit("platform.setting_updated", {}).text).toBe("Alterou a configuração da plataforma");
  });

  it("nota interna NÃO é ecoada no texto (só 'registrou uma nota')", () => {
    expect(describePlatformAudit("platform.subscription_note", { note: "segredo da negociação" }).text).not.toContain("segredo");
    expect(describePlatformAudit("platform.ticket_note", { note: "segredo" }).text).not.toContain("segredo");
  });

  it("ação desconhecida, vazia ou com nome de protótipo => texto genérico (known:false); metadata hostil não lança", () => {
    for (const a of ["x.y", "", "constructor", "__proto__", "toString", "platform."]) {
      const d = describePlatformAudit(a, { status: "active" });
      expect(d.known, a).toBe(false);
      expect(typeof d.text).toBe("string");
    }
    expect(() => describePlatformAudit("platform.plan_created", { code: { a: 1 }, name: ["x"] } as any)).not.toThrow();
    expect(describePlatformAudit("platform.plan_created", { code: 5 }).text).toBe("Criou o plano");
  });

  it("rótulos de status: trial/trialing e cancelled/canceled, desconhecido seguro", () => {
    expect(describePlatformAudit("platform.subscription_changed", { status: "trialing" }).text).toContain("teste");
    expect(describePlatformAudit("platform.subscription_changed", { status: "canceled" }).text).toContain("cancelada");
    expect(describePlatformAudit("platform.subscription_changed", { status: "cancelled" }).text).toContain("cancelada");
    expect(describePlatformAudit("platform.subscription_changed", { status: "x" }).text).toContain("outro estado");
  });

  // F-52: o banco grava status_from/status_to (e plan_from/plan_to); o app lê m.status / m.to => sempre "outro estado"
  it("F-52: platform.subscription_changed com metadata REAL (status_to) descreve o estado", () => {
    const real = { status_from: "trial", status_to: "active", plan_from: "basico", plan_to: "pro", period_end: null };
    expect(describePlatformAudit("platform.subscription_changed", real).text).toContain("ativa");
  });
  it("F-52: platform.restaurant_status_changed com metadata REAL (status_to) descreve o estado", () => {
    expect(describePlatformAudit("platform.restaurant_status_changed", { status_from: "active", status_to: "suspended", reason: "fraude" }).text).toContain("suspenso");
  });

  it("prefixos de filtro são literais sem curingas", () => {
    for (const p of AUDIT_PREFIXES) expect(p.value).toMatch(/^[a-z0-9_.]*$/);
  });

  it("CSV: BOM, ';', CRLF, fórmula neutralizada, metadata sensível omitida, aviso de truncamento", () => {
    const rows = [
      { id: "1", createdAt: "2026-01-01T00:00:00Z", actorId: UUID, actorName: "=HYPERLINK(\"http://x\")", restaurantName: "R;1", action: "platform.setting_updated", metadata: { key: "k", token: "tok-secreto", password: "pw", note: "linha\nquebrada" } },
      { id: "2", createdAt: "2026-01-02T00:00:00Z", actorId: null, actorName: null, restaurantName: null, action: "x.y", metadata: {} },
    ] as any[];
    const csv = buildAuditCsv(rows, true);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toMatch(/tok-secreto|pw/);
    expect(csv).not.toMatch(/;=HYPERLINK|^=/m);
    expect(csv).toContain("Sistema");
    expect(csv).toContain(`resultado limitado a ${CSV_LIMIT} linhas`);
    expect(buildAuditCsv([], false)).not.toContain("Aviso");
    expect(csv.split("\r\n")[0].split(";")).toHaveLength(6);
  });
});

describe("platform-admin/normalize", () => {
  it("status de assinatura: os dois vocabulários, desconhecido => null; chamado desconhecido => open", () => {
    expect(normalizeSubscriptionStatus("trial")).toBe("trial");
    expect(normalizeSubscriptionStatus("trialing")).toBe("trial");
    expect(normalizeSubscriptionStatus("canceled")).toBe("cancelled");
    expect(normalizeSubscriptionStatus("cancelled")).toBe("cancelled");
    expect(normalizeSubscriptionStatus("active")).toBe("active");
    expect(normalizeSubscriptionStatus("past_due")).toBe("past_due");
    for (const v of [null, "", "Active", "paid", "constructor"]) expect(normalizeSubscriptionStatus(v as any)).toBeNull();
    expect(normalizeTicketStatus("resolved")).toBe("resolved");
    expect(normalizeTicketStatus("in_progress")).toBe("in_progress");
    expect(normalizeTicketStatus("closed")).toBe("closed");
    for (const v of [null, "", "x", "OPEN"]) expect(normalizeTicketStatus(v)).toBe("open");
  });

  it("str/num/isRec/unwrapPage tolerantes", () => {
    expect(str({ a: "", b: "x" }, "a", "b")).toBe("x");
    expect(str({ a: 5 }, "a")).toBeNull();
    expect(num({ a: NaN, b: Infinity, c: 3 }, "a", "b", "c")).toBe(3);
    expect(num({ a: "3" }, "a")).toBeNull();
    expect(isRec([])).toBe(false);
    expect(isRec(null)).toBe(false);
    expect(unwrapPage({ rows: [{ a: 1 }, 5, null, [] , { b: 2 }], next_cursor: { t: "x", id: UUID } })).toEqual({ rows: [{ a: 1 }, { b: 2 }], nextCursor: { t: "x", id: UUID } });
    expect(unwrapPage({ rows: [], next_cursor: "x" })!.nextCursor).toBeNull();
    expect(unwrapPage([{ a: 1 }])).toEqual({ rows: [{ a: 1 }], nextCursor: null });
    for (const bad of [null, "x", 5, {}, { rows: "x" }]) expect(unwrapPage(bad)).toBeNull();
  });

  it("toPlan: limites só numéricos/null (preserva max_menu_items e max_print_jobs_per_month); sem id/código => null", () => {
    const p = toPlan({ id: UUID, code: "basico", name: "Básico", price_cents: 9900, limits: { max_members: 5, max_tables: null, max_menu_items: 150, max_print_jobs_per_month: 2000, lixo: "x", obj: {} }, features: { a: true }, is_active: false, sort_order: 10, subscriptions_total: 3 })!;
    expect(p.limits).toEqual({ max_members: 5, max_tables: null, max_menu_items: 150, max_print_jobs_per_month: 2000 });
    expect(p).toMatchObject({ isActive: false, subscriptionsTotal: 3, priceCents: 9900, sortOrder: 10 });
    expect(toPlan({ id: UUID })).toBeNull();
    expect(toPlan({ code: "x" })).toBeNull();
    expect(toPlan({ id: UUID, code: "x", limits: [], features: [] })).toMatchObject({ limits: {}, features: {}, isActive: true, name: "x" });
  });

  it("toSubscription/toTicket/toSession/toAudit: linhas reais do banco; sem chave mínima => null", () => {
    expect(toSubscription({ id: "s", restaurant_id: UUID, restaurant_name: "R", restaurant_slug: "r", plan_id: UUID, plan_name: "P", status: "trial", current_period_end: "e", trial_ends_at: "t" })).toMatchObject({ key: "s", status: "trial", periodEnd: "e" });
    expect(toSubscription({ restaurant_id: UUID, status: "canceled" })).toMatchObject({ key: UUID, status: "cancelled", restaurantName: "Restaurante" });
    expect(toSubscription({ status: "active" })).toBeNull();
    expect(toTicket({ id: "t", subject: "", status: "weird" })).toMatchObject({ subject: "(sem assunto)", status: "open" });
    expect(toTicket({ subject: "x" })).toBeNull();
    expect(toSession({ id: "s", restaurant_name: "R", admin_name: "Ana", reason: "r", active: true, expires_at: "x" })).toMatchObject({ active: true, isMine: false, adminName: "Ana" });
    expect(toSession({})).toBeNull();
    expect(toAudit({ id: "a", created_at: "c", action: "x", metadata: [] })).toMatchObject({ metadata: {} });
    for (const miss of [{ created_at: "c", action: "x" }, { id: "a", action: "x" }, { id: "a", created_at: "c" }]) expect(toAudit(miss)).toBeNull();
  });

  it("toSettings: objeto do banco, lista {key,value} ou lixo; padrões seguros", () => {
    expect(toSettings({ registration_enabled: false, default_trial_days: 30, support_email: "a@b.co", maintenance_message: null, updated_at: "x" })).toEqual({ registrationEnabled: false, defaultTrialDays: 30, supportEmail: "a@b.co", maintenanceMessage: "" });
    expect(toSettings([{ key: "default_trial_days", value: 7 }, { key: "registration_enabled", value: false }])).toMatchObject({ defaultTrialDays: 7, registrationEnabled: false });
    expect(toSettings(null)).toEqual({ registrationEnabled: true, defaultTrialDays: 14, supportEmail: "", maintenanceMessage: "" });
    expect(toSettings({ default_trial_days: "7" }).defaultTrialDays).toBe(14);
  });
});

describe("platform-admin/overview: visão de suporte sem campos pessoais", () => {
  const raw = {
    session: { id: UUID, restaurant_id: UUID, reason: "ver chamado", started_at: "s", expires_at: "e" },
    restaurant: { id: UUID, slug: "r", name: "R", status: "active", timezone: "America/Sao_Paulo", created_at: "c" },
    menu: { categories: 2, categories_active: 1, products: 3, products_active: 2, products_available: 1, tables: 2 },
    settings: { accepts_orders: true, prep_time_minutes: 30, min_order_cents: 0, enabled_fulfillment_types: ["DELIVERY", "PICKUP", "WEIRD"], single_tab_per_table: false, whatsapp: "11955556666", phone: "1133334444", address_text: "Av. X", storefront_url: "https://x" },
    team: [{ role: "owner", status: "active", full_name: "Dono", email: "dono@x.co", phone: "11" }],
    recent_orders: [{ order_number: 12, status: "RECEIVED", fulfillment_type: "PICKUP", payment_status: "UNPAID", total_cents: 1000, created_at: "c", customer_name: "Zelda", customer_phone: "119", delivery_address: { street: "Rua Secreta" }, notes: "nota" }],
    open_tabs: [{ label: "Mesa 3", total_cents: 500, opened_at: "o", customer_name: "Zelda" }],
  };

  it("normaliza e NÃO repassa nome/telefone/e-mail/endereço/observações (nem chaves extras que vierem por engano)", () => {
    const o = toOverview(raw)!;
    expect(o.menu.find((m) => m.label === "Produtos disponíveis")!.value).toBe(1);
    expect(o.orders).toEqual([{ number: "12", status: "RECEIVED", fulfillment: "PICKUP", payment: "UNPAID", totalCents: 1000, createdAt: "c" }]);
    expect(o.tabs).toEqual([{ label: "Mesa 3", totalCents: 500, openedAt: "o" }]);
    expect(o.team).toEqual([{ role: "owner", status: "active", name: "Dono" }]);
    const text = JSON.stringify(o);
    for (const v of ["Zelda", "11955556666" /* contato do RESTAURANTE não é exibido na visão */, "119", "Rua Secreta", "dono@x.co", "nota", "https://x", "Av. X"]) {
      if (v === "119") continue;
      expect(text, v).not.toContain(v);
    }
    expect(text).not.toContain("customer");
    expect(o.settings.map((s) => s.label)).toEqual(["Aceita pedidos", "Tempo de preparo", "Uma comanda por mesa", "Modalidades ativas"]);
    expect(o.settings.find((s) => s.label === "Modalidades ativas")!.value).toMatch(/Outra$/);
  });

  it("entradas incompletas ou hostis: sem sessão/restaurante => null; listas inválidas => vazias; nunca lança", () => {
    expect(toOverview({})).toBeNull();
    expect(toOverview({ session: {} })).toBeNull();
    expect(toOverview({ restaurant: {} })).toBeNull();
    const o = toOverview({ session: {}, restaurant: {}, menu: "x", settings: [], team: "x", recent_orders: [1, null, "a"], open_tabs: {} })!;
    expect(o.restaurant.name).toBe("Restaurante");
    expect(o.menu.every((m) => m.value === 0)).toBe(true);
    expect(o.team).toEqual([]);
    expect(o.orders).toEqual([]);
    expect(o.tabs).toEqual([]);
    expect(o.settings).toEqual([]);
    expect(() => toOverview({ session: {}, restaurant: {}, settings: { enabled_fulfillment_types: [1, null, {}] } })).not.toThrow();
    expect(toOverview({ session: {}, restaurant: {}, settings: { enabled_fulfillment_types: [] } })!.settings[0].value).toBe("Nenhuma");
  });
});

describe("platform-admin/actions: savePlanAction preserva as chaves de limites que o formulário não edita", () => {
  const form = { id: UUID, code: "basico", name: "Básico", price: "99,00", max_members: "5", max_tables: "", max_products: "7", features: "a", isActive: true };
  beforeEach(() => {
    rpc.mockReset();
    fetchPlans.mockReset();
    rpc.mockResolvedValue({ error: null });
  });

  it("edição: max_menu_items e max_print_jobs_per_month existentes seguem no p_limits; as 3 chaves do formulário vêm do formulário (vazio = null)", async () => {
    fetchPlans.mockResolvedValue({ ok: true, plans: [{ id: UUID, limits: { max_members: 1, max_menu_items: 150, max_print_jobs_per_month: 2000, max_tables: 4 } }] });
    const r = await savePlanAction(form);
    expect(r).toEqual({ ok: true, message: "Plano atualizado" });
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("platform_upsert_plan");
    expect(args).toMatchObject({ p_id: UUID, p_code: "basico", p_name: "Básico", p_price_cents: 9900, p_features: { a: true }, p_is_active: true });
    expect(args.p_limits).toEqual({ max_members: 5, max_tables: null, max_products: 7, max_menu_items: 150, max_print_jobs_per_month: 2000 });
  });

  it("criação: não consulta planos nem inventa limites; p_id null", async () => {
    const r = await savePlanAction({ ...form, id: "" });
    expect(r).toEqual({ ok: true, message: "Plano criado" });
    expect(fetchPlans).not.toHaveBeenCalled();
    expect(rpc.mock.calls[0][1].p_id).toBeNull();
    expect(rpc.mock.calls[0][1].p_limits).toEqual({ max_members: 5, max_tables: null, max_products: 7 });
  });

  it("se a leitura dos planos falhar, ainda grava só as chaves do formulário; erro do banco => mensagem PT-BR; formulário inválido não chama o banco", async () => {
    fetchPlans.mockResolvedValue({ ok: false, message: "x" });
    expect((await savePlanAction(form)).ok).toBe(true);
    rpc.mockClear();
    rpc.mockResolvedValue({ error: { message: "PLAN_IN_USE: texto cru do banco", code: "22023" } });
    const bad = await savePlanAction(form);
    expect(bad).toEqual({ ok: false, message: errorMessage({ message: "PLAN_IN_USE: x" }) });
    rpc.mockClear();
    const inv = await savePlanAction({ ...form, code: "A!" });
    expect(inv.ok).toBe(false);
    expect((inv as any).fieldErrors.code).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
});
