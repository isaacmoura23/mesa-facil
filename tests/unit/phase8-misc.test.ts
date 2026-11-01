/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 8 (unitários): magic bytes de imagem (F-17), texto sem NUL/controles (F-29/F-30), banners de plano, helper de MFA,
 * e-mail de convite (SMTP tolerado, sem enumeração) e mensagens PT-BR de SUBSCRIPTION_INACTIVE/PLAN_LIMIT_REACHED/RATE_LIMITED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const inviteUserByEmail = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ auth: { admin: { inviteUserByEmail } } }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/env");
});

describe("menu/image-bytes.ts (F-17: magic bytes)", () => {
  const bytes = (...parts: Array<number[] | string>) => Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
  const PNG = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 0]);
  const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], "JFIF");
  const WEBP = bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 ");
  const AVIF = bytes([0, 0, 0, 0x1c], "ftyp", "avif", [0, 0, 0, 0], "avif", "mif1", "miaf");
  const AVIF_COMPAT = bytes([0, 0, 0, 0x1c], "ftyp", "mif1", [0, 0, 0, 0], "mif1", "avif", "miaf");

  it("reconhece PNG, JPEG, WebP e AVIF (marca principal ou compatível)", async () => {
    const { detectImageType } = await import("../../src/modules/menu/image-bytes");
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(WEBP)).toBe("image/webp");
    expect(detectImageType(AVIF)).toBe("image/avif");
    expect(detectImageType(AVIF_COMPAT)).toBe("image/avif");
    expect(detectImageType(bytes([0, 0, 0, 0x14], "ftyp", "avis", [0, 0, 0, 0], "avis"))).toBe("image/avif");
  });

  it("recusa HTML, SVG, GIF, JS, PDF, ZIP, HEIC, MP4, WAV, arquivo vazio e truncado disfarçados de imagem", async () => {
    const { detectImageType } = await import("../../src/modules/menu/image-bytes");
    const bad: Array<[string, Uint8Array]> = [
      ["html", bytes("<html><script>alert(1)</script></html>")],
      ["html com espaço", bytes("  <!DOCTYPE html>")],
      ["svg", bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
      ["svg xml", bytes('<?xml version="1.0"?><svg/>')],
      ["gif87", bytes("GIF87a", [1, 0, 1, 0])],
      ["gif89", bytes("GIF89a", [1, 0, 1, 0])],
      ["js", bytes("alert(document.cookie)")],
      ["pdf", bytes("%PDF-1.7\n")],
      ["zip", bytes("PK", [3, 4, 0, 0])],
      ["heic", bytes([0, 0, 0, 0x18], "ftyp", "heic", [0, 0, 0, 0], "mif1", "heic")],
      ["mp4", bytes([0, 0, 0, 0x18], "ftyp", "isom", [0, 0, 0, 0], "isom", "mp41")],
      ["riff wave", bytes("RIFF", [1, 2, 3, 4], "WAVEfmt ")],
      ["vazio", new Uint8Array(0)],
      ["png truncado", PNG.slice(0, 7)],
      ["png sem CRLF", bytes([0x89], "PNG", [0, 0, 0, 0])],
      ["jpeg truncado", JPEG.slice(0, 2)],
      ["webp truncado", WEBP.slice(0, 11)],
      ["ftyp truncado", AVIF.slice(0, 15)],
      ["zeros", new Uint8Array(64)],
    ];
    for (const [name, b] of bad) expect(detectImageType(b), name).toBeNull();
  });

  it("não lê além do buffer com tamanho de caixa ftyp absurdo/negativo", async () => {
    const { detectImageType } = await import("../../src/modules/menu/image-bytes");
    expect(detectImageType(bytes([0xff, 0xff, 0xff, 0xff], "ftyp", "mif1", [0, 0, 0, 0], "mif1", "heic"))).toBeNull();
    expect(detectImageType(bytes([0x7f, 0xff, 0xff, 0xff], "ftyp", "mif1", [0, 0, 0, 0], "mif1", "avif"))).toBe("image/avif");
  });

  it("expectedTypeFromPath/bytesMatchPath: extensão (só minúscula) promete o tipo; bytes divergentes ou extensão desconhecida => false", async () => {
    const { expectedTypeFromPath, bytesMatchPath, SNIFF_BYTES } = await import("../../src/modules/menu/image-bytes");
    expect(expectedTypeFromPath("restaurants/x/products/a.png")).toBe("image/png");
    expect(expectedTypeFromPath("a.jpg")).toBe("image/jpeg");
    expect(expectedTypeFromPath("a.webp")).toBe("image/webp");
    expect(expectedTypeFromPath("a.avif")).toBe("image/avif");
    for (const p of ["a.JPG", "a.jpeg", "a.gif", "a.svg", "a", "a.constructor", "a.png.exe", "", "a.__proto__"]) expect(expectedTypeFromPath(p), p).toBeNull();
    expect(bytesMatchPath(PNG, "p/a.png")).toBe(true);
    expect(bytesMatchPath(JPEG, "p/a.png")).toBe(false);
    expect(bytesMatchPath(bytes("<html>"), "p/a.png")).toBe(false);
    expect(bytesMatchPath(PNG, "p/a.gif")).toBe(false);
    expect(bytesMatchPath(PNG, "p/a.PNG")).toBe(false);
    expect(SNIFF_BYTES).toBeGreaterThanOrEqual(32);
  });
});

