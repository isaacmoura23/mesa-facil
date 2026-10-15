import { describe, expect, it } from "vitest";

const mod = await import("../../src/lib/auth/permissions").catch(() => null);

describe.skipIf(!mod)("regras de entrada por ambiente (src/lib/auth/permissions)", () => {
  const { canEnterArea, homePathFor, areaHomePath, hasAny, OPERATIONAL_PERMISSIONS, ADMIN_PERMISSIONS } = mod!;
  const none = new Set<string>();

  it("owner entra em /app e NUNCA em /operacao (monitoramento é dentro de /app)", () => {
    const ownerPerms = new Set(["orders.view", "menu.manage", "tables.view", "team.manage"]);
    expect(canEnterArea("app", "owner", ownerPerms)).toBe(true);
    expect(canEnterArea("operacao", "owner", ownerPerms)).toBe(false);
    // nem com uma permissão operacional espúria
    expect(canEnterArea("operacao", "owner", new Set(["orders.accept", "orders.view"]))).toBe(false);
  });

  it("manager entra nos dois ambientes", () => {
    const perms = new Set(["orders.view", "orders.accept", "menu.manage"]);
    expect(canEnterArea("app", "manager", perms)).toBe(true);
    expect(canEnterArea("operacao", "manager", perms)).toBe(true);
  });

  it("cozinha/caixa/garçom entram em /operacao, mas /app só com permissão administrativa", () => {
    for (const role of ["kitchen", "cashier", "waiter"] as const) {
      const perms = new Set(["orders.view"]);
      expect(canEnterArea("operacao", role, perms)).toBe(true);
      expect(canEnterArea("app", role, perms)).toBe(false);
    }
    expect(canEnterArea("app", "waiter", new Set(["orders.view", "menu.manage"]))).toBe(true);
    expect(canEnterArea("app", "cashier", new Set(["orders.view", "reports.view"]))).toBe(true);
  });

  it("sem nenhuma permissão, cozinha/caixa/garçom não entram em lugar algum", () => {
    for (const role of ["cashier", "kitchen", "waiter"] as const) {
      expect(canEnterArea("app", role, none)).toBe(false);
      expect(canEnterArea("operacao", role, none)).toBe(false);
    }
  });

  it("homePathFor e areaHomePath codificam o slug e escolhem o destino por papel", () => {
    expect(homePathFor("demo-a", "owner")).toBe("/app/demo-a/dashboard");
    expect(homePathFor("demo-a", "manager")).toBe("/app/demo-a/dashboard");
    expect(homePathFor("demo-a", "kitchen")).toBe("/operacao/demo-a/pedidos");
    expect(homePathFor("a/b?c", "waiter")).toBe("/operacao/a%2Fb%3Fc/pedidos");
    expect(areaHomePath("x y", "app")).toBe("/app/x%20y/dashboard");
  });

  it("hasAny", () => {
    expect(hasAny(new Set(["a"]), ["b", "a"])).toBe(true);
    expect(hasAny(new Set<string>(), ["a"])).toBe(false);
    expect(hasAny(new Set(["a"]), [])).toBe(false);
  });

  it("as permissões operacionais do app são exatamente as 9 do contrato e não se misturam com as administrativas", () => {
    expect([...OPERATIONAL_PERMISSIONS].sort()).toEqual(
      ["orders.accept", "orders.cancel", "orders.create", "orders.reject", "orders.update_status", "payments.record", "print.request", "tables.operate", "tabs.manage"].sort(),
    );
    for (const p of ADMIN_PERMISSIONS) expect((OPERATIONAL_PERMISSIONS as readonly string[]).includes(p)).toBe(false);
  });
});
