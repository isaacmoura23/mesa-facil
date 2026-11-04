import { describe, expect, it } from "vitest";
import { buildAppNav } from "../../src/config/navigation";
import type { Permission } from "../../src/lib/auth/types";

const can = (...granted: string[]) => (list: readonly Permission[]) => list.some((p) => granted.includes(p));
const labels = (nav: { label: string }[]) => nav.map((e) => e.label);

describe("menu Gestão: Equipe", () => {
  it("dono (team.manage) vê Equipe", () => {
    expect(labels(buildAppNav("qibuxo", can("team.manage", "orders.view"), "owner"))).toContain("Equipe");
  });
  it("gerente vê Equipe mesmo sem team.manage (modo leitura)", () => {
    expect(labels(buildAppNav("qibuxo", can("orders.view", "menu.manage"), "manager"))).toContain("Equipe");
  });
  it("outros papéis e chamadas sem papel não veem Equipe", () => {
    for (const role of ["cashier", "kitchen", "waiter"] as const) {
      expect(labels(buildAppNav("qibuxo", can("orders.view", "reports.view"), role))).not.toContain("Equipe");
    }
    expect(labels(buildAppNav("qibuxo", can("orders.view")))).not.toContain("Equipe");
  });
});