describe("validation/text.ts (F-29/F-30)", () => {
  it("hasControlChars: NUL e controles recusados; tab, \\n e \\r permitidos; acentos/emoji/CJK ok", async () => {
    const { hasControlChars } = await import("../../src/lib/validation/text");
    for (const c of ["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u000e", "\u001f", "\u007f"]) expect(hasControlChars(`a${c}b`), JSON.stringify(c)).toBe(true);
    for (const ok of ["", "a\tb", "a\nb", "a\r\nb", "ação — é ñ", "😀 pizza", "日本語", "\u0080", " "]) expect(hasControlChars(ok), JSON.stringify(ok)).toBe(false);
  });

  it("findControlCharPath: acha o caminho em objetos/arrays aninhados e em chaves, ignora não-strings e para na profundidade", async () => {
    const { findControlCharPath } = await import("../../src/lib/validation/text");
    expect(findControlCharPath({ a: "ok", b: { c: ["x", "y\u0000"] } })).toEqual(["b", "c", 1]);
    expect(findControlCharPath({ notes: "oi\u0000" })).toEqual(["notes"]);
    expect(findControlCharPath({ "k\u0000": 1 })).toEqual(["k\u0000"]);
    expect(findControlCharPath("a\u0000")).toEqual([]);
    expect(findControlCharPath({ a: 1, b: null, c: true, d: undefined, e: ["ok"] })).toBeNull();
    let deep: any = "x\u0000";
    for (let i = 0; i < 12; i++) deep = { n: deep };
    expect(findControlCharPath(deep)).toBeNull();
    expect(findControlCharPath(null)).toBeNull();
    const { CONTROL_CHARS_MESSAGE } = await import("../../src/lib/validation/text");
    expect(CONTROL_CHARS_MESSAGE).toMatch(/inválidos/);
  });
});

