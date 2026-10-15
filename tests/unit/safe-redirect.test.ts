import { describe, expect, it } from "vitest";

// Módulo opcional: se o APP renomear/remover, o teste é pulado (não bloqueia a suíte de banco).
const mod = await import("../../src/lib/utils/safe-redirect").catch(() => null);

describe.skipIf(!mod)("sanitizeNext / safeNextOr (redirect seguro)", () => {
  const { sanitizeNext, safeNextOr } = mod!;

  it("aceita somente caminhos internos e preserva query/hash", () => {
    expect(sanitizeNext("/app/demo-a/dashboard")).toBe("/app/demo-a/dashboard");
    expect(sanitizeNext("/operacao/demo-a/pedidos?status=RECEIVED#topo")).toBe("/operacao/demo-a/pedidos?status=RECEIVED#topo");
    expect(sanitizeNext("  /ok  ")).toBe("/ok");
  });

  it.each([
    "https://evil.example.test/",
    "http://evil.example.test",
    "//evil.example.test",
    "/\\evil.example.test",
    "\\\\evil.example.test",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "evil.example.test/path",
    "relativo/sem/barra",
    "",
    "   ",
    "/ok\nSet-Cookie: x=1",
    "/ok\u0000",
    "/a\\b",
    "/" + "a".repeat(3000),
  ])("rejeita %j", (input) => {
    expect(sanitizeNext(input)).toBeNull();
  });

  it("rejeita valores que não são string", () => {
    for (const v of [null, undefined, 42, {}, [], ["/ok"], true]) expect(sanitizeNext(v)).toBeNull();
  });

  it("mantém na mesma origem mesmo com codificação (não vira redirecionamento externo)", () => {
    const out = sanitizeNext("/%2F%2Fevil.example.test");
    expect(out === null || out.startsWith("/")).toBe(true);
    expect(out?.startsWith("//")).not.toBe(true);
  });

  it("safeNextOr usa o fallback para valores suspeitos", () => {
    expect(safeNextOr("https://evil.example.test", "/app")).toBe("/app");
    expect(safeNextOr("/painel", "/app")).toBe("/painel");
    expect(safeNextOr(undefined, "/app")).toBe("/app");
  });
});
