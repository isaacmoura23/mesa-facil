import { describe, expect, it } from "vitest";
import { buildAppNav, buildOperacaoNav } from "@/config/navigation";
import { NAV_BADGE_STATUS, badgeDescription, formatBadgeCount } from "@/modules/operations/nav-badges";
import type { Permission } from "@/lib/auth/types";

const can =
  (...granted: Permission[]) =>
  (wanted: readonly Permission[]) =>
    wanted.some((p) => granted.includes(p));

const badgeOf = (nav: ReturnType<typeof buildOperacaoNav>, segment: string) =>
  nav.find((e) => e.href.endsWith(`/${segment}`))?.badge;

describe("formatBadgeCount", () => {
  it("some com zero, negativo ou inválido", () => {
    expect(formatBadgeCount(0)).toBeNull();
    expect(formatBadgeCount(-3)).toBeNull();
    expect(formatBadgeCount(undefined)).toBeNull();
    expect(formatBadgeCount(null)).toBeNull();
    expect(formatBadgeCount(Number.NaN)).toBeNull();
  });
  it("mostra o número até 99 e limita em 99+", () => {
    expect(formatBadgeCount(1)).toBe("1");
    expect(formatBadgeCount(99)).toBe("99");
    expect(formatBadgeCount(100)).toBe("99+");
    expect(formatBadgeCount(2500)).toBe("99+");
  });
});

describe("badgeDescription", () => {
  it("descreve no singular e no plural", () => {
    expect(badgeDescription("new_orders", 1)).toBe("1 pedido aguardando aceite");
    expect(badgeDescription("new_orders", 3)).toBe("3 pedidos aguardando aceite");
    expect(badgeDescription("kitchen_queue", 1)).toBe("1 pedido para preparar");
    expect(badgeDescription("kitchen_queue", 120)).toBe("99+ pedidos para preparar");
    expect(badgeDescription("kitchen_queue", 0)).toBe("");
  });
});

describe("estados contados", () => {
  it("Pedidos conta os aguardando aceite e Cozinha os aceitos para preparar", () => {
    expect(NAV_BADGE_STATUS.new_orders).toBe("RECEIVED");
    expect(NAV_BADGE_STATUS.kitchen_queue).toBe("CONFIRMED");
  });
});

describe("selos no menu da Operação, por permissão", () => {
  it("caixa (aceita e muda status) vê os dois selos", () => {
    const nav = buildOperacaoNav("qibuxo", can("orders.view", "orders.accept", "orders.update_status"));
    expect(badgeOf(nav, "pedidos")).toBe("new_orders");
    expect(badgeOf(nav, "cozinha")).toBe("kitchen_queue");
  });
  it("cozinha (só muda status) não vê o selo de aguardando aceite", () => {
    const nav = buildOperacaoNav("qibuxo", can("orders.view", "orders.update_status"));
    expect(badgeOf(nav, "pedidos")).toBeUndefined();
    expect(badgeOf(nav, "cozinha")).toBe("kitchen_queue");
  });
  it("garçom e dono (só leitura) não veem selos", () => {
    const waiter = buildOperacaoNav("qibuxo", can("orders.view", "tables.view", "tabs.view"));
    expect(waiter.every((e) => e.badge === undefined)).toBe(true);
    const app = buildAppNav("qibuxo", can("orders.view", "menu.manage"));
    expect(app.every((e) => e.badge === undefined)).toBe(true);
  });
});