describe("plan/status.ts: parse e banners", () => {
  const base = { state: "active", blocked: false, plan_code: "basico", plan_name: "Básico", trial_ends_at: null, current_period_end: null, grace_ends_at: null, days_left: null, limits: {}, usage: { members: 1, tables: 2, products: 3 } };
  const load = () => import("../../src/modules/plan/status");

  it("parseSubscriptionStatus: aceita objeto ou array de 1; campos ruins caem em valores seguros; não-objeto => null", async () => {
    const { parseSubscriptionStatus } = await load();
    for (const bad of [null, "x", 42, []]) expect(parseSubscriptionStatus(bad)).toBeNull();
    const s = parseSubscriptionStatus([base])!;
    expect(s).toMatchObject({ state: "active", blocked: false, planName: "Básico", daysLeft: null });
    expect(s.usage.map((u) => [u.key, u.used, u.limit, u.reached])).toEqual([["members", 1, null, false], ["tables", 2, null, false], ["products", 3, null, false]]);
    const weird = parseSubscriptionStatus({ state: "xpto", blocked: "sim", days_left: -3, limits: "x", usage: { members: "a" } })!;
    expect(weird).toMatchObject({ state: "none", blocked: false, daysLeft: null });
    expect(weird.usage.every((u) => u.used === 0 && u.limit === null)).toBe(true);
  });

  it("limites: max_products tem precedência sobre max_menu_items; texto/negativo/nulo = ilimitado; 0 é limite (atingido)", async () => {
    const { parseSubscriptionStatus } = await load();
    const p = (limits: Record<string, unknown>, usage = { members: 5, tables: 5, products: 5 }) => parseSubscriptionStatus({ ...base, limits, usage })!.usage;
    expect(p({ max_products: 10, max_menu_items: 5 })[2]).toMatchObject({ limit: 10, reached: false });
    expect(p({ max_menu_items: 5 })[2]).toMatchObject({ limit: 5, reached: true });
    expect(p({ max_products: "abc", max_menu_items: 5 })[2]).toMatchObject({ limit: 5 });
    expect(p({ max_members: -1 })[0].limit).toBeNull();
    expect(p({ max_tables: null })[1].limit).toBeNull();
    expect(p({ max_tables: 0 }, { members: 0, tables: 0, products: 0 })[1]).toMatchObject({ limit: 0, reached: true });
    expect(p({ max_members: 7.9 })[0].limit).toBe(7);
    expect(p(JSON.parse('{"constructor":1,"__proto__":1}')).every((u) => u.limit === null)).toBe(true);
  });

  it("planBanners: null/active/none sem banner; trial com mais de 7 dias sem banner; 7..1 dias avisa (singular/plural); 0 = termina hoje", async () => {
    const { parseSubscriptionStatus, planBanners } = await load();
    const mk = (over: Record<string, unknown>) => parseSubscriptionStatus({ ...base, ...over });
    expect(planBanners(null)).toEqual([]);
    expect(planBanners(mk({}))).toEqual([]);
    expect(planBanners(mk({ state: "none" }))).toEqual([]);
    expect(planBanners(mk({ state: "trial", days_left: 8 }))).toEqual([]);
    expect(planBanners(mk({ state: "trial", days_left: null }))).toEqual([]);
    const t7 = planBanners(mk({ state: "trial", days_left: 7 }));
    expect(t7).toHaveLength(1);
    expect(t7[0]).toMatchObject({ tone: "warning", title: "Seu período de teste está acabando" });
    expect(t7[0].message).toContain("Restam 7 dias");
    expect(planBanners(mk({ state: "trial", days_left: 1 }))[0].message).toContain("Restam 1 dia de teste");
    expect(planBanners(mk({ state: "trial", days_left: 0 }))[0].title).toBe("Seu período de teste termina hoje");
  });

  it("planBanners: vencida/cancelada (danger, pedidos bloqueados, consulta continua); past_due dentro da tolerância (warning) e fora (danger)", async () => {
    const { parseSubscriptionStatus, planBanners } = await load();
    const mk = (over: Record<string, unknown>) => parseSubscriptionStatus({ ...base, ...over });
    const exp = planBanners(mk({ state: "expired", blocked: true }))[0];
    expect(exp).toMatchObject({ tone: "danger", title: "Assinatura vencida" });
    expect(exp.message).toMatch(/bloqueados/);
    expect(exp.message).toMatch(/relatórios/);
    expect(planBanners(mk({ state: "cancelled", blocked: true }))[0]).toMatchObject({ tone: "danger", title: "Assinatura cancelada" });
    expect(planBanners(mk({ state: "past_due", blocked: false }))[0]).toMatchObject({ tone: "warning", title: "Pagamento em atraso" });
    expect(planBanners(mk({ state: "past_due", blocked: true }))[0]).toMatchObject({ tone: "danger", title: "Pagamento em atraso: pedidos bloqueados" });
  });

  it("planBanners: limite atingido soma um banner informativo no fim; STATE_LABELS cobre todos os estados", async () => {
    const { parseSubscriptionStatus, planBanners, STATE_LABELS, SUBSCRIPTION_STATES } = await load();
    const s = parseSubscriptionStatus({ ...base, state: "expired", blocked: true, limits: { max_members: 1, max_tables: 2 }, usage: { members: 1, tables: 2, products: 9 } });
    const banners = planBanners(s);
    expect(banners.map((b) => b.tone)).toEqual(["danger", "info"]);
    expect(banners[1].message).toContain("Integrantes da equipe (1 de 1)");
    expect(banners[1].message).toContain("Mesas (2 de 2)");
    expect(banners[1].message).not.toContain("Produtos");
    expect(Object.keys(STATE_LABELS).sort()).toEqual([...SUBSCRIPTION_STATES].sort());
  });
});

