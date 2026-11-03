import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "../../src/components/brand-mark";

const html = (props: Parameters<typeof BrandMark>[0]) => renderToStaticMarkup(createElement(BrandMark, props));

describe("BrandMark: marca do restaurante nos painéis", () => {
  it("sem restaurante, mantém o nome e a logo do Mesa Fácil", () => {
    const out = html({ href: "/entrar" });
    expect(out).toContain("Mesa Fácil");
    expect(out).toContain("logo-small.png");
  });

  it("com restaurante e logo, mostra o nome e a logo cadastrados (e não os do Mesa Fácil)", () => {
    const out = html({
      href: "/entrar",
      restaurant: { name: "Qi Buxo", logoUrl: "https://x.supabase.co/storage/v1/object/public/restaurant-public/restaurants/1/logo/a.png" },
    });
    expect(out).toContain("Qi Buxo");
    expect(out).toContain("restaurant-public");
    expect(out).not.toContain("Mesa Fácil");
    expect(out).not.toContain("logo-small.png");
  });

  it("com restaurante sem logo, mostra a inicial do nome", () => {
    const out = html({ href: "/entrar", restaurant: { name: "la pastelaria", logoUrl: null } });
    expect(out).toContain("la pastelaria");
    expect(out).toContain(">L<");
    expect(out).not.toContain("Mesa Fácil");
  });

  it("recolhido, o nome fica só no rótulo de acessibilidade", () => {
    const out = html({ href: "/entrar", compact: true, restaurant: { name: "Qi Buxo", logoUrl: null } });
    expect(out).toContain('aria-label="Qi Buxo"');
    expect(out).not.toContain(">Qi Buxo<");
  });
});
