import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RestaurantHero } from "../../src/components/storefront/restaurant-hero";
import { formatAddress, formatCep } from "../../src/modules/operations/format";
import { parsePublicMenu } from "../../src/modules/storefront/schemas";

describe("CEP no endereço de entrega", () => {
  it("formata 8 dígitos com hífen e não mexe no que já está formatado ou é inválido", () => {
    expect(formatCep("62755000")).toBe("62755-000");
    expect(formatCep("62755-000")).toBe("62755-000");
    expect(formatCep("123")).toBe("123");
  });
  it("aparece formatado no endereço do pedido e do papel", () => {
    const lines = formatAddress({ street: "R. Maria Joaquina", number: "120", neighborhood: "Centro", city: "Ocara", postal_code: "62755000" } as never);
    expect(lines).toContain("CEP 62755-000");
  });
});

const menu = (notice: string | null) =>
  parsePublicMenu({
    restaurant: { id: "r", name: "Qi Buxo", slug: "qibuxo", logo_path: null, timezone: "America/Fortaleza", notice },
    settings: { accepts_orders: true, prep_time_minutes: 30, min_order_cents: 0, enabled_fulfillment_types: ["PICKUP"], delivery_zones: [] },
    is_open_now: true,
    categories: [],
  })!;

describe("aviso fixo na vitrine do Mesa Fácil", () => {
  it("o aviso escrito pelo restaurante aparece no topo da vitrine", () => {
    const out = renderToStaticMarkup(createElement(RestaurantHero, { menu: menu("Hoje fechamos às 16h") }));
    expect(out).toContain("Hoje fechamos às 16h");
  });
  it("sem aviso (ou só espaços), nada é mostrado", () => {
    expect(menu(null)!.restaurant.notice).toBeNull();
    expect(menu("   ")!.restaurant.notice).toBeNull();
    expect(renderToStaticMarkup(createElement(RestaurantHero, { menu: menu(null) }))).not.toContain("fechamos");
  });
});