describe("auth/mfa.ts: isPlatformMfaRequired", () => {
  it("true/1 liga; false/0 desliga (qualquer caixa/espaço); ausente => só em produção; lixo => segue o padrão", async () => {
    const { isPlatformMfaRequired } = await import("../../src/lib/auth/mfa");
    for (const v of ["true", "TRUE", " 1 ", "True"]) expect(isPlatformMfaRequired({ PLATFORM_REQUIRE_MFA: v, NODE_ENV: "development" }), v).toBe(true);
    for (const v of ["false", "FALSE", " 0 ", "False"]) expect(isPlatformMfaRequired({ PLATFORM_REQUIRE_MFA: v, NODE_ENV: "production" }), v).toBe(false);
    expect(isPlatformMfaRequired({ NODE_ENV: "production" })).toBe(true);
    expect(isPlatformMfaRequired({ NODE_ENV: "development" })).toBe(false);
    expect(isPlatformMfaRequired({ NODE_ENV: "test" })).toBe(false);
    expect(isPlatformMfaRequired({})).toBe(false);
    expect(isPlatformMfaRequired({ PLATFORM_REQUIRE_MFA: "talvez", NODE_ENV: "production" })).toBe(true);
    expect(isPlatformMfaRequired({ PLATFORM_REQUIRE_MFA: "", NODE_ENV: "development" })).toBe(false);
  });
});

describe("team/invite-email.ts", () => {
  const mockEnv = (siteUrl: string | null, ok = true) =>
    vi.doMock("@/lib/env", () => ({ getPublicEnvStatus: () => (ok ? { ok: true, env: { siteUrl } } : { ok: false, invalid: ["X"] }) }));

  it("sucesso => 'dispatched'; redirectTo vem de NEXT_PUBLIC_SITE_URL (sem barra final), nunca de cabeçalho", async () => {
    mockEnv("https://app.example.test/");
    inviteUserByEmail.mockReset().mockResolvedValue({ error: null });
    const { sendInviteEmail } = await import("../../src/modules/team/invite-email");
    expect(await sendInviteEmail("pessoa@example.test")).toBe("dispatched");
    expect(inviteUserByEmail).toHaveBeenCalledWith("pessoa@example.test", { redirectTo: "https://app.example.test/auth/callback?next=/redefinir-senha" });
  });

  it("sem site URL ou ambiente inválido: chama sem redirectTo e não quebra", async () => {
    mockEnv(null);
    inviteUserByEmail.mockReset().mockResolvedValue({ error: null });
    let mod = await import("../../src/modules/team/invite-email");
    expect(await mod.sendInviteEmail("a@example.test")).toBe("dispatched");
    expect(inviteUserByEmail).toHaveBeenLastCalledWith("a@example.test", { redirectTo: undefined });
    vi.resetModules();
    mockEnv(null, false);
    mod = await import("../../src/modules/team/invite-email");
    expect(await mod.sendInviteEmail("a@example.test")).toBe("dispatched");
  });

  it("sem enumeração: conta já existente (email_exists ou 422) devolve o MESMO 'dispatched' e não registra erro", async () => {
    mockEnv("https://app.example.test");
    const { sendInviteEmail } = await import("../../src/modules/team/invite-email");
    inviteUserByEmail.mockReset().mockResolvedValue({ error: { code: "email_exists", status: 422, message: "x" } });
    expect(await sendInviteEmail("existe@example.test")).toBe("dispatched");
    inviteUserByEmail.mockResolvedValue({ error: { status: 422, message: "x" } });
    expect(await sendInviteEmail("existe2@example.test")).toBe("dispatched");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("falha de SMTP/serviço é tolerada: 'failed' sem lançar e sem vazar o e-mail nem a mensagem no log; exceção também", async () => {
    mockEnv("https://app.example.test");
    const { sendInviteEmail } = await import("../../src/modules/team/invite-email");
    inviteUserByEmail.mockReset().mockResolvedValue({ error: { code: "unexpected_failure", status: 500, message: "SMTP 535 senha@smtp" } });
    expect(await sendInviteEmail("pessoa@example.test")).toBe("failed");
    inviteUserByEmail.mockRejectedValue(new Error("ECONNREFUSED pessoa@example.test"));
    expect(await sendInviteEmail("pessoa@example.test")).toBe("failed");
    const logged = JSON.stringify((console.error as any).mock.calls);
    expect(logged).not.toContain("pessoa@example.test");
    expect(logged).not.toContain("senha@smtp");
  });
});

describe("mensagens PT-BR de SUBSCRIPTION_INACTIVE / PLAN_LIMIT_REACHED / RATE_LIMITED", () => {
  it("lib/errors: mapa + planErrorMessage (prioridade sobre SQLSTATE, não vaza texto cru do banco)", async () => {
    const { RPC_ERROR_MESSAGES, planErrorMessage, rpcErrorMessage } = await import("../../src/lib/errors");
    for (const code of ["SUBSCRIPTION_INACTIVE", "PLAN_LIMIT_REACHED", "RATE_LIMITED"] as const) {
      expect(RPC_ERROR_MESSAGES[code]).toMatch(/[a-zç]{4,}/i);
      expect(planErrorMessage({ message: `${code}: detalhe interno (5 de 5: tables)` })).toBe(RPC_ERROR_MESSAGES[code]);
      expect(rpcErrorMessage({ message: `ERROR: ${code}: x` })).toBe(RPC_ERROR_MESSAGES[code]);
    }
    expect(planErrorMessage({ message: "PLAN_LIMIT_REACHED: limite do plano atingido (5 de 5: tables)" })).not.toMatch(/5 de 5/);
    expect(planErrorMessage({ message: "FORBIDDEN: x" })).toBeNull();
    expect(planErrorMessage(null)).toBeNull();
    expect(planErrorMessage({})).toBeNull();
    expect(RPC_ERROR_MESSAGES.PLAN_LIMIT_REACHED).toMatch(/plano/i);
    expect(RPC_ERROR_MESSAGES.SUBSCRIPTION_INACTIVE).toMatch(/assinatura/i);
  });

  it("vitrine (orders-server/messages): SUBSCRIPTION_INACTIVE e RATE_LIMITED têm texto próprio e amigável; desconhecido/herdado cai no genérico", async () => {
    const { orderErrorMessage, ORDER_ERROR_MESSAGES } = await import("../../src/modules/orders-server/messages");
    expect(orderErrorMessage("SUBSCRIPTION_INACTIVE")).toBe(ORDER_ERROR_MESSAGES.SUBSCRIPTION_INACTIVE);
    expect(orderErrorMessage("SUBSCRIPTION_INACTIVE")).toMatch(/indispon[ií]vel/i);
    expect(orderErrorMessage("RATE_LIMITED")).toMatch(/Muitos pedidos/);
    expect(orderErrorMessage("RATE_LIMITED")).not.toBe(orderErrorMessage("CODIGO_QUE_NAO_EXISTE"));
    for (const proto of ["constructor", "toString", "__proto__"]) expect(typeof orderErrorMessage(proto)).toBe("string");
  });

  it("comanda/mesas/pagamento: os parsers mapeiam os três códigos sem vazar o texto cru do banco", async () => {
    const { parseBillingError } = await import("../../src/modules/tab-billing/errors");
    const { parseTabsError } = await import("../../src/modules/tables/errors");
    const raw = (c: string) => ({ message: `${c}: texto interno do banco`, code: "P0001" });
    for (const c of ["SUBSCRIPTION_INACTIVE", "RATE_LIMITED"]) {
      expect(parseBillingError(raw(c)).message, c).toMatch(/assinatura|Muitas tentativas/);
      expect(parseTabsError(raw(c)).message, c).toMatch(/assinatura|Muitas tentativas/);
      expect(parseBillingError(raw(c)).message).not.toContain("texto interno");
    }
    expect(parseTabsError(raw("PLAN_LIMIT_REACHED")).message).toMatch(/limite do plano/i);
    expect(parseTabsError(raw("PLAN_LIMIT_REACHED")).message).not.toContain("texto interno");
  });
});
